import subprocess
import time
import json
import sys
import os
from pathlib import Path

def main():
    engine_path = Path("c:/Users/PC/veloce/python/audio_engine.py")
    python_exe = Path("c:/Users/PC/veloce/.venv/Scripts/python.exe")

    if not python_exe.exists():
        print(f"Error: Python executable not found at {python_exe}")
        # Try system python or just "python"
        python_exe = "python"

    print(f"Launching {engine_path} with {python_exe}...")
    
    # Set environment variables if needed
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"

    process = subprocess.Popen(
        [str(python_exe), str(engine_path)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        text=True,
        bufsize=1
    )

    def read_stdout():
        for line in process.stdout:
            print(f"ENGINE: {line.strip()}")

    import threading
    threading.Thread(target=read_stdout, daemon=True).start()

    def read_stderr():
        for line in process.stderr:
            print(f"STDERR: {line.strip()}")
            
    threading.Thread(target=read_stderr, daemon=True).start()

    try:
        # 1. Wait for initial hardware info
        time.sleep(2)

        # 2. Configure (simulate app startup)
        config = {
            "microphone": "default",
            "model": "large-v3-turbo",
            "language": "es",
            "gpu_enabled": True,
            "backend": "auto"
        }
        print(f"Sending CONFIG: {config}")
        process.stdin.write(f"CONFIG {json.dumps(config)}\n")
        process.stdin.flush()
        time.sleep(2)

        # 3. Start Recording
        print("Sending START")
        process.stdin.write("START\n")
        process.stdin.flush()
        
        print("Recording for 5 seconds...")
        time.sleep(5)

        # 4. Stop Recording
        print("Sending STOP")
        process.stdin.write("STOP\n")
        process.stdin.flush()
        time.sleep(1)

        # 5. Check if it crashed
        if process.poll() is not None:
            print(f"Engine process exited with code {process.returncode}")
        else:
            print("Engine still running. Killing...")
            process.terminate()
            
    except Exception as e:
        print(f"Error during reproduction: {e}")
    finally:
        if process.poll() is None:
            process.terminate()

if __name__ == "__main__":
    main()
