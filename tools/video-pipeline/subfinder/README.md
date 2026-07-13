# VideoSubFinder (VSE Step1)

Host `VideoSubFinderCli` often **segfaults** on modern Ubuntu. Use **Docker** (default).

### 1. Build image (one-time)

```bash
cd /home/haikhuong/sources/KiTLabs-BE
docker build -t kitools-videosubfinder tools/video-pipeline/subfinder
docker run --rm kitools-videosubfinder -h
```

### 2. Run VSE from FE

Select **VSE** as Step1 source. Pipeline uses `--vse-use-docker on` by default.

### 3. Diagnose host binary (optional)

```bash
uname -m
file tools/video-pipeline/subfinder/linux/VideoSubFinderCli
ldd tools/video-pipeline/subfinder/linux/VideoSubFinderCli | head
```

If host binary segfaults, keep Docker mode (`vse_use_docker=on`).
