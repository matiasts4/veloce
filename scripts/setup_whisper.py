import os
import sys
import urllib.request
import zipfile
import shutil
from pathlib import Path

# Configuration
# https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.3/whisper-bin-x64.zip
WHISPER_CPP_RELEASE_URL = "https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.3/whisper-bin-x64.zip"
# https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
MODEL_URL_GGML = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin"

PROJECT_ROOT = Path(__file__).parent.parent
RESOURCES_DIR = PROJECT_ROOT / "src-tauri" / "resources"
WHISPER_DIR = RESOURCES_DIR / "whispercpp"
MODELS_DIR = RESOURCES_DIR / "models"

def download_file(url, dest_path):
    print(f"Downloading {url} to {dest_path}...")
    try:
        req = urllib.request.Request(
            url, 
            headers={'User-Agent': 'Mozilla/5.0'}
        )
        with urllib.request.urlopen(req) as response, open(dest_path, 'wb') as out_file:
            shutil.copyfileobj(response, out_file)
        print("Download complete.")
    except Exception as e:
        print(f"Error downloading {url}: {e}")
        # Clean up partial download
        if dest_path.exists():
            os.remove(dest_path)
        sys.exit(1)

def setup_whisper_cpp():
    if not WHISPER_DIR.exists():
        WHISPER_DIR.mkdir(parents=True)
    
    zip_path = WHISPER_DIR / "whisper-bin.zip"
    
    # Check if files already exist to avoid redownloading if script run multiple times
    if (WHISPER_DIR / "whisper-cli.exe").exists() and (WHISPER_DIR / "whisper-server.exe").exists():
        print("Whisper configuration binaries already exist.")
        # We might want to force update if needed, but for now skip
        # return 
    
    if not zip_path.exists():
        download_file(WHISPER_CPP_RELEASE_URL, zip_path)
    
    print("Extracting zip...")
    try:
        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            zip_ref.extractall(WHISPER_DIR)
    except zipfile.BadZipFile:
        print("Error: Downloaded zip file is corrupted. Deleting and retrying...")
        os.remove(zip_path)
        download_file(WHISPER_CPP_RELEASE_URL, zip_path)
        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            zip_ref.extractall(WHISPER_DIR)

    # Clean up zip
    if zip_path.exists():
        os.remove(zip_path)
    
    # Handle Release subdirectory if present
    release_dir = WHISPER_DIR / "Release"
    if release_dir.exists() and release_dir.is_dir():
        print("Found Release subdirectory, moving files...")
        for item in release_dir.iterdir():
             dest = WHISPER_DIR / item.name
             if dest.exists():
                 if dest.is_dir():
                     shutil.rmtree(dest)
                 else:
                     os.remove(dest)
             shutil.move(item, dest)
        try:
             release_dir.rmdir()
        except:
             pass

    # Rename/Organize
    # The zip contains main.exe, server.exe, etc.
    main_exe = WHISPER_DIR / "main.exe"
    if main_exe.exists():
        new_path = WHISPER_DIR / "whisper-cli.exe"
        if new_path.exists():
            os.remove(new_path)
        shutil.move(main_exe, new_path)
        print(f"Renamed main.exe to {new_path.name}")
    else:
        print("Warning: main.exe not found in extracted files.")
        
    server_exe = WHISPER_DIR / "server.exe"
    if server_exe.exists():
        new_path = WHISPER_DIR / "whisper-server.exe"
        if new_path.exists():
            os.remove(new_path)
        shutil.move(server_exe, new_path)
        print(f"Renamed server.exe to {new_path.name}")
    else:
        print("Warning: server.exe not found in extracted files.")

def setup_model():
    if not MODELS_DIR.exists():
        MODELS_DIR.mkdir(parents=True)
        
    model_path = MODELS_DIR / "ggml-large-v3-turbo.bin"
    if model_path.exists():
        print(f"Model already exists at {model_path}, skipping download.")
        return
    
    # Check if model exists in C:/wsp/models
    local_candidate = Path("C:/wsp/models/ggml-large-v3-turbo.bin")
    if local_candidate.exists():
        print(f"Found local model at {local_candidate}, copying...")
        try:
            shutil.copy2(local_candidate, model_path)
            print("Copy complete.")
            return
        except Exception as e:
             print(f"Error copying local model: {e}. Falling back to download.")

    download_file(MODEL_URL_GGML, model_path)

if __name__ == "__main__":
    print("Setting up Whisper CPP resources...")
    setup_whisper_cpp()
    setup_model()
    print("Setup complete.")
