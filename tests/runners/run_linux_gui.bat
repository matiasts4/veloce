@echo off
setlocal

echo ===================================================
echo   Veloce Linux GUI Test Runner (Docker + X11)
echo ===================================================
echo.
echo [IMPORTANT] You must have an X Server running on Windows!
echo 1. Install VcXsrv (or use WSLg if on Win11)
echo 2. If VcXsrv: Launch with "Disable access control" ticked.
echo.

set IMAGE_NAME=veloce-linux-gui
set DOCKERFILE=tests\docker\Dockerfile.linux_gui
set CACHE_DIR=D:\veloce_cache

echo [1/2] Detecting X Server (WSLg or VcXsrv)...
tasklist | findstr /i "vcxsrv.exe" >nul 2>&1
if %errorlevel% equ 0 (
    echo [INFO] VcXsrv detected. Using Network Display mode.
    set DISPLAY_VAL=host.docker.internal:0.0
    set MOUNT_X11=
) else (
    echo [INFO] VcXsrv not found. Assuming WSLg mode.
    set DISPLAY_VAL=:0
    set MOUNT_X11=-v //tmp/.X11-unix:/tmp/.X11-unix -v //mnt/wslg:/mnt/wslg
)

echo [2/2] Launching Container (DISPLAY=%DISPLAY_VAL%)...
echo.

docker run --rm -it ^
  --privileged ^
  --net=host ^
  -e DISPLAY=%DISPLAY_VAL% ^
  -e WAYLAND_DISPLAY=wayland-0 ^
  -e XDG_RUNTIME_DIR=/run/user/1000 ^
  -e LIBGL_ALWAYS_SOFTWARE=1 ^
  -e GDK_BACKEND=x11 ^
  %MOUNT_X11% ^
  -v %CACHE_DIR%:/root/.cache/huggingface ^
  %IMAGE_NAME% npm run tauri dev

endlocal

rem Alternative Command if we built a binary:
rem %IMAGE_NAME% ./src-tauri/target/release/veloce

endlocal
