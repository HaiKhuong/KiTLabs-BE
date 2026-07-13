# VideoSubFinder (VSE Step1)

Binaries are **not** committed. On Linux we use the **static** CLI from
[eritpchy/videosubfinder-cli](https://github.com/eritpchy/videosubfinder-cli)
(the YaoFANGUK bundled `VideoSubFinderCli` often segfaults on modern Ubuntu).

```bash
cd /path/to/KiTLabs-BE
bash tools/video-pipeline/scripts/download_videosubfinder.sh linux
```

Smoke test:

```bash
cd tools/video-pipeline/subfinder/linux
./VideoSubFinderCli -h
# if segfault with old binary: re-run download script above
```

Then choose **VSE** on FE (`step1SubtitleSource: "vse"`), or:

```bash
python auto_vietsub_pro.py --step1-subtitle-source vse ...
```

ROI uses the same PaddleOCR crop knobs (`paddleocr-crop-band-hi`, `max-strip-height-ratio`, h-trim).
