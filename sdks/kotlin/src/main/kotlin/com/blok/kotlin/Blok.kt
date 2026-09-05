package com.blok.kotlin

import com.blok.runtime.v1.ErrorCategory
import com.blok.runtime.v1.ErrorSeverity
import com.blok.runtime.v1.ExecuteRequest
import com.blok.runtime.v1.ExecuteResponse
import com.blok.runtime.v1.HealthResponse
import com.blok.runtime.v1.ListNodesResponse
import com.blok.runtime.v1.Metrics
import com.blok.runtime.v1.NodeDescriptor
import com.blok.runtime.v1.NodeError
import com.blok.runtime.v1.NodeRuntimeGrpcKt
import com.blok.runtime.v1.NodeStarted
import com.blok.runtime.v1.ExecuteEvent
import com.blok.runtime.v1.RuntimeState
import com.google.protobuf.ByteString
import com.google.protobuf.Timestamp
import io.grpc.Status
import io.grpc.netty.shaded.io.grpc.netty.NettyServerBuilder
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.SerialKind
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ExecutorService
import kotlin.coroutines.CoroutineContext
import kotlin.time.Duration.Companion.milliseconds

/** A structured node error that is losslessly mapped to runtime.proto NodeError. */
class BlokError(
    val code: String,
    val category: ErrorCategory = ErrorCategory.INTERNAL,
    val severity: ErrorSeverity = ErrorSeverity.ERROR,
    override val message: String,
    val description: String = "",
    val remediation: String = "",
    val httpStatus: Int = 500,
    val retryable: Boolean = false,
    val retryAfterMs: Long = 0,
    val details: JsonElement? = null,
    val causes: List<BlokError> = emptyList(),
) : Exception(message) {
    companion object {
        fun validation(code: String = "NODE_INPUT_VALIDATION", message: String): BlokError = BlokError(
            code = code,
            category = ErrorCategory.VALIDATION,
            message = message,
            httpStatus = 400,
        )

        fun cancelled(message: String = "Node execution was cancelled"): BlokError = BlokError(
            code = "NODE_CANCELLED",
            category = ErrorCategory.CANCELLED,
            message = message,
            httpStatus = 499,
        )

        fun timeout(message: String = "Node execution exceeded its deadline"): BlokError = BlokError(
            code = "NODE_DEADLINE_EXCEEDED",
            category = ErrorCategory.TIMEOUT,
            message = message,
            httpStatus = 504,
            retryable = true,
        )
    }
}

@Serializable
data class CapabilityResourceBounds(
    val maxDurationMs: Long? = null,
    val maxMemoryBytes: Long? = null,
    val maxInputBytes: Long? = null,
    val maxOutputBytes: Long? = null,
    val maxConcurrency: Long? = null,
)

@Serializable
data class CapabilityManifest(
    val version: String,
    val classification: String,
    val effects: List<String> = emptyList(),
    val capabilities: List<String> = emptyList(),
    val secrets: List<String> = emptyList(),
    val determinism: String,
    val idempotency: String,
    val maturity: String,
    val resources: CapabilityResourceBounds? = null,
    val runtimes: List<String>? = null,
    val triggers: List<String>? = null,
)

data class RequestContext(
    val body: JsonElement? = null,
    val headers: Map<String, String> = emptyMap(),
    val params: Map<String, String> = emptyMap(),
    val query: Map<String, String> = emptyMap(),
    val cookies: Map<String, String> = emptyMap(),
    val method: String = "",
    val url: String = "",
    val baseUrl: String = "",
    val triggerKind: String = "",
)

class NodeLogger(private val sink: ((String, String, Map<String, String>) -> Unit)? = null) {
    fun debug(message: String, attributes: Map<String, String> = emptyMap()) = emit("debug", message, attributes)
    fun info(message: String, attributes: Map<String, String> = emptyMap()) = emit("info", message, attributes)
    fun warn(message: String, attributes: Map<String, String> = emptyMap()) = emit("warn", message, attributes)
    fun error(message: String, attributes: Map<String, String> = emptyMap()) = emit("error", message, attributes)
    private fun emit(level: String, message: String, attributes: Map<String, String>) {
        sink?.invoke(level, message, attributes)
    }
}

/** Read-only request/state plus cooperative cancellation for a node invocation. */
class NodeContext(
    val request: RequestContext,
    val previousOutput: JsonElement?,
    initialVars: Map<String, JsonElement>,
    val env: Map<String, String>,
    val logger: NodeLogger,
) {
    private val vars = ConcurrentHashMap(initialVars)

    fun getVar(name: String): JsonElement? = vars[name]
    fun setVar(name: String, value: JsonElement) { vars[name] = value }
    fun varsDelta(): Map<String, JsonElement> = vars.toMap()
    suspend fun ensureActive() { currentCoroutineContext().ensureActive() }
}

/** Common node surface; implementations may be raw JSON or use TypedNode below. */
interface NodeHandler {
    val name: String
    val description: String get() = ""
    val tags: List<String> get() = emptyList()
    val capabilityManifest: CapabilityManifest? get() = null
    val inputSchemaJson: String? get() = null
    val outputSchemaJson: String? get() = null
    suspend fun execute(ctx: NodeContext, input: JsonObject): JsonElement
}

/** Coroutine-first typed node API; callers never subclass the Java SDK. */
abstract class TypedNode<I, O>(
    final override val name: String,
    final override val description: String = "",
    private val inputSerializer: KSerializer<I>,
    private val outputSerializer: KSerializer<O>,
    final override val tags: List<String> = emptyList(),
    final override val capabilityManifest: CapabilityManifest? = null,
) : NodeHandler {
    private val json = Json { encodeDefaults = true; ignoreUnknownKeys = false }
    final override val inputSchemaJson: String by lazy { JsonSchema.from(inputSerializer.descriptor).toString() }
    final override val outputSchemaJson: String by lazy { JsonSchema.from(outputSerializer.descriptor).toString() }

    protected abstract suspend fun run(ctx: NodeContext, input: I): O

    final override suspend fun execute(ctx: NodeContext, input: JsonObject): JsonElement {
        val typed = try {
            json.decodeFromJsonElement(inputSerializer, input)
        } catch (error: SerializationException) {
            throw BlokError.validation(message = "Input validation failed for node '$name': ${error.message ?: "invalid JSON"}")
        }
        return json.encodeToJsonElement(outputSerializer, run(ctx, typed))
    }
}

/** Small descriptor-based JSON Schema emitter. It intentionally never claims unsupported constraints. */
private object JsonSchema {
    fun from(descriptor: SerialDescriptor): JsonObject = schema(descriptor)

    private fun schema(descriptor: SerialDescriptor): JsonObject {
        val kind = descriptor.kind
        if (kind == SerialKind.CONTEXTUAL) return buildJsonObject { put("type", "object") }
        if (kind is kotlinx.serialization.descriptors.PrimitiveKind) {
            val type = when (kind) {
                kotlinx.serialization.descriptors.PrimitiveKind.BOOLEAN -> "boolean"
                kotlinx.serialization.descriptors.PrimitiveKind.BYTE,
                kotlinx.serialization.descriptors.PrimitiveKind.SHORT,
                kotlinx.serialization.descriptors.PrimitiveKind.INT,
                kotlinx.serialization.descriptors.PrimitiveKind.LONG -> "integer"
                kotlinx.serialization.descriptors.PrimitiveKind.FLOAT,
                kotlinx.serialization.descriptors.PrimitiveKind.DOUBLE -> "number"
                kotlinx.serialization.descriptors.PrimitiveKind.CHAR,
                kotlinx.serialization.descriptors.PrimitiveKind.STRING -> "string"
            }
            return buildJsonObject { put("type", type) }
        }
        if (kind == SerialKind.ENUM) {
            return buildJsonObject {
                put("type", "string")
                put("enum", JsonArray((0 until descriptor.elementsCount).map { JsonPrimitive(descriptor.getElementName(it)) }))
            }
        }
        if (kind == SerialKind.LIST) {
            val child = if (descriptor.elementsCount > 0) descriptor.getElementDescriptor(0) else null
            return buildJsonObject {
                put("type", "array")
                if (child != null) put("items", schema(child))
            }
        }
        return buildJsonObject {
            put("type", "object")
            val properties = buildJsonObject {
                for (index in 0 until descriptor.elementsCount) {
                    put(descriptor.getElementName(index), schema(descriptor.getElementDescriptor(index)))
                }
            }
            put("properties", properties)
            val required = (0 until descriptor.elementsCount)
                .filterNot { descriptor.isElementOptional(it) }
                .map { JsonPrimitive(descriptor.getElementName(it)) }
            if (required.isNotEmpty()) put("required", JsonArray(required))
        }
    }
}

class NodeRegistry {
    private val nodes = ConcurrentHashMap<String, NodeHandler>()
    fun register(handler: NodeHandler) {
        require(handler.name.isNotBlank()) { "node name must not be blank" }
        check(nodes.putIfAbsent(handler.name, handler) == null) { "node '${handler.name}' is already registered" }
    }
    fun get(name: String): NodeHandler? = nodes[name]
    fun names(): List<String> = nodes.keys.sorted()

    suspend fun execute(name: String, input: JsonObject, ctx: NodeContext): JsonElement {
        val handler = get(name) ?: throw BlokError(
            code = "NODE_NOT_FOUND", category = ErrorCategory.NOT_FOUND,
            message = "node '$name' not found", httpStatus = 404,
        )
        return handler.execute(ctx, input)
    }
}

@Serializable data class TypedGreetInput(val name: String, val repeat: Int = 1)
@Serializable data class TypedGreetOutput(val greeting: String, val length: Int)

class TypedGreetNode : TypedNode<TypedGreetInput, TypedGreetOutput>(
    name = "typed-greet",
    description = "Typed greeting (Kotlin coroutine runtime contract demo)",
    inputSerializer = TypedGreetInput.serializer(),
    outputSerializer = TypedGreetOutput.serializer(),
    capabilityManifest = CapabilityManifest(
        version = "1", classification = "agent-compatible", determinism = "deterministic",
        idempotency = "idempotent", maturity = "stable",
        resources = CapabilityResourceBounds(maxDurationMs = 5000, maxInputBytes = 4194304, maxOutputBytes = 4194304, maxConcurrency = 64),
    ),
) {
    override suspend fun run(ctx: NodeContext, input: TypedGreetInput): TypedGreetOutput {
        ctx.ensureActive()
        val greeting = "Hello, ${input.name}".repeat(input.repeat.coerceAtLeast(1))
        return TypedGreetOutput(greeting, greeting.length)
    }
}

class HelloWorldNode : NodeHandler {
    override val name = "hello-world"
    override val description = "Returns a greeting from the Kotlin runtime."
    override suspend fun execute(ctx: NodeContext, input: JsonObject): JsonElement {
        ctx.ensureActive()
        val body = ctx.request.body as? JsonObject
        val name = body?.get("name")?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() } ?: "World"
        val prefix = input["prefix"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() } ?: "Hello"
        val message = "$prefix, $name!"
        ctx.setVar("greeting", JsonPrimitive(message))
        return buildJsonObject {
            put("message", message)
            put("timestamp", Instant.now().toString())
            put("language", "kotlin")
        }
    }
}

class ChainTestNode : NodeHandler {
    override val name = "chain-test"
    override val description = "Appends Kotlin to a cross-runtime chain."
    override suspend fun execute(ctx: NodeContext, input: JsonObject): JsonElement = buildJsonObject {
        put("origin", input["origin"] ?: JsonNull)
        val chain = input["chain"] as? JsonArray ?: JsonArray(emptyList())
        put("chain", JsonArray(chain + buildJsonObject { put("language", "kotlin"); put("order", chain.size + 1) }))
    }
}

class StandardDataNode : NodeHandler {
    override val name = "standard-data"
    override val description = "Echoes JSON data with the Kotlin runtime marker."
    override suspend fun execute(ctx: NodeContext, input: JsonObject): JsonElement = buildJsonObject {
        put("data", input["data"] ?: JsonNull)
        put("runtime", "kotlin")
    }
}

object UserNodeRegistry {
    /** Generated by blokctl in a project; the pristine SDK intentionally has no user nodes. */
    fun registerUserNodes(registry: NodeRegistry) = Unit
}

private const val BLOB_CAPABILITY = "blob-v1"
private val blobId = Regex("^[A-Za-z0-9_-][A-Za-z0-9._-]*/[A-Za-z0-9_-][A-Za-z0-9._-]*$")

private fun blobDir(): Path? = System.getenv("BLOK_BLOB_DIR")?.takeIf { it.isNotBlank() }?.let(Path::of)
private fun blobMaxBytes(): Long = System.getenv("BLOK_BLOB_MAX_BYTES")?.toLongOrNull()?.coerceAtLeast(1) ?: 256L * 1024 * 1024

private fun resolveBlob(input: JsonObject): JsonObject {
    if (input.size != 1) return input
    val ref = input["\$blokBlob"] as? JsonObject ?: return input
    val root = blobDir() ?: throw IllegalArgumentException("received a \$blokBlob claim-check ref but BLOK_BLOB_DIR is not set")
    val id = ref["id"]?.jsonPrimitive?.contentOrNull
        ?: throw IllegalArgumentException("invalid \$blokBlob id")
    require(blobId.matches(id)) { "invalid \$blokBlob id: $id" }
    val file = root.resolve(id).normalize()
    require(file.startsWith(root.normalize())) { "invalid \$blokBlob path" }
    val size = Files.size(file)
    require(size <= blobMaxBytes()) { "\$blokBlob payload exceeds BLOK_BLOB_MAX_BYTES" }
    val raw = Files.readAllBytes(file)
    val element = Json.parseToJsonElement(raw.toString(StandardCharsets.UTF_8))
    return element as? JsonObject ?: buildJsonObject { put("_value", element) }
}

private fun jsonObject(bytes: ByteString, field: String): JsonObject {
    if (bytes.isEmpty) return buildJsonObject { }
    return try {
        val element = Json.parseToJsonElement(bytes.toStringUtf8())
        element as? JsonObject ?: buildJsonObject { put("_value", element) }
    } catch (error: SerializationException) {
        throw Status.INVALID_ARGUMENT.withDescription("invalid `$field` JSON: ${error.message}").asRuntimeException()
    }
}

private fun jsonValue(bytes: ByteString): JsonElement? = if (bytes.isEmpty) null else Json.parseToJsonElement(bytes.toStringUtf8())

private fun requestBody(bytes: ByteString, headers: Map<String, String>): JsonElement? {
    if (bytes.isEmpty) return null
    val contentType = headers.entries.firstOrNull { it.key.equals("content-type", ignoreCase = true) }?.value.orEmpty()
    return if (contentType.contains("application/json", ignoreCase = true)) {
        runCatching { Json.parseToJsonElement(bytes.toStringUtf8()) }.getOrElse { JsonPrimitive(bytes.toStringUtf8()) }
    } else JsonPrimitive(bytes.toStringUtf8())
}

private fun timestamp(now: Instant = Instant.now()): Timestamp = Timestamp.newBuilder()
    .setSeconds(now.epochSecond).setNanos(now.nano).build()

private fun category(error: BlokError): ErrorCategory = error.category
private fun severity(error: BlokError): ErrorSeverity = error.severity

private fun errorProto(error: BlokError, node: String, version: String): NodeError = NodeError.newBuilder()
    .setCode(error.code).setCategory(category(error)).setSeverity(severity(error))
    .setNode(node).setSdk("blok-kotlin").setSdkVersion(version).setRuntimeKind("runtime.kotlin")
    .setAt(timestamp()).setMessage(error.message).setDescription(error.description)
    .setRemediation(error.remediation).setHttpStatus(error.httpStatus)
    .setRetryable(error.retryable).setRetryAfterMs(error.retryAfterMs)
    .setStack(error.stackTraceToString()).apply {
        error.details?.let { setDetailsJson(ByteString.copyFromUtf8(it.toString())) }
        error.causes.forEach { addCauses(errorProto(it, node, version)) }
    }.build()

class BlokNodeRuntimeService(
    private val registry: NodeRegistry,
    private val sdkVersion: String = "1.0.0",
    private val dispatcher: CoroutineDispatcher = Dispatchers.Default,
) : NodeRuntimeGrpcKt.NodeRuntimeCoroutineImplBase() {
    private val json = Json { encodeDefaults = true }

    override suspend fun execute(request: ExecuteRequest): ExecuteResponse {
        val nodeName = request.node.name
        return try {
            val maxMs = request.options.deadlineMs.takeIf { it > 0 } ?: 30_000L
            withContext(dispatcher) { withTimeout(maxMs) { executeWithinDeadline(request) } }
        } catch (error: kotlinx.coroutines.TimeoutCancellationException) {
            ExecuteResponse.newBuilder().setSuccess(false).setError(errorProto(BlokError.timeout(), nodeName, sdkVersion)).build()
        } catch (error: CancellationException) {
            throw error
        } catch (error: io.grpc.StatusRuntimeException) {
            throw error
        } catch (error: BlokError) {
            ExecuteResponse.newBuilder().setSuccess(false).setError(errorProto(error, nodeName, sdkVersion)).build()
        } catch (error: Throwable) {
            val wrapped = BlokError("KOTLIN_RUNTIME_INTERNAL", message = error.message ?: "Kotlin runtime failure")
            ExecuteResponse.newBuilder().setSuccess(false).setError(errorProto(wrapped, nodeName, sdkVersion)).build()
        }
    }

    private suspend fun executeWithinDeadline(request: ExecuteRequest): ExecuteResponse {
        require(request.hasNode() && request.node.name.isNotBlank()) { "ExecuteRequest.node is required" }
        val inputs = try {
            resolveBlob(jsonObject(request.inputs, "inputs"))
        } catch (error: IllegalArgumentException) {
            throw Status.INVALID_ARGUMENT.withDescription(error.message ?: "invalid claim-check reference").asRuntimeException()
        }
        val state: RuntimeState = request.state
        val trigger = request.trigger
        val workflow = request.workflow
        val inputVars = jsonObject(state.vars, "vars").mapValues { it.value }
        val context = NodeContext(
            request = RequestContext(
                body = requestBody(trigger.body, trigger.headersMap), headers = trigger.headersMap,
                params = trigger.paramsMap, query = trigger.queryMap, cookies = trigger.cookiesMap,
                method = trigger.method, url = trigger.url, baseUrl = trigger.baseUrl, triggerKind = trigger.triggerKind,
            ),
            previousOutput = jsonValue(state.previousOutput), initialVars = inputVars, env = state.envMap,
            logger = NodeLogger { _, _, _ -> },
        )
        val output = registry.execute(request.node.name, inputs, context)
        val data = ByteString.copyFromUtf8(output.toString())
        val vars = context.varsDelta()
        val varsBytes = if (vars.isNotEmpty()) ByteString.copyFromUtf8(JsonObject(vars).toString()) else ByteString.EMPTY
        val builder = ExecuteResponse.newBuilder().setSuccess(true).setData(data).setContentType("application/json")
        if (!varsBytes.isEmpty) builder.setVarsDelta(varsBytes)
        builder.setMetrics(Metrics.newBuilder().setResponseBytes(data.size().toLong() + varsBytes.size().toLong()).build())
        return builder.build()
    }

    override fun executeStream(request: ExecuteRequest): Flow<ExecuteEvent> = flow {
        emit(ExecuteEvent.newBuilder().setStarted(NodeStarted.newBuilder().setAt(timestamp()).build()).build())
        emit(ExecuteEvent.newBuilder().setFinal(execute(request)).build())
    }

    override suspend fun health(request: com.blok.runtime.v1.HealthRequest): com.blok.runtime.v1.HealthResponse =
        HealthResponse.newBuilder().setStatus(HealthResponse.Status.SERVING).setSdkVersion(sdkVersion)
            .addAllRegisteredNodes(registry.names()).build()

    override suspend fun listNodes(request: com.blok.runtime.v1.ListNodesRequest): ListNodesResponse =
        ListNodesResponse.newBuilder().setSdkName("blok-kotlin").setSdkVersion(sdkVersion).setProtoVersion("1.0.0")
            .addAllCapabilities(blobDir()?.takeIf { Files.isDirectory(it) && Files.isReadable(it) }?.let { listOf(BLOB_CAPABILITY) } ?: emptyList())
            .addAllNodes(registry.names().map { name ->
                val handler = registry.get(name)
                NodeDescriptor.newBuilder().setName(name).setDescription(handler?.description.orEmpty())
                    .addAllTags(handler?.tags.orEmpty())
                    .apply {
                        handler?.inputSchemaJson?.let { inputSchemaJson = ByteString.copyFromUtf8(it) }
                        handler?.outputSchemaJson?.let { outputSchemaJson = ByteString.copyFromUtf8(it) }
                        handler?.capabilityManifest?.let { capabilityManifestJson = ByteString.copyFromUtf8(Json.encodeToString(CapabilityManifest.serializer(), it)) }
                    }.build()
            }).build()
}

class RuntimeServer private constructor(
    private val host: String,
    private val port: Int,
    private val grpcPort: Int,
    private val version: String,
    private val maxMessageBytes: Int,
    private val dispatcherThreads: Int,
) {
    private val dispatcher = Executors.newFixedThreadPool(dispatcherThreads).asCoroutineDispatcher()
    private val registry = NodeRegistry()
    private var grpc: io.grpc.Server? = null
    private var health: com.sun.net.httpserver.HttpServer? = null
    private var healthExecutor: ExecutorService? = null

    init {
        registry.register(HelloWorldNode())
        registry.register(TypedGreetNode())
        registry.register(ChainTestNode())
        registry.register(StandardDataNode())
        UserNodeRegistry.registerUserNodes(registry)
    }

    fun start() {
        val service = BlokNodeRuntimeService(registry, version, dispatcher)
        val keepaliveTime = envLong("BLOK_GRPC_KEEPALIVE_TIME_MS", 10_000)
        val keepaliveTimeout = envLong("BLOK_GRPC_KEEPALIVE_TIMEOUT_MS", 5_000)
        grpc = NettyServerBuilder.forPort(grpcPort)
            .maxInboundMessageSize(maxMessageBytes).maxInboundMetadataSize(maxMessageBytes)
            .keepAliveTime(keepaliveTime, java.util.concurrent.TimeUnit.MILLISECONDS)
            .keepAliveTimeout(keepaliveTimeout, java.util.concurrent.TimeUnit.MILLISECONDS)
            .permitKeepAliveWithoutCalls(true).addService(service).build().start()
        health = com.sun.net.httpserver.HttpServer.create(java.net.InetSocketAddress(host, port), 0).also { server ->
            server.createContext("/health") { exchange ->
                if (exchange.requestMethod != "GET") {
                    exchange.sendResponseHeaders(405, -1)
                } else {
                    val body = "{\"status\":\"healthy\",\"sdk_version\":\"$version\",\"registered_nodes\":${Json.encodeToString(registry.names())}}"
                        .toByteArray(StandardCharsets.UTF_8)
                    exchange.responseHeaders.set("Content-Type", "application/json")
                    exchange.sendResponseHeaders(200, body.size.toLong())
                    exchange.responseBody.use { it.write(body) }
                }
                exchange.close()
            }
            healthExecutor = Executors.newFixedThreadPool(2)
            server.executor = healthExecutor
            server.start()
        }
        println("Blok Kotlin runtime ready: health=$host:$port grpc=$host:$grpcPort nodes=${registry.names().size}")
    }

    fun awaitTermination() { grpc?.awaitTermination() }
    fun stop() {
        health?.stop(0)
        healthExecutor?.shutdownNow()
        grpc?.shutdown()
        grpc?.awaitTermination(10, java.util.concurrent.TimeUnit.SECONDS)
        dispatcher.close()
    }

    companion object {
        fun fromEnv(): RuntimeServer = RuntimeServer(
            host = System.getenv("HOST")?.takeIf { it.isNotBlank() } ?: "0.0.0.0",
            port = envInt("PORT", 9008), grpcPort = envInt("GRPC_PORT", 10008),
            version = System.getenv("VERSION")?.takeIf { it.isNotBlank() } ?: "1.0.0",
            maxMessageBytes = envInt("BLOK_GRPC_MAX_MESSAGE_BYTES", 16 * 1024 * 1024),
            dispatcherThreads = envInt("BLOK_RUNTIME_DISPATCHER_THREADS", 4).coerceIn(1, 64),
        )
        private fun envInt(name: String, fallback: Int): Int = System.getenv(name)?.toIntOrNull()?.takeIf { it > 0 } ?: fallback
        private fun envLong(name: String, fallback: Long): Long = System.getenv(name)?.toLongOrNull()?.takeIf { it > 0 } ?: fallback
    }
}
