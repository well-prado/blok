#[cfg(feature = "tauri-host")]
fn main() {
    blok_desktop_host::run();
}

#[cfg(not(feature = "tauri-host"))]
fn main() {
    // The no-default-features build is used for portable host-contract tests.
}
