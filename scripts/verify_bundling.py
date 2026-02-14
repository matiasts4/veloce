import sys
from pathlib import Path

# Add python dir to path
project_root = Path(__file__).parent.parent
sys.path.append(str(project_root / "python"))

try:
    from audio_engine import get_whispercpp_executable, get_whispercpp_model_dir, find_whispercpp_model_file
    
    print(f"Project Root (from audio_engine): {project_root}")
    
    expected_exe = project_root / "src-tauri" / "resources" / "whispercpp" / "whisper-cli.exe"
    print(f"Expected Executable Path: {expected_exe}")
    print(f"Expected Executable Exists: {expected_exe.exists()}")
    
    expected_model = project_root / "src-tauri" / "resources" / "models" / "ggml-large-v3-turbo.bin"
    print(f"Expected Model Path: {expected_model}")
    print(f"Expected Model Exists: {expected_model.exists()}")

    exe = get_whispercpp_executable()
    print(f"Found Whisper Executable: {exe}")
    if exe and exe.exists():
        print("✅ Executable found")
    else:
        print("❌ Executable NOT found")
        
    model_dir = get_whispercpp_model_dir()
    print(f"Found Model Directory: {model_dir}")
    if model_dir and model_dir.exists():
        print("✅ Model Directory found")
    else:
        print("❌ Model Directory NOT found")

        
    model_path, model_name = find_whispercpp_model_file("large-v3-turbo")
    print(f"Model File (large-v3-turbo): {model_path}")
    if model_path and model_path.exists():
        print("✅ Model File found")
    else:
        print("❌ Model File NOT found")

except ImportError as e:
    print(f"Import Error: {e}")
    print("Make sure requirements are installed.")
except Exception as e:
    print(f"Error: {e}")
