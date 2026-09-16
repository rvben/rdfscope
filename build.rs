fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    // The shared engine and browser adapter do not embed the native interface.
    if std::env::var_os("CARGO_FEATURE_NATIVE").is_none() {
        return;
    }
    println!("cargo:rerun-if-changed=web/dist");
    assert!(
        std::path::Path::new("web/dist/index.html").is_file(),
        "The embedded interface is missing. From a Git checkout, run `make frontend` first. \
         Published Cargo and Python source packages already include the interface."
    );
}
