#!/usr/bin/env bash
# Gom HF models về tools/video-pipeline/cache/huggingface/hub (một chỗ).
# Usage (WSL):
#   bash tools/video-pipeline/migrate_hf_cache.sh
#   # hoặc dry-run:
#   DRY_RUN=1 bash tools/video-pipeline/migrate_hf_cache.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${KITLABS_PYTHON_CACHE_DIR:-$SCRIPT_DIR/cache}"
ROOT="$(cd "$ROOT" 2>/dev/null && pwd || echo "$ROOT")"
HUB="$ROOT/huggingface/hub"
HOME_HUB="${HOME}/.cache/huggingface/hub"
DRY_RUN="${DRY_RUN:-0}"

move_model() {
  local src="$1"
  local name
  name="$(basename "$src")"
  local dest="$HUB/$name"

  if [ ! -e "$src" ]; then
    echo "  skip (missing): $src"
    return 0
  fi
  if [ -e "$dest" ]; then
    echo "  skip (already at target): $name"
    echo "         left at: $src"
    return 0
  fi
  if [ "$DRY_RUN" = "1" ]; then
    echo "  DRY mv: $src"
    echo "       -> $dest"
    return 0
  fi
  echo "  mv: $name"
  mkdir -p "$HUB"
  mv "$src" "$dest"
}

echo "=== KiTLabs HF cache migrate ==="
echo "target hub: $HUB"
echo "home hub:   $HOME_HUB"
echo "dry_run:    $DRY_RUN"
echo

mkdir -p "$HUB"

echo "[1/3] From ~/.cache/huggingface/hub"
for m in \
  models--Systran--faster-whisper-large-v3 \
  models--openai--whisper-large-v3-turbo \
  models--eustlb--higgs-audio-v2-tokenizer \
  models--PaddlePaddle--PP-LCNet_x1_0_doc_ori \
  models--splendor1811--omnivoice-vietnamese \
  models--k2-fsa--OmniVoice \
  models--black-forest-labs--FLUX.1-schnell \
  models--Tongyi-MAI--Z-Image-Turbo
do
  move_model "$HOME_HUB/$m"
done

echo
echo "[2/3] From legacy cache/omnivoice layouts"
move_model "$ROOT/omnivoice/huggingface/hub/models--k2-fsa--OmniVoice"
move_model "$ROOT/omnivoice/hub/models--k2-fsa--OmniVoice"
# nếu Omni còn nằm dưới subfolder cũ khác tên
if [ -d "$ROOT/omnivoice/huggingface/hub" ]; then
  for src in "$ROOT/omnivoice/huggingface/hub"/models--*; do
    [ -e "$src" ] || continue
    move_model "$src"
  done
fi
if [ -d "$ROOT/omnivoice/hub" ]; then
  for src in "$ROOT/omnivoice/hub"/models--*; do
    [ -e "$src" ] || continue
    move_model "$src"
  done
fi

echo
echo "[3/3] From legacy cache/flux (nếu còn)"
if [ -d "$ROOT/flux/huggingface/hub" ]; then
  for src in "$ROOT/flux/huggingface/hub"/models--*; do
    [ -e "$src" ] || continue
    move_model "$src"
  done
fi

echo
echo "=== After migrate ==="
du -sh "$HUB" 2>/dev/null || true
ls -la "$HUB" 2>/dev/null || true
echo
echo "Legacy leftovers (có thể xóa sau khi xác nhận app chạy OK):"
[ -d "$ROOT/omnivoice" ] && du -sh "$ROOT/omnivoice" || echo "  (no cache/omnivoice)"
[ -d "$ROOT/flux" ] && du -sh "$ROOT/flux" || echo "  (no cache/flux)"
[ -d "$HOME_HUB" ] && du -sh "$HOME_HUB" || echo "  (no ~/.cache/huggingface/hub)"

if [ "$DRY_RUN" != "1" ]; then
  echo
  echo "Gợi ý dọn sau khi test TTS/Translate OK:"
  echo "  rm -rf \"$ROOT/omnivoice\" \"$ROOT/flux\""
  echo "  # chỉ xóa model đã move; các file khác trong ~/.cache giữ nguyên nếu cần"
fi
