@echo off
setlocal
cd /d "%~dp0"
where uv >nul 2>nul
if errorlevel 1 (
    echo Building requires uv. See README.md for setup.
    pause
    exit /b 1
)
set "UV_CACHE_DIR=%~dp0.cache\uv"
uv run --locked --group build python scripts\build_portable.py
if errorlevel 1 (
    echo.
    echo Portable build failed. See the error above.
    pause
    exit /b 1
)
echo.
pause
exit /b 0
