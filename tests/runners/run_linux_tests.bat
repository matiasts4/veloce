@echo off
echo ==========================================
echo      Veloce Linux Test Runner
echo ==========================================

cd /d "%~dp0\..\.."

echo [1/2] Building and Testing Ubuntu 22.04 (Fresh Install)...
docker build -f tests/docker/Dockerfile.ubuntu22 -t veloce-test-ubuntu22 .
if %ERRORLEVEL% NEQ 0 (
    echo [FAIL] Ubuntu Build Failed
    pause
    exit /b %ERRORLEVEL%
)

echo [INFO] Running Ubuntu Test with 4GB RAM Limit and --allow-cpu...
docker run --rm --memory="4g" --memory-swap="4g" veloce-test-ubuntu22 python3 tests/runners/run_local_test.py --allow-cpu
if %ERRORLEVEL% NEQ 0 (
    echo [FAIL] Ubuntu Test Failed
) else (
    echo [PASS] Ubuntu Test Passed
)

echo.
echo [2/2] Building and Testing Debian (Compressed Package)...
docker build -f tests/docker/Dockerfile.compressed -t veloce-test-debian .
if %ERRORLEVEL% NEQ 0 (
    echo [FAIL] Debian Build Failed
    pause
    exit /b %ERRORLEVEL%
)

echo [INFO] Running Debian Test with 4GB RAM Limit and --allow-cpu...
docker run --rm --memory="4g" --memory-swap="4g" veloce-test-debian python3 tests/runners/run_local_test.py --allow-cpu
if %ERRORLEVEL% NEQ 0 (
    echo [FAIL] Debian Test Failed
) else (
    echo [PASS] Debian Test Passed
)

echo.
echo ==========================================
echo      All Tests Completed
echo ==========================================
pause
