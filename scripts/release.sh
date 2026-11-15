#!/bin/sh
# Builds everything a release needs into dist/, and publishes nothing.
# The binary is universal (Apple silicon and Intel); the interface is built into it.
set -eu
cd "$(dirname "$0")/.."
version=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
name="negi-$version-darwin-universal"

pnpm --dir web install --frozen-lockfile
pnpm --dir web build
cargo build --release --target aarch64-apple-darwin
cargo build --release --target x86_64-apple-darwin

rm -rf dist && mkdir -p "dist/$name"
lipo -create -output "dist/$name/negi" \
  target/aarch64-apple-darwin/release/negi target/x86_64-apple-darwin/release/negi
cp LICENSE README.md "dist/$name/"
tar -czf "dist/$name.tar.gz" -C "dist/$name" negi LICENSE README.md
sha=$(shasum -a 256 "dist/$name.tar.gz" | cut -d' ' -f1)
echo "$sha  $name.tar.gz" > "dist/$name.tar.gz.sha256"

sed -e "s/@VERSION@/$version/g" -e "s/@SHA256@/$sha/" packaging/homebrew/negi.rb.in > dist/negi.rb

rm -rf dist/npm && cp -R packaging/npm dist/npm
mkdir -p dist/npm/bin && cp "dist/$name/negi" dist/npm/bin/negi
cp LICENSE README.md dist/npm/
sed -i '' "s/\"version\": \".*\"/\"version\": \"$version\"/" dist/npm/package.json

cargo package --allow-dirty --no-verify >/dev/null

cat <<DONE
Built negi $version in dist/:
  $name.tar.gz  sha256 $sha
  negi.rb       Homebrew formula for rifuki/homebrew-tap
  npm/          npm package with the universal binary
  target/package/negi-$version.crate
Nothing was published.
DONE
