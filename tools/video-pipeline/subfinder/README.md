# VideoSubFinder (VSE Step1)

Host `VideoSubFinderCli` often **segfaults** on modern Ubuntu. Default is **native binary**; use Docker on Linux if needed (`--vse-use-docker on`).

Windows: copy the **entire** `backend/subfinder/windows/` folder from video-subtitle-extractor
(`.exe` + ffmpeg/opencv/VC runtime DLLs + `settings/`). Copying only `VideoSubFinderWXW.exe`
fails with exit code `3221225781` (`0xC0000135` missing DLL).

```bash
bash tools/video-pipeline/scripts/download_videosubfinder.sh windows
```

### 1. Build image (one-time, Linux only)

```bash
cd /home/haikhuong/sources/KiTLabs-BE
docker build -t kitools-videosubfinder tools/video-pipeline/subfinder
docker run --rm kitools-videosubfinder -h
```

### 2. Run VSE from FE

Select **VSE** as Step1 source. Pipeline uses native VideoSubFinder by default.

### 3. Diagnose host binary (optional)

```bash
uname -m
file tools/video-pipeline/subfinder/linux/VideoSubFinderCli
ldd tools/video-pipeline/subfinder/linux/VideoSubFinderCli | head
```

If host binary segfaults, keep Docker mode (`vse_use_docker=on`).
