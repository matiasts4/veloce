@echo off
echo ==========================================
echo      Veloce HEAVY Linux Test Runner
echo      Target: Large V3 Turbo + WhisperCPP
echo ==========================================

cd /d "%~dp0\..\.."

echo [INFO] Building Ubuntu 22.04 Image...
docker build -f tests/docker/Dockerfile.ubuntu22 -t veloce-test-ubuntu22 .
if %ERRORLEVEL% NEQ 0 (
    echo [FAIL] Build Failed
    pause
    exit /b %ERRORLEVEL%
)

echo [INFO] Running Heavy Test (Ubuntu)...
echo [INFO] Mounting D:\veloce_cache to /veloce_cache
echo.

docker run --rm ^
  --memory="6g" --memory-swap="6g" ^
  -v "D:\veloce_cache:/veloce_cache" ^
  -e HF_HOME=/veloce_cache/huggingface ^
  -e PIP_CACHE_DIR=/veloce_cache/pip ^
  -e UV_CACHE_DIR=/veloce_cache/uv ^
  veloce-test-ubuntu22 ^
  python3 tests/runners/run_local_test.py --allow-cpu --model large-v3-turbo --backend whispercpp

if %ERRORLEVEL% NEQ 0 (
    echo [FAIL] HEAVY Test Failed
) else (
    echo [PASS] HEAVY Test Passed
)

pause
