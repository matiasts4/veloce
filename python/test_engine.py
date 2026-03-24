import os
import subprocess
import time
import sys

def main():
    engine_path = os.path.join(os.path.dirname(__file__), "audio_engine.py")
    print(f"Starting audio engine at {engine_path}")
    
    # Let faster-whisper download large-v3-turbo automatically on first transcription
    p = subprocess.Popen([sys.executable, engine_path], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    
    # Wait a bit for it to init and import everything
    print("Waiting for imports and initialization...")
    time.sleep(5)
    
    print("Sending START command...")
    # Send configuration over stdin if needed by the app, but START is enough usually
    p.stdin.write('{"command":"START", "language":"es", "model":"large-v3-turbo"}\n')
    p.stdin.flush()
    
    print("Listening for 2 minutes (allowing time for model download). Speak into your microphone!")
    start_time = time.time()
    
    while time.time() - start_time < 120:
        line = p.stdout.readline()
        if line:
            print(f"[ENGINE]: {line.strip()}")
            
    print("Sending EXIT command...")
    p.stdin.write('{"command":"EXIT"}\n')
    p.stdin.flush()
    p.wait()
    print("Test finished.")

if __name__ == "__main__":
    main()
