#!/bin/sh
# Installs the newest negi release to $NEGI_PREFIX/bin (default ~/.local/bin): curl -fsSL <url> | sh
set -eu

prefix=${NEGI_PREFIX:-$HOME/.local}

if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo "negi's release is for Apple silicon macOS; on another machine run: cargo install negi" >&2
  exit 1
fi

# The newest release unless NEGI_VERSION names one: /releases/latest redirects to its tag.
version=${NEGI_VERSION:-$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/rifuki/negi/releases/latest | sed 's|.*/tag/v||')}
base=https://github.com/rifuki/negi/releases/download/v$version
name=negi-$version-darwin-arm64

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$base/$name.tar.gz" -o "$tmp/$name.tar.gz"
curl -fsSL "$base/$name.tar.gz.sha256" -o "$tmp/$name.tar.gz.sha256"

(cd "$tmp" && shasum -a 256 -c "$name.tar.gz.sha256" >/dev/null) || {
  echo "checksum does not match the release; nothing installed" >&2
  exit 1
}

tar -xzf "$tmp/$name.tar.gz" -C "$tmp"
mkdir -p "$prefix/bin"
# A new file moved into place, never written over the old one: macOS kills a signed binary
# whose file was changed in place, and a running negi keeps its own copy until it restarts.
cp "$tmp/negi" "$prefix/bin/.negi.new"
chmod 755 "$prefix/bin/.negi.new"
mv -f "$prefix/bin/.negi.new" "$prefix/bin/negi"
echo "installed $("$prefix/bin/negi" --version) to $prefix/bin/negi"
case ":$PATH:" in
  *":$prefix/bin:"*) ;;
  *) echo "add $prefix/bin to PATH to run negi by name" ;;
esac
