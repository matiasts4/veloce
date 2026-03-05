@echo off
echo [BUILD] Starting Clean Build Process...

echo [1/6] Cleaning previous build artifacts...
if exist "dist" rmdir /s /q "dist"
if exist "build" rmdir /s /q "build"
if exist "src-tauri\target\release" rmdir /s /q "src-tauri\target\release"
if exist "src-tauri\resources\audio-engine.zip" del "src-tauri\resources\audio-engine.zip"
if exist "src-tauri\resources\audio-engine.exe" del "src-tauri\resources\audio-engine.exe"

echo [2/6] Building audio-engine.exe with PyInstaller...
call .venv\Scripts\activate.bat
pyinstaller audio-engine.spec
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] PyInstaller failed!
    exit /b 1
)

echo [3/6] Copying whispercpp to dist/audio-engine...
xcopy "src-tauri\resources\whispercpp" "dist\audio-engine\whispercpp\" /E /I /Y
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Failed to copy whispercpp!
    exit /b 1
)

echo [4/6] Zipping audio-engine folder (for external hosting)...
python zip_audio_engine.py
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Failed to create zip bundle!
    exit /b 1
)

echo [5/6] Verifying Zip content...
if not exist "dist\audio-engine.zip" (
    echo [ERROR] Zip file not found at dist\audio-engine.zip!
    exit /b 1
)

echo [6/6] Building Tauri Installer (Lightweight)...
call bun run tauri build
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Tauri build failed!
    exit /b 1
)

echo [SUCCESS] Installer built successfully!
