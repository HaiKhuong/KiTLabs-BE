@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-video-json.ps1" %*
