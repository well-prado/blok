fn main() -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(feature = "grpc")]
    {
        // Use a vendored `protoc` binary so the SDK builds on machines that
        // do not have Google Protocol Buffers installed. The crate ships
        // protoc binaries for every Tier-1 platform.
        let protoc = protoc_bin_vendored::protoc_bin_path()
            .expect("vendored protoc binary should be available");
        std::env::set_var("PROTOC", protoc);

        // Compile the canonical Blok runtime v1 proto.
        // Source of truth lives at repo-root `proto/blok/runtime/v1/runtime.proto`
        // and is mirrored into this crate at `proto/blok/runtime/v1/runtime.proto`
        // via `make proto-rust` from the repo root.
        // Generate both server and client. The client stubs are needed by
        // integration tests in `tests/` and may be useful for SDK consumers
        // that want to call `NodeRuntime` from Rust (e.g. composing nodes
        // that delegate to other runtimes).
        tonic_build::configure()
            .build_server(true)
            .build_client(true)
            .compile_protos(
                &["proto/blok/runtime/v1/runtime.proto"],
                &["proto"],
            )?;

        // Re-run if the proto file or its directory changes.
        println!("cargo:rerun-if-changed=proto/blok/runtime/v1/runtime.proto");
        println!("cargo:rerun-if-changed=proto");
    }
    Ok(())
}
