//! The server embeds `web/dist`. Without a web build a placeholder page stands in, so the
//! Rust code builds and tests on a machine with no Node.

use std::fs;
use std::path::Path;

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
}
