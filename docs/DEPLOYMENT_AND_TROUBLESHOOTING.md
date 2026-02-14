# Deployment & Troubleshooting Guide

## 1. Overview of Bundling Logic

The application uses a **Sidecar Pattern** to bundle `whisper.cpp` executables and a **Resource Pattern** for models.

### Locations
- **Executables**: `src-tauri/resources/whispercpp/` (e.g., `whisper-cli.exe`, `whisper-server.exe`, `ggml.dll`, `whisper.dll`)
- **Models**: `src-tauri/resources/models/` (e.g., `ggml-large-v3-turbo.bin`)

### Runtime Resolution
When the application is installed (`.exe` or `.msi`):
- `audio_engine.py` checks `sys.executable`'s parent directory for a `resources` folder.
- It prioritizes these bundled files over any development or system paths.

---

## 2. Diagnosing "Model Not Detected"

If the app says "Model Not Detected" or doesn't use the bundled model immediately:

1.  **Check the Install Directory**:
    - Go to `C:\Program Files\Veloce` (or where it was installed).
    - Look for `resources/models/ggml-large-v3-turbo.bin`.
    - **If missing**: The installer was likely built using the **Light** configuration (`prepare_light_build.py`). Rebuild using `prepare_full_build.py`.

2.  **Check `audio_engine.py` Logs**:
    - Run the installed app from a terminal (PowerShell) to see stdout/stderr:
      ```powershell
      & "C:\Program Files\Veloce\Veloce.exe"
      ```
    - Look for lines starting with `[AudioEngine]`.
    - It should print `Model Directory: ...` and `Found Model File: ...`.

3.  **Force Model Selection**:
    - In the app Settings, manually select "Large V3 Turbo". 
    - The "Auto" logic tries to pick the best available, but if a previous configuration (e.g., "tiny") was saved in `localStorage`, it might persist. **Clear App Data** or Reset Settings.

---

## 3. GPU Support (The "RTX 4050" Issue)

**Symptoms**:
- "GPU Mod Request, but no compatible GPU Runtime"
- Extremely slow transcription (running on CPU)
- "As Detected" errors in logs.

**Cause**:
The bundled `whisper-bin-x64.zip` (v1.8.3) used in `setup_whisper.py` is a **GENERIC CPU BUILD**. It usually relies on OpenBLAS or standard CPU instructions. **It does NOT contain the CUDA libraries required for NVIDIA GPUs.**

### How to Fix for NVIDIA GPUs (RTX 4050, etc.)

To enable GPU acceleration on the target machine, you must replace the bundled binaries with **CUDA-enabled binaries**.

1.  **Download CUDA Build**:
    - Go to [Whisper.cpp Releases](https://github.com/ggml-org/whisper.cpp/releases).
    - Look for a release ending in `-cu11.zip` or `-cu12.zip` (depending on the driver version).
    - *Note*: If official releases don't have a Windows CUDA build, you may need to build it yourself using CMake with `-DGGML_CUDA=1` or download from a community fork.

2.  **Add Required DLLs**:
    - For GPU support, `whisper-cli.exe` needs access to:
        - `cublas64_11.dll` / `cublas64_12.dll`
        - `cudart64_110.dll` / `cudart64_12.dll`
        - `cublasLt64_11.dll` / `cublasLt64_12.dll`
    - These files must be placed **in the same folder** as `whisper-cli.exe` (i.e., `src-tauri/resources/whispercpp/`).

3.  **System Requirements on Target Machine**:
    - Install the [NVIDIA CUDA Toolkit](https://developer.nvidia.com/cuda-downloads) (versions 11.x or 12.x typically required).
    - Update NVIDIA Drivers.

### Faster-Whisper Fallback
If `whisper.cpp` fails (e.g., missing DLLs), `audio_engine.py` might fall back to `faster-whisper`.
- `faster-whisper` requires `cuDNN` and `zlibwapi.dll` in the PATH to use GPU.
- If these are missing on the target laptop, it will fall back to CPU.

---

## 4. How to Update the Source Code (Git)

The project is configured to exclude heavy binaries from Git.

1.  **Excluded Files** (`.gitignore`):
    - `installers/` (*.exe, *.msi)
    - `src-tauri/resources/models/*.bin`
    - `src-tauri/resources/whispercpp/*.bin`, `*.dll`, `*.exe`
    - `dist/audio-engine.exe`

2.  **What to Commit**:
    - `scripts/` (setup, prepare, verify scripts)
    - `src-tauri/tauri.conf.json` (configuration)
    - `src-tauri/resources/models/README.txt`
    - `python/audio_engine.py`
    - `package.json`
    - Documentation (`docs/`)

3.  **Replicating on Another Machine**:
    - Clone the repo.
    - Run `npm install` / `bun install`.
    - Run `python scripts/setup_whisper.py` (this will download the binaries/models fresh).
    - Run `bun run tauri build`.
