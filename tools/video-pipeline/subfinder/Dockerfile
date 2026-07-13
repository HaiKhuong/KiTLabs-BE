# VideoSubFinder CLI in Ubuntu 20.04 (matches eritpchy CI build env).
# Host binaries often segfault on newer glibc/kernels; run via Docker instead.
FROM ubuntu:20.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl tar \
      libgomp1 libtbb2 \
      libopencv-core4.2 libopencv-imgproc4.2 libopencv-imgcodecs4.2 libopencv-videoio4.2 \
      libavcodec58 libavformat58 libavutil56 libswscale5 \
    && rm -rf /var/lib/apt/lists/*

ARG VSF_URL=https://github.com/eritpchy/videosubfinder-cli/releases/download/6.10.2-ci/videosubfinder-cli-cpu-linux-x64.tar.gz
WORKDIR /opt/vsf
RUN curl -fL -o /tmp/vsf.tgz "${VSF_URL}" \
 && tar -xzf /tmp/vsf.tgz -C /opt/vsf \
 && rm -f /tmp/vsf.tgz \
 && if [ ! -f /opt/vsf/VideoSubFinderCli ]; then \
      f="$(find /opt/vsf -type f -name 'VideoSubFinderCli' | head -n1)"; \
      cp -f "$f" /opt/vsf/VideoSubFinderCli; \
    fi \
 && chmod +x /opt/vsf/VideoSubFinderCli \
 && /opt/vsf/VideoSubFinderCli -h >/dev/null 2>&1 || true

WORKDIR /work
ENTRYPOINT ["/opt/vsf/VideoSubFinderCli"]
