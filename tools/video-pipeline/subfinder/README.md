# VideoSubFinder (VSE Step1)

Binaries are **not** committed (≈45MB+). Download once on the server:

```bash
bash tools/video-pipeline/scripts/download_videosubfinder.sh
# or explicitly:
bash tools/video-pipeline/scripts/download_videosubfinder.sh linux
```

Then choose **VSE** as Step1 source on the FE (`step1SubtitleSource: "vse"`), or:

```bash
python auto_vietsub_pro.py --step1-subtitle-source vse ...
```

ROI uses the same PaddleOCR crop knobs:

| FE field | CLI | Meaning |
|---|---|---|
| Độ cao có sub | `--paddleocr-crop-band-hi` | Outer edge from bottom (e.g. `0.2` = bottom 20%) |
| Độ cao lấy sub | `--paddleocr-max-strip-height-ratio` | Band height cap (`0` = full hi→0) |
| Chiều ngang sub | `--paddleocr-crop-probe-h-trim-*-frac` | Left/right trim |

Flow: **VideoSubFinder** detects subtitle frames → **PaddleOCR** reads ClearedTXTImages/RGBImages → `.zh.srt`.
