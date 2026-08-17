@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js가 설치되어 있지 않습니다.
  echo 지금 열리는 사이트에서 초록색 버튼을 눌러 다운로드 후,
  echo 설치 화면에서 계속 "다음"만 누르면 됩니다. 설치 후 이 파일을 다시 더블클릭하세요.
  echo.
  start https://nodejs.org/ko
  pause
  exit /b
)

node src/server.js
echo.
pause
