@echo off
echo ==========================================
echo      Veloce GPU Linux Test Runner
echo      Target: Large V3 Turbo + WhisperCPP + GPU
echo ==========================================

cd /d "%~dp0\..\.."

echo [INFO] Building Ubuntu 22.04 Image...
docker build -f tests/docker/Dockerfile.ubuntu22 -t veloce-test-ubuntu22 .
if %ERRORLEVEL% NEQ 0 (
    echo [FAIL] Build Failed
    pause
    exit /b %ERRORLEVEL%
)

echo [INFO] Running GPU Test (Ubuntu)...
echo [INFO] Mounting D:\veloce_cache to /veloce_cache
echo [INFO] Enabling NVIDIA GPU Access (--gpus all)...
echo.

docker run --rm ^
  --gpus all ^
  --memory="6g" --memory-swap="6g" ^
  -v "D:\veloce_cache:/veloce_cache" ^
  -e HF_HOME=/veloce_cache/huggingface ^
  -e PIP_CACHE_DIR=/veloce_cache/pip ^
  -e UV_CACHE_DIR=/veloce_cache/uv ^
  veloce-test-ubuntu22 ^
  python3 tests/runners/run_local_test.py --model large-v3-turbo --backend whispercpp

if %ERRORLEVEL% NEQ 0 (
    echo [FAIL] GPU Test Failed (Check if Docker Desktop has GPU support enabled)
) else (
    echo [PASS] GPU Test Passed
)

pause
