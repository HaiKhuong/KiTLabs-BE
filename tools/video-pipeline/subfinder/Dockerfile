# VideoSubFinder CLI — static build (no wx/opencv/ffmpeg shared libs).
# Host binaries often segfault on modern glibc; run via this image instead.
FROM ubuntu:20.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl tar \
    && rm -rf /var/lib/apt/lists/*

# Static CPU build from eritpchy (no libwx / libavcodec deps)
ARG VSF_URL=https://github.com/eritpchy/videosubfinder-cli/releases/download/6.10.2-ci/videosubfinder-cli-cpu-static-linux-x64.tar.gz
WORKDIR /opt/vsf
RUN curl -fL -o /tmp/vsf.tgz "${VSF_URL}" \
 && tar -xzf /tmp/vsf.tgz -C /opt/vsf \
 && rm -f /tmp/vsf.tgz \
 && if [ ! -f /opt/vsf/VideoSubFinderCli ]; then \
      f="$(find /opt/vsf -type f -name 'VideoSubFinderCli' | head -n1)"; \
      test -n "$f" && cp -f "$f" /opt/vsf/VideoSubFinderCli; \
    fi \
 && chmod +x /opt/vsf/VideoSubFinderCli \
 && test -x /opt/vsf/VideoSubFinderCli \
 && (/opt/vsf/VideoSubFinderCli -h 2>&1 | grep -q "Usage: VideoSubFinderCli" || \
     /opt/vsf/VideoSubFinderCli -h >/dev/null 2>&1 || true)

WORKDIR /work
ENTRYPOINT ["/opt/vsf/VideoSubFinderCli"]
