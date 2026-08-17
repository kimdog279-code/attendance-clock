@echo off
chcp 65001 >nul
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $lnk = $ws.CreateShortcut([IO.Path]::Combine([Environment]::GetFolderPath('Desktop'), '주식 매매 프로그램.lnk')); $lnk.TargetPath = '%~dp0시작하기.bat'; $lnk.WorkingDirectory = '%~dp0'; $lnk.Description = '주식 매매 프로그램 실행'; $lnk.Save()"

if errorlevel 1 (
  echo.
  echo 바로가기 생성에 실패했습니다. 시작하기.bat에서 마우스 오른쪽 클릭 후
  echo [보내기] - [바탕 화면에 바로 가기 만들기]를 이용해주세요.
) else (
  echo.
  echo 완료! 바탕화면에 "주식 매매 프로그램" 바로가기가 생겼습니다.
  echo 이제 바탕화면에서 더블클릭으로 바로 실행할 수 있어요.
)
echo.
pause
