package com.blok.kotlin

fun main() {
    val server = RuntimeServer.fromEnv()
    Runtime.getRuntime().addShutdownHook(Thread {
        server.stop()
        println("Blok Kotlin runtime stopped.")
    })
    server.start()
    server.awaitTermination()
}
