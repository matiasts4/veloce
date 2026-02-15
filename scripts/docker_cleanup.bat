@echo off
echo ==========================================
echo      Veloce Docker Cleanup
echo ==========================================
echo.
echo [WARNING] This will remove ALL stopped containers and unused images.
echo This is recommended to free up disk space after a failed build.
echo.
echo Press Ctrl+C to cancel, or any key to continue...
pause

docker system prune -a -f
echo.
echo [INFO] Cleanup complete. Disk space reclaimed.
pause
