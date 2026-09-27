#!/bin/sh
# agentctl のインストーラ (macOS / Linux)
#
#   curl -fsSL https://raw.githubusercontent.com/masahide/agent-kit/main/tools/agentctl/install.sh | sh
#
# GitHub Releases の agentctl-v* から、この OS と CPU 向けのバイナリを取り、checksums.txt で
# 確かめてから ~/.local/bin/agentctl に置く。環境変数で変えられるもの:
#   AGENTCTL_VERSION      入れる版 (例 0.1.0)。既定は最新の agentctl-v* リリース
#   AGENTCTL_INSTALL_DIR  置き場 (既定 ~/.local/bin)
#   AGENTCTL_REPO         配布元のリポジトリ (既定 masahide/agent-kit)
set -eu

REPO="${AGENTCTL_REPO:-masahide/agent-kit}"
VERSION="${AGENTCTL_VERSION:-}"
INSTALL_DIR="${AGENTCTL_INSTALL_DIR:-$HOME/.local/bin}"
# テストやミラー用。ふだんは変えない
GITHUB_API="${AGENTCTL_GITHUB_API:-https://api.github.com}"
GITHUB_URL="${AGENTCTL_GITHUB_URL:-https://github.com}"

fail() {
	echo "agentctl install: $*" >&2
	exit 1
}

fetch() { # fetch URL [OUTFILE]
	if command -v curl >/dev/null 2>&1; then
		if [ $# -eq 2 ]; then curl -fsSL -o "$2" "$1"; else curl -fsSL "$1"; fi
	elif command -v wget >/dev/null 2>&1; then
		if [ $# -eq 2 ]; then wget -qO "$2" "$1"; else wget -qO- "$1"; fi
	else
		fail "curl or wget is required"
	fi
}

case "$(uname -s)" in
Linux) os=linux ;;
Darwin) os=darwin ;;
*) fail "unsupported OS $(uname -s); on Windows use install.ps1" ;;
esac
case "$(uname -m)" in
x86_64 | amd64) arch=amd64 ;;
arm64 | aarch64) arch=arm64 ;;
*) fail "unsupported CPU $(uname -m)" ;;
esac

if [ -n "$VERSION" ]; then
	tag="agentctl-v${VERSION#v}"
else
	tag=$(fetch "$GITHUB_API/repos/$REPO/releases?per_page=100" |
		grep -o '"tag_name": *"agentctl-v[^"]*"' | head -n 1 | sed 's/.*"\(agentctl-v[^"]*\)"$/\1/') ||
		fail "cannot list the releases of $REPO"
	[ -n "$tag" ] || fail "no agentctl release found in $REPO"
fi

asset="agentctl-$os-$arch"
base="$GITHUB_URL/$REPO/releases/download/$tag"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

echo "Downloading $asset ($tag)..."
fetch "$base/$asset" "$tmp/$asset" || fail "cannot download $base/$asset"
fetch "$base/checksums.txt" "$tmp/checksums.txt" || fail "cannot download $base/checksums.txt"

want=$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$tmp/checksums.txt")
[ -n "$want" ] || fail "$asset is not in checksums.txt"
if command -v sha256sum >/dev/null 2>&1; then
	got=$(sha256sum "$tmp/$asset" | awk '{ print $1 }')
else
	got=$(shasum -a 256 "$tmp/$asset" | awk '{ print $1 }')
fi
[ "$want" = "$got" ] || fail "checksum mismatch for $asset"

mkdir -p "$INSTALL_DIR"
chmod 755 "$tmp/$asset"
mv "$tmp/$asset" "$INSTALL_DIR/agentctl"
echo "Installed $("$INSTALL_DIR/agentctl" --version) to $INSTALL_DIR/agentctl"

case ":$PATH:" in
*":$INSTALL_DIR:"*) ;;
*)
	echo
	echo "$INSTALL_DIR is not on your PATH. Add this to your shell profile:"
	echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
	;;
esac

echo
echo "Next: agentctl --json doctor"
echo "To send messages to Claude sessions, load the agentctl Mod (plugins/agentctl); see docs/agentctl/usage.md."
