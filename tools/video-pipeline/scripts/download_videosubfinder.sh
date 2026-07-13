#!/usr/bin/env bash
# Download VideoSubFinder binaries from YaoFANGUK/video-subtitle-extractor (main).
# Usage:
#   bash tools/video-pipeline/scripts/download_videosubfinder.sh
#   bash tools/video-pipeline/scripts/download_videosubfinder.sh linux
#   bash tools/video-pipeline/scripts/download_videosubfinder.sh windows
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIPELINE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SUBFINDER_DIR="${PIPELINE_DIR}/subfinder"
REPO_RAW="https://raw.githubusercontent.com/YaoFANGUK/video-subtitle-extractor/main/backend/subfinder"

TARGET="${1:-}"
if [[ -z "${TARGET}" ]]; then
  case "$(uname -s)" in
    Linux*) TARGET=linux ;;
    Darwin*) TARGET=macos ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT*) TARGET=windows ;;
    *)
      echo "Unknown OS. Pass: linux | macos | windows"
      exit 1
      ;;
  esac
fi

mkdir -p "${SUBFINDER_DIR}/${TARGET}"
cd "${SUBFINDER_DIR}/${TARGET}"

echo "Downloading VideoSubFinder for ${TARGET} → ${PWD}"

download() {
  local url="$1"
  local out="$2"
  echo "  GET ${url}"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 -o "${out}" "${url}"
  else
    wget -O "${out}" "${url}"
  fi
}

case "${TARGET}" in
  linux)
    download "${REPO_RAW}/linux/VideoSubFinderCli" "VideoSubFinderCli"
    download "${REPO_RAW}/linux/VideoSubFinderCli.run" "VideoSubFinderCli.run"
    chmod +x VideoSubFinderCli VideoSubFinderCli.run
    # settings (optional but recommended)
    mkdir -p settings
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL "https://api.github.com/repos/YaoFANGUK/video-subtitle-extractor/contents/backend/subfinder/linux/settings?ref=main" \
        | python3 -c '
import json,sys,urllib.request,os
items=json.load(sys.stdin)
for it in items:
  if it.get("type")!="file": continue
  name=it["name"]
  url=it.get("download_url")
  if not url: continue
  print("  GET", url)
  urllib.request.urlretrieve(url, os.path.join("settings", name))
' || echo "WARN: could not fetch settings/ (optional)"
    fi
    ;;
  macos)
    download "${REPO_RAW}/macos/VideoSubFinderCli" "VideoSubFinderCli"
    chmod +x VideoSubFinderCli
    ;;
  windows)
    download "${REPO_RAW}/windows/VideoSubFinderWXW.exe" "VideoSubFinderWXW.exe"
    ;;
  *)
    echo "Unknown target: ${TARGET}"
    exit 1
    ;;
esac

echo "Done. Binary ready under: ${SUBFINDER_DIR}/${TARGET}"
echo "Select Step1 source = vse on FE, or: --step1-subtitle-source vse"
