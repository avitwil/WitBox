// Vendored for WitBox: on non-MSVC targets the WebView2 loader is NOT linked as an
// import of WebView2Loader.dll. Instead src/embedded_loader.rs embeds the official
// Microsoft loader DLL and resolves its exports at runtime, so the final exe stays a
// single portable file with no WebView2Loader.dll import.
fn main() {
    let env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if env == "msvc" {
        panic!("the vendored webview2-com-sys only supports *-pc-windows-gnu targets");
    }
    println!("cargo:rustc-link-lib=advapi32");
}
