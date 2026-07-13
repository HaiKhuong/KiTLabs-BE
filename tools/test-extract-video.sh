#!/bin/bash
# Test extract video trực tiếp vào Docker container
# Usage: bash test-extract-video.sh <douyin_video_url>
# Example: bash test-extract-video.sh "https://v.douyin.com/0cwcNGHhuYc"

URL="${1:-https://v.douyin.com/0cwcNGHhuYc}"
COOKIE_FILE="./secrets/douyin-cookies.txt"
SERVICE_URL="http://localhost:8101"

echo "=== Test Extract Video ==="
echo "URL: $URL"
echo "Service: $SERVICE_URL"
echo ""

# Read cookies
if [ -f "$COOKIE_FILE" ]; then
  COOKIE_CONTENT=$(cat "$COOKIE_FILE" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))" 2>/dev/null || cat "$COOKIE_FILE")
  echo "Cookies: loaded from $COOKIE_FILE"
else
  COOKIE_CONTENT='null'
  echo "Cookies: NOT FOUND at $COOKIE_FILE"
fi

echo ""
echo "--- Calling /extract ---"
curl -s -w "\nHTTP_STATUS: %{http_code}\nTIME: %{time_total}s\n" \
  -X POST "$SERVICE_URL/extract" \
  -H "Content-Type: application/json" \
  -d "{\"url\": \"$URL\", \"cookie_content\": $COOKIE_CONTENT}" | head -c 2000

echo ""
echo ""
echo "--- Docker logs (last 30 lines) ---"
docker logs kitools-douyin-playwright --tail 30 2>&1
