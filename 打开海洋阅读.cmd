@echo off
setlocal
chcp 65001 >nul
set "PYTHONUTF8=1"
cd /d "%~dp0"
set "OCEAN_PY=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if exist "%OCEAN_PY%" (
  "%OCEAN_PY%" launch-reader.py
) else (
  py -3 launch-reader.py
)
if errorlevel 1 (
  echo 未能打开阅读页，请查看上方提示。需要 Python 3.11 或以上，并完整解压项目。
  pause
)
endlocal
