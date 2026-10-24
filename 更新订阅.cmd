@echo off
setlocal
chcp 65001 >nul
set "PYTHONUTF8=1"
cd /d "%~dp0"
set "OCEAN_PY=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if exist "%OCEAN_PY%" (
  "%OCEAN_PY%" scripts\refresh.py --config config\sources.json --output-dir site
) else (
  py -3 scripts\refresh.py --config config\sources.json --output-dir site
)
set "OCEAN_UPDATE_STATUS=%ERRORLEVEL%"
if not "%OCEAN_UPDATE_STATUS%"=="0" (
  echo 本轮更新未全部完成，请查看上方提示。已有数据会保留，失败来源会显示状态。
) else (
  echo 更新完成。阅读页请刷新以读取最新数据。
)
pause
endlocal & exit /b %OCEAN_UPDATE_STATUS%
