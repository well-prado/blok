// swift-tools-version: 6.1

import PackageDescription

let package = Package(
    name: "blok-swift-runtime",
    products: [
        .library(name: "BlokSwiftRuntime", targets: ["BlokSwiftRuntime"]),
        .executable(name: "blok-swift-runtime", targets: ["BlokSwiftRuntimeCLI"]),
    ],
    dependencies: [
        .package(url: "https://github.com/grpc/grpc-swift-2.git", from: "2.0.0"),
        .package(url: "https://github.com/grpc/grpc-swift-protobuf.git", from: "2.4.0"),
        .package(url: "https://github.com/grpc/grpc-swift-nio-transport.git", from: "2.0.0"),
        .package(url: "https://github.com/apple/swift-nio.git", from: "2.70.0"),
    ],
    targets: [
        .target(
            name: "BlokSwiftRuntime",
            dependencies: [
                .product(name: "GRPCCore", package: "grpc-swift-2"),
                .product(name: "GRPCProtobuf", package: "grpc-swift-protobuf"),
            ],
            plugins: [
                .plugin(name: "GRPCProtobufGenerator", package: "grpc-swift-protobuf"),
            ]
        ),
        .executableTarget(
            name: "BlokSwiftRuntimeCLI",
            dependencies: [
                "BlokSwiftRuntime",
                .product(name: "GRPCCore", package: "grpc-swift-2"),
                .product(name: "GRPCNIOTransportHTTP2", package: "grpc-swift-nio-transport"),
                .product(name: "NIOCore", package: "swift-nio"),
                .product(name: "NIOHTTP1", package: "swift-nio"),
                .product(name: "NIOPosix", package: "swift-nio"),
            ]
        ),
        .testTarget(
            name: "BlokSwiftRuntimeTests",
            dependencies: ["BlokSwiftRuntime"]
        ),
    ]
)
