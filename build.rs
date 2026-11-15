//! The server embeds `web/dist`. Without a web build a placeholder page stands in, so the
//! Rust code builds and tests on a machine with no Node.
//!
//! On macOS it also points the linker at Swift's libraries beside the installed `swiftc` (the
//! capture crate looks only inside a full Xcode) and the binary at macOS's own Swift runtime.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=web/dist");
    let index = Path::new("web/dist/index.html");
    if !index.exists() {
        fs::create_dir_all("web/dist").expect("web/dist can be created");
        fs::write(
            index,
            "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>negi</title>\
             <p>The interface is not built. Run <code>pnpm --dir web install</code> and \
             <code>pnpm --dir web build</code>, then build negi again.</p></html>",
        )
        .expect("the placeholder page can be written");
    }
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        swift();
    }
}

fn swift() {
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    let Ok(out) = Command::new("xcrun").args(["--find", "swiftc"]).output() else { return };
    let swiftc = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
    if let Some(usr) = swiftc.parent().and_then(|bin| bin.parent()) {
        let libs = usr.join("lib/swift/macosx");
        if libs.is_dir() {
            println!("cargo:rustc-link-search=native={}", libs.display());
        }
    }
}
