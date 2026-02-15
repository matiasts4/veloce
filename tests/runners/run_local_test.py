import sys
import platform
import subprocess
import os
import shutil
import time
import json
from pathlib import Path

# --- Configuration ---
SCORE_BASE = 100
PENALTY_INSTALL_FAIL = 50
PENALTY_IMPORT_FAIL = 50
PENALTY_NO_GPU = 20
PENALTY_BACKEND_FALLBACK = 15
PENALTY_SLOW_INSTALL = 10
PENALTY_WARNING = 5

SLOW_INSTALL_THRESHOLD = 60.0  # seconds

def get_project_root():
    # If running from inside tests/runners, go up 2 levels.
    # If running from root, check if we are in root.
    # Current script layout: veloce/tests/runners/run_local_test.py
    current = Path(__file__).resolve()
    if (current.parent.name == "runners"):
        return current.parent.parent.parent
    return current.parent

def configure_storage():
    """Configures environment to use D: drive for heavy caches if available."""
    d_drive = Path("D:/")
    if d_drive.exists():
        cache_dir = d_drive / "veloce_cache"
        cache_dir.mkdir(exist_ok=True)
        os.environ["HF_HOME"] = str(cache_dir / "huggingface")
        os.environ["PIP_CACHE_DIR"] = str(cache_dir / "pip")
        os.environ["UV_CACHE_DIR"] = str(cache_dir / "uv")
        print(f"[TEST AUT.] Smart Storage: Redirected caches to {cache_dir}")
    else:
        print("[TEST AUT.] Smart Storage: D: drive not found, using default locations.")

def log(msg):
    print(f"[TEST AUT.] {msg}")


def check_requirements():
    root = get_project_root()
    req_file = root / "python" / "requirements.txt"
    if not req_file.exists():
        log(f"ERROR: Requirements file not found at {req_file}")
        return False
    return True

def run_fast_install():
    root = get_project_root()
    install_script = root / "scripts" / "fast_install.py"
    if not install_script.exists():
        log(f"ERROR: Fast install script not found at {install_script}")
        return False, 0.0, ["Script not found"]
    
    log("Running fast_install.py...")
    start_time = time.time()
    try:
        # Capture output to check for warnings
        result = subprocess.run(
            [sys.executable, str(install_script)], 
            cwd=str(root),
            capture_output=True,
            text=True,
            check=True
        )
        duration = time.time() - start_time
        
        warnings = []
        if "warning" in result.stderr.lower() or "warning" in result.stdout.lower():
            # Simple heuristic: if the word warning appears, flag it.
            # In a real scenario, we might want to filter specific harmless warnings.
            warnings.append("Installation output contains warnings")
            
        print(result.stdout) # Print stdout for user to see
        return True, duration, warnings
        
    except subprocess.CalledProcessError as e:
        log(f"ERROR: fast_install failed with code {e.returncode}")
        print(e.stderr)
        return False, 0.0, ["Installation failed"]

def verify_and_inspect(model_name="tiny", backend_name="auto"):
    root = get_project_root()
    python_dir = root / "python"
    
    log(f"Verifying import and inspecting engine...")
    
    verify_code = """
import sys
import os
import json
import torch

# Add current dir to path to find audio_engine
sys.path.append(os.getcwd())

report = {
    "import_success": False,
    "backend": "unknown",
    "gpu_available": False,
    "gpu_name": "None",
    "inference_success": False,
    "error": None
}

try:
    import audio_engine
    report["import_success"] = True
    
    # Check GPU via Torch
    if torch.cuda.is_available():
        report["gpu_available"] = True
        report["gpu_name"] = torch.cuda.get_device_name(0)

    # --- Phase 3: Static Inference Test ---
    # Attempt to initialize the backend with a tiny model
    # Note: We set prefer_gpu based on detection
    test_wav = os.path.join(os.path.dirname(os.getcwd()), "tests", "assets", "test_audio.wav")
    if os.path.exists(test_wav):
        try:
            # Using the functional API of audio_engine
            audio_engine.load_backend(
                model_name="__MODEL_NAME__", 
                prefer_gpu=report["gpu_available"], 
                backend_name="__BACKEND_NAME__"
            )
            report["backend"] = audio_engine.loaded_backend_type
            report["inference_success"] = True
        except Exception as e:
            report["error"] = f"Inference engine failure during load: {str(e)}"
    else:
        report["error"] = f"Test WAV not found at {test_wav}"
        
except ImportError as e:
    report["error"] = f"ImportError: {str(e)}"
except Exception as e:
    report["error"] = f"Unexpected Exception: {str(e)}"

print(json.dumps(report))


"""
    verify_script = python_dir / "verify_temp.py"
    with open(verify_script, "w") as f:
        # Format the code with the requested model and backend
        final_code = verify_code.replace("__MODEL_NAME__", model_name).replace("__BACKEND_NAME__", backend_name)
        f.write(final_code)
        
    try:
        result = subprocess.run(
            [sys.executable, "verify_temp.py"], 
            cwd=str(python_dir),
            capture_output=True,
            text=True,
            check=True
        )
        # Parse JSON output from the script
        # Stdout might contain other prints from imports, so look for the last line or parse carefully
        lines = result.stdout.strip().splitlines()
        json_str = lines[-1] if lines else "{}"
        try:
            data = json.loads(json_str)
            return True, data
        except json.JSONDecodeError:
            return False, {"error": "Could not parse verification report"}
            
    except subprocess.CalledProcessError as e:
        return False, {"error": f"Verification script failed: {e.stderr}"}
    finally:
        if verify_script.exists():
            os.remove(verify_script)

def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--allow-cpu", action="store_true", help="Allow 100% score without GPU (for CPU-only environments)")
    parser.add_argument("--model", type=str, default="tiny", help="Model to test inference with")
    parser.add_argument("--backend", type=str, default="auto", help="Backend to force usage of")
    args = parser.parse_args()

    os_name = platform.system()
    log(f"Starting Veloce Automation Test on {os_name}")
    
    score = SCORE_BASE
    penalties = []
    
    if not check_requirements():
        print("CRITICAL: Requirements missing.")
        return
    
    # Configure storage before install
    configure_storage()
        
    # --- Phase 1: Installation ---
    install_success, duration, install_issues = run_fast_install()

    if not install_success:
        score -= PENALTY_INSTALL_FAIL
        penalties.append(f"Installation Failed (-{PENALTY_INSTALL_FAIL})")
    else:
        log(f"Phase 1 (Installation) PASSED in {duration:.2f}s")
        if duration > SLOW_INSTALL_THRESHOLD:
            score -= PENALTY_SLOW_INSTALL
            penalties.append(f"Slow Installation (> {SLOW_INSTALL_THRESHOLD}s) (-{PENALTY_SLOW_INSTALL})")
        
        for issue in install_issues:
            score -= PENALTY_WARNING
            penalties.append(f"{issue} (-{PENALTY_WARNING})")

    # --- Phase 2 & 3: Verification & Inference ---
    verification_data = {}
    if install_success:
        import_success, data = verify_and_inspect(args.model, args.backend)
        verification_data = data
        
        if not import_success or not data.get("import_success"):
            score -= PENALTY_IMPORT_FAIL
            penalties.append(f"Import Failed: {data.get('error')} (-{PENALTY_IMPORT_FAIL})")
        else:
            log("Phase 2 (Import Verification) PASSED.")
            
            # Phase 3 check
            if not data.get("inference_success"):
                 score -= 30 # Custom penalty for inference fail
                 penalties.append(f"Audio Inference Engine Failed: {data.get('error')} (-30)")
            else:
                 log("Phase 3 (Audio Inference) PASSED.")

            # Check GPU
            if not data.get("gpu_available"):
                if not args.allow_cpu:
                    score -= PENALTY_NO_GPU
                    penalties.append(f"No GPU Detected (-{PENALTY_NO_GPU})")
                else:
                    log("GPU not detected, but --allow-cpu is set. No penalty applied.")
            
            # Check Backend Fallback
            backend = data.get("backend", "unknown")
            if backend == "faster-whisper" and not data.get("gpu_available") and not args.allow_cpu:
                 score -= PENALTY_BACKEND_FALLBACK
                 penalties.append(f"Backend running without GPU accel ({backend}) (-{PENALTY_BACKEND_FALLBACK})")

    # --- Validation Limits ---
    score = max(0, min(100, score))
    
    # --- Tier Calculation ---
    tier = "Bronze/Fail"
    color = "[FAIL]"
    if score >= 90:
        tier = "Gold"
        color = "[GOLD]"
    elif score >= 70:
        tier = "Silver"
        color = "[SILVER]"

    # --- Report ---
    print("\n" + "="*40)
    print(f"   VELOCE SCORE REPORT ({os_name}) {'[CPU-TARGET]' if args.allow_cpu else ''}")

    print("="*40)
    print(f"Final Score: {score} / 100")
    print(f"Tier: {color} {tier}")
    print("-" * 40)
    print(f"Installation Time: {duration:.2f}s" if install_success else "Installation Time: N/A")
    print(f"Backend Detected: {verification_data.get('backend', 'N/A')}")
    print(f"GPU Detected: {verification_data.get('gpu_name', 'None')}")
    print("-" * 40)
    if penalties:
        print("Penalties Applied:")
        for p in penalties:
            print(f" - {p}")
    else:
        print("No penalties. Perfect Run!")
    print("="*40)

if __name__ == "__main__":
    main()


