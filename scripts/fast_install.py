import sys
import subprocess
import os
import shutil
from pathlib import Path
import time

def get_project_root():
    return Path(__file__).resolve().parent.parent

def run_command(command, cwd=None, env=None):
    try:
        subprocess.check_call(command, cwd=cwd, env=env)
        return True
    except subprocess.CalledProcessError:
        return False

def install_uv():
    print("Checking for uv...")
    if shutil.which("uv"):
        print("uv is already installed.")
        return True
    
    print("Installing uv for faster builds...")
    try:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "uv"])
        return True
    except Exception as e:
        print(f"Failed to install uv: {e}")
        return False

def main():
    root = get_project_root()
    requirements_file = root / "python" / "requirements.txt"
    
    if not requirements_file.exists():
        print(f"Error: {requirements_file} not found.")
        sys.exit(1)

    print("=== Veloce Fast Installer ===")
    start_time = time.time()
    
    has_uv = install_uv()
    
    env = os.environ.copy()
    # Ensure we install to the current environment
    
    if has_uv:
        print(f"Installing dependencies from {requirements_file.name} using uv...")
        # uv pip install -r requirements.txt --system (since we are likely in a venv or want system install for the engine)
        # Note: 'uv pip install' requires a virtual environment active or --system/--python
        cmd = ["uv", "pip", "install", "-r", str(requirements_file), "--system"]
        if not run_command(cmd, cwd=str(root)):
             print("uv failed, falling back to standard pip...")
             run_command([sys.executable, "-m", "pip", "install", "-r", str(requirements_file)], cwd=str(root))
    else:
        print(f"Installing dependencies from {requirements_file.name} using pip...")
        run_command([sys.executable, "-m", "pip", "install", "-r", str(requirements_file)], cwd=str(root))

    duration = time.time() - start_time
    print(f"=== Installation Complete in {duration:.2f} seconds ===")

if __name__ == "__main__":
    main()
