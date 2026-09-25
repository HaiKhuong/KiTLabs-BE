#!/usr/bin/env bash
# Download VideoSubFinder CLI for Step1 VSE mode.
#
# Linux default: static build from eritpchy/videosubfinder-cli
#   (YaoFANGUK bundled binary often segfaults / missing libavcodec on modern Ubuntu)
#
# Usage:
#   bash tools/video-pipeline/scripts/download_videosubfinder.sh
#   bash tools/video-pipeline/scripts/download_videosubfinder.sh linux
#   bash tools/video-pipeline/scripts/download_videosubfinder.sh windows
#   bash tools/video-pipeline/scripts/download_videosubfinder.sh macos
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIPELINE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SUBFINDER_DIR="${PIPELINE_DIR}/subfinder"

# Static CPU Linux build — no shared ffmpeg/opencv deps required.
ERITPCHY_TAG="6.10.2-ci"
ERITPCHY_STATIC_URL="https://github.com/eritpchy/videosubfinder-cli/releases/download/${ERITPCHY_TAG}/videosubfinder-cli-cpu-static-linux-x64.tar.gz"

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
    TMP="videosubfinder-cli-cpu-static-linux-x64.tar.gz"
    download "${ERITPCHY_STATIC_URL}" "${TMP}"
    # Clear previous broken YaoFANGUK binary if present
    rm -f VideoSubFinderCli VideoSubFinderCli.run 2>/dev/null || true
    tar -xzf "${TMP}"
    rm -f "${TMP}"

    # Normalize name: find extracted VideoSubFinderCli*
    FOUND=""
    if [[ -f VideoSubFinderCli ]]; then
      FOUND="VideoSubFinderCli"
    elif [[ -f VideoSubFinderCli.run ]]; then
      FOUND="VideoSubFinderCli.run"
    else
      FOUND="$(find . -maxdepth 2 -type f \( -name 'VideoSubFinderCli' -o -name 'VideoSubFinderCli.run' \) | head -n1 || true)"
      if [[ -n "${FOUND}" && "${FOUND}" != "./VideoSubFinderCli" ]]; then
        cp -f "${FOUND}" ./VideoSubFinderCli
        FOUND="./VideoSubFinderCli"
      fi
    fi

    if [[ -z "${FOUND}" || ! -f VideoSubFinderCli && ! -f VideoSubFinderCli.run ]]; then
      echo "ERROR: archive extracted but VideoSubFinderCli not found. Contents:"
      find . -maxdepth 2 -type f | head -40
      exit 1
    fi

    chmod +x VideoSubFinderCli VideoSubFinderCli.run 2>/dev/null || true
    echo "Smoke test:"
    if ./VideoSubFinderCli -h >/tmp/vsf_help.txt 2>&1 || ./VideoSubFinderCli --help >/tmp/vsf_help.txt 2>&1; then
      head -n 5 /tmp/vsf_help.txt || true
      echo "OK: VideoSubFinderCli runs"
    else
      echo "WARN: --help failed (exit $?). First lines:"
      head -n 20 /tmp/vsf_help.txt || true
      echo "Try: ldd ./VideoSubFinderCli | grep 'not found'"
    fi
    ;;
  macos)
    REPO_RAW="https://raw.githubusercontent.com/YaoFANGUK/video-subtitle-extractor/main/backend/subfinder"
    download "${REPO_RAW}/macos/VideoSubFinderCli" "VideoSubFinderCli"
    chmod +x VideoSubFinderCli || true
    ;;
  windows)
    REPO_RAW="https://raw.githubusercontent.com/YaoFANGUK/video-subtitle-extractor/main/backend/subfinder/windows"
    # Full runtime — .exe alone crashes with Windows 0xC0000135 (missing DLL).
    for f in \
      VideoSubFinderWXW.exe \
      avcodec-58.dll avdevice-58.dll avfilter-7.dll avformat-58.dll avutil-56.dll \
      concrt140.dll cudart64_110.dll finished.wav msvcp140.dll \
      nppc64_11.dll nppicc64_11.dll nppig64_11.dll \
      opencv_videoio_ffmpeg430_64.dll opencv_world430.dll postproc-55.dll \
      previous_video.inf swresample-3.dll swscale-5.dll \
      vcruntime140.dll vcruntime140_1.dll; do
      download "${REPO_RAW}/${f}" "${f}"
    done
    mkdir -p settings/eng
    download "${REPO_RAW}/settings/general.cfg" "settings/general.cfg"
    download "${REPO_RAW}/settings/eng/locale.cfg" "settings/eng/locale.cfg"
    ;;
  *)
    echo "Unknown target: ${TARGET}"
    exit 1
    ;;
esac

echo "Done. Binary ready under: ${SUBFINDER_DIR}/${TARGET}"
echo "Select Step1 source = vse on FE, or: --step1-subtitle-source vse"
