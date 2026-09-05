plugins {
    kotlin("jvm") version "1.9.25"
    kotlin("plugin.serialization") version "1.9.25"
    id("com.google.protobuf") version "0.9.4"
    application
}

group = "com.blok"
version = "1.0.0"

java {
    toolchain { languageVersion.set(JavaLanguageVersion.of(17)) }
}

application {
    mainClass.set("com.blok.kotlin.MainKt")
}

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.8.1")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("io.grpc:grpc-kotlin-stub:1.4.1")
    implementation("io.grpc:grpc-netty-shaded:1.69.0")
    implementation("io.grpc:grpc-protobuf:1.69.0")
    implementation("com.google.protobuf:protobuf-kotlin:3.25.5")

    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.1")
    testImplementation("io.grpc:grpc-testing:1.69.0")
}

sourceSets {
    named("main") {
        proto { srcDir("src/main/proto") }
    }
}

protobuf {
    protoc { artifact = "com.google.protobuf:protoc:3.25.5" }
    plugins {
        id("grpc") { artifact = "io.grpc:protoc-gen-grpc-java:1.69.0" }
        id("grpckt") { artifact = "io.grpc:protoc-gen-grpc-kotlin:1.4.1:jdk8@jar" }
    }
    generateProtoTasks {
        all().forEach { task ->
            task.plugins {
                id("grpc")
                id("grpckt")
            }
        }
    }
}

tasks.test {
    useJUnitPlatform()
}

tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
    kotlinOptions.jvmTarget = "17"
}

tasks.jar {
    manifest { attributes["Main-Class"] = application.mainClass.get() }
}

tasks.register<Copy>("copyRuntimeProto") {
    from("../../proto/blok/runtime/v1/runtime.proto")
    into("src/main/proto/blok/runtime/v1")
}

tasks.named("generateProto") { dependsOn("copyRuntimeProto") }
