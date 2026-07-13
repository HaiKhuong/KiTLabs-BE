param(
  [string]$Url = "https://v.douyin.com/fPIVGeckUOg/",
  [string]$CookieFile = "..\..\secrets\douyin-cookies.txt",
  [string]$Output = "video.json"
)

$cookiePath = Join-Path $PSScriptRoot $CookieFile
if (-not (Test-Path $cookiePath)) {
  Write-Error "Cookie file not found: $cookiePath"
  exit 1
}

$cookie = [System.IO.File]::ReadAllText($cookiePath)
$body = @{
  url = $Url
  cookie_content = $cookie
}

$json = $body | ConvertTo-Json -Compress
$outPath = Join-Path $PSScriptRoot $Output
[System.IO.File]::WriteAllText($outPath, $json, [System.Text.UTF8Encoding]::new($false))
Write-Host "Wrote $outPath"
