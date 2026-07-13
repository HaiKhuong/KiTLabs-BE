@echo off
REM Test extract video - chay tren server Linux
REM Copy & paste lenh curl ben duoi vao terminal server

echo === Tao request JSON ===
echo.

REM Cach 1: Test KHONG cookie (nhanh, co the fail)
echo --- Test without cookies ---
echo curl -s -X POST http://localhost:8101/extract -H "Content-Type: application/json" -d "{\"url\": \"https://v.douyin.com/0cwcNGHhuYc\"}"
echo.

REM Cach 2: Test CO cookie (chay tren server)
echo --- Test with cookies (run on server) ---
echo cat secrets/douyin-cookies.txt ^| python3 -c "import sys,json; c=sys.stdin.read(); print(json.dumps({'url':'https://v.douyin.com/0cwcNGHhuYc','cookie_content':c}))" ^| curl -s -X POST http://localhost:8101/extract -H "Content-Type: application/json" -d @-
echo.

echo --- Check logs ---
echo docker logs kitools-douyin-playwright --tail 40
