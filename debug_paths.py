
import sys
import os
import logging
from pathlib import Path

# Setup basic logging to stdout
logging.basicConfig(level=logging.INFO, format='%(message)s')

def emit(msg):
    print(msg)

def project_root() -> Path:
    # Mimic audio_engine.py location: veloce/python/audio_engine.py
    # This script is at veloce/debug_paths.py.
    # So project_root relative to this script is just current dir.
    # But let's verify if we run it from veloce root.
    return Path(__file__).resolve().parent

def get_exe_ext() -> str:
    return ".exe" if sys.platform.startswith("win") else ""

def get_whispercpp_executable() -> Path | None:
    env_path = os.environ.get("WHISPERCPP_EXE")
    if env_path:
        candidate = Path(env_path)
        if candidate.exists() and candidate.is_file():
            return candidate

    root = project_root()
    ext = get_exe_ext()
    
    # Check for bundled resources in freeze/installer mode
    if getattr(sys, 'frozen', False):
        exe_path = Path(sys.executable).parent
        
        candidates = [
            exe_path / "whispercpp" / f"whisper-cli{ext}",
            exe_path / f"whisper-cli{ext}", 
            exe_path / "whisper-cli.exe", 
            exe_path / "whispercpp" / "whisper-cli.exe",
            
            exe_path / "whispercpp" / f"main{ext}",
            exe_path / "resources" / "whispercpp" / f"whisper-cli{ext}",
            exe_path / "resources" / "whispercpp" / f"main{ext}",
            exe_path.parent / "whispercpp" / f"whisper-cli{ext}",
            exe_path.parent / "resources" / "whispercpp" / f"whisper-cli{ext}",
            exe_path.parent / "resources" / "whispercpp" / f"whisper-cli{ext}",
            exe_path / f"whisper-cli{ext}", 
            exe_path / "whisper-cli.exe", 
        ]
        
        logging.info(f"Frozen mode detected. Sys.exe: {sys.executable}")
        logging.info(f"Exe path: {exe_path}")

    else:
        # Dev mode
        exe_path = project_root()
        candidates = [
            project_root() / "src-tauri" / "resources" / "whispercpp" / f"whisper-cli{ext}",
            project_root() / "src-tauri" / "resources" / "whispercpp" / f"main{ext}",
            # Resource folder next to script
            root / "resources" / "whispercpp" / f"whisper-cli{ext}",
            # Known legacy/custom paths
            Path(f"C:/wsp/build/bin/Release/whisper-cli{ext}"),
            root / "python" / "whispercpp" / f"whisper-cli{ext}",
            root / "whispercpp" / "build" / "bin" / "Release" / f"whisper-cli{ext}",
        ]
        logging.info(f"Dev mode detected. Exe path (root): {exe_path}")

    logging.info(f"[DEBUG PATHS] Project Root: {root}")

    for candidate in candidates:
        if candidate.exists() and candidate.is_file():
            logging.info(f"Found whispercpp (standard/dev) at: {candidate}")
            return candidate
        else:
            logging.info(f"[DEBUG PATHS] Not found: {candidate}")

    # Recursive search as fallback
    try:
        logging.info("Standard paths failed. Attempting recursive search...")
        
        search_roots = [exe_path]
        if exe_path.parent != exe_path:
            search_roots.append(exe_path.parent)
            
        extras = ["resources", "_up_", "dist", "src-tauri"] 
        for extra in extras:
            if (exe_path / extra).exists(): search_roots.append(exe_path / extra)
        
        search_roots = list(set(search_roots))
        
        for root in search_roots:
            if not root.exists(): continue
            logging.info(f"Searching root: {root}")
            for dirpath, dirnames, filenames in os.walk(root):
                if f"whisper-cli{ext}" in filenames:
                    found = Path(dirpath) / f"whisper-cli{ext}"
                    logging.info(f"Found whispercpp via walk at: {found}")
                    return found
                    
    except Exception as e:
         logging.error(f"Recursive search failed: {e}")
            
    logging.error(f"Could not find whisper-cli.exe.")
    return None

if __name__ == "__main__":
    print("\n--- DEBUG START ---")
    sys.frozen = False # Simulate dev mode unless explicitly tested otherwise
    path = get_whispercpp_executable()
    if path:
        print(f"RESULT: Found at {path}")
    else:
        print("RESULT: NOT FOUND")
    print("--- DEBUG END ---\n")
