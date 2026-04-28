#!/usr/bin/env bash
# install.sh — Nova CLI installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/gammawolfe/Nova/main/install.sh | bash
#
# Or with a specific version:
#   curl -fsSL https://raw.githubusercontent.com/gammawolfe/Nova/main/install.sh | bash -s -- --version v0.1.0
#
# Installs the nova binary to /usr/local/bin (or $NOVA_INSTALL_DIR).
# Requires: curl or wget, and write access to the install dir.

set -euo pipefail

REPO="gammawolfe/Nova"
BINARY="nova"
INSTALL_DIR="${NOVA_INSTALL_DIR:-/usr/local/bin}"
VERSION="${1:-latest}"

# ── Colours ────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  BOLD="\033[1m"; RESET="\033[0m"; GREEN="\033[32m"; RED="\033[31m"; DIM="\033[2m"; CYAN="\033[36m"
else
  BOLD=""; RESET=""; GREEN=""; RED=""; DIM=""; CYAN=""
fi

info()  { echo -e "  ${DIM}>${RESET} $*"; }
ok()    { echo -e "  ${GREEN}✓${RESET} $*"; }
err()   { echo -e "  ${RED}✕${RESET} $*" >&2; exit 1; }
bold()  { echo -e "\n${BOLD}$*${RESET}"; }

# ── Detect platform ────────────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin)
    case "$ARCH" in
      arm64)  ASSET="nova-macos-arm64" ;;
      x86_64) ASSET="nova-macos-x64" ;;
      *)      err "Unsupported macOS architecture: $ARCH" ;;
    esac
    ;;
  Linux)
    case "$ARCH" in
      x86_64)  ASSET="nova-linux-x64" ;;
      aarch64) err "Linux ARM64 binary not yet available. Build from source: npm run cli:build" ;;
      *)       err "Unsupported Linux architecture: $ARCH" ;;
    esac
    ;;
  *)
    err "Unsupported OS: $OS. On Windows, download nova-windows-x64.exe from the GitHub releases page."
    ;;
esac

# ── Resolve version ────────────────────────────────────────────────────────
bold "Nova CLI installer"

if [ "$VERSION" = "latest" ]; then
  info "Fetching latest release…"
  if command -v curl &>/dev/null; then
    VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed 's/.*"tag_name": *"\(.*\)".*/\1/')
  elif command -v wget &>/dev/null; then
    VERSION=$(wget -qO- "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed 's/.*"tag_name": *"\(.*\)".*/\1/')
  else
    err "curl or wget required"
  fi
  [ -z "$VERSION" ] && err "Could not determine latest version"
fi

DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET}"

info "Version:  ${CYAN}${VERSION}${RESET}"
info "Platform: ${CYAN}${OS} ${ARCH}${RESET}"
info "Asset:    ${DIM}${ASSET}${RESET}"
info "Install:  ${DIM}${INSTALL_DIR}/${BINARY}${RESET}"
echo

# ── Download ───────────────────────────────────────────────────────────────
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

info "Downloading…"
if command -v curl &>/dev/null; then
  curl -fsSL --progress-bar "$DOWNLOAD_URL" -o "$TMP"
elif command -v wget &>/dev/null; then
  wget -q --show-progress "$DOWNLOAD_URL" -O "$TMP"
else
  err "curl or wget required"
fi

chmod +x "$TMP"

# Quick sanity check — binary should print a version line
if ! "$TMP" --version &>/dev/null; then
  err "Downloaded binary failed sanity check. Report this at https://github.com/${REPO}/issues"
fi

# ── Install ────────────────────────────────────────────────────────────────
DEST="${INSTALL_DIR}/${BINARY}"

if [ -w "$INSTALL_DIR" ]; then
  mv "$TMP" "$DEST"
else
  info "Install dir requires sudo…"
  sudo mv "$TMP" "$DEST"
fi

ok "Installed to ${DEST}"

# ── PATH check ────────────────────────────────────────────────────────────
if ! command -v nova &>/dev/null; then
  echo
  echo -e "  ${RED}⚠${RESET}  ${INSTALL_DIR} is not in your PATH."
  echo -e "     Add this to your shell profile:"
  echo -e "       ${DIM}export PATH=\"\$PATH:${INSTALL_DIR}\"${RESET}"
fi

# ── Done ───────────────────────────────────────────────────────────────────
echo
ok "nova ${VERSION} installed"
echo
echo -e "  Run ${CYAN}nova setup${RESET} to configure your Nova instance."
echo -e "  Run ${CYAN}nova --help${RESET} to see all commands."
echo
