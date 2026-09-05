package com.blok.kotlin

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.Serializable
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.jsonObject

class BlokTest {
    @Serializable data class Input(val value: String)
    @Serializable data class Output(val upper: String)

    private class UpperNode : TypedNode<Input, Output>(
        name = "upper",
        description = "Uppercases text",
        inputSerializer = Input.serializer(),
        outputSerializer = Output.serializer(),
    ) {
        override suspend fun run(ctx: NodeContext, input: Input) = Output(input.value.uppercase())
    }

    @Test
    fun typedNodeValidatesAndReflectsSchemas() = runBlocking {
        val node = UpperNode()
        val ctx = NodeContext(RequestContext(), null, emptyMap(), emptyMap(), NodeLogger())
		assertEquals("ABC", node.execute(ctx, buildJsonObject { put("value", "abc") }).jsonObject["upper"]?.toString()?.trim('"'))
        assertTrue(node.inputSchemaJson?.contains("value") == true)
        assertTrue(node.outputSchemaJson?.contains("upper") == true)
        assertFailsWith<BlokError> { node.execute(ctx, buildJsonObject { put("value", 3) }) }
    }

    @Test
    fun registryRejectsDuplicateNames() {
        val registry = NodeRegistry()
        registry.register(UpperNode())
        assertFailsWith<IllegalStateException> { registry.register(UpperNode()) }
    }

	@Test
	fun chainNodeAppendsKotlin() = runBlocking {
        val node = ChainTestNode()
        val ctx = NodeContext(RequestContext(), null, emptyMap(), emptyMap(), NodeLogger())
        val output = node.execute(ctx, buildJsonObject { put("origin", "test") })
		assertEquals(true, output.jsonObject["chain"]?.toString()?.contains("kotlin"))
	}

	@Test
	fun helloWorldUsesTriggerNameAndStepPrefix() = runBlocking {
		val node = HelloWorldNode()
		val ctx = NodeContext(
			RequestContext(body = buildJsonObject { put("name", "Blok") }),
			null,
			emptyMap(),
			emptyMap(),
			NodeLogger(),
		)
		val output = node.execute(ctx, buildJsonObject { put("prefix", "Hello from the Kotlin runtime") }).jsonObject
		assertEquals("Hello from the Kotlin runtime, Blok!", output["message"]?.toString()?.trim('"'))
		assertEquals("kotlin", output["language"]?.toString()?.trim('"'))
	}

    @Test
    fun claimCheckIdsArePathBounded() {
        val input = buildJsonObject {
            put("\$blokBlob", buildJsonObject { put("id", "../../etc/passwd") })
        }
        assertFailsWith<IllegalArgumentException> { resolveBlob(input) }
    }
}
