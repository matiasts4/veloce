import sounddevice as sd
import numpy as np

print("Testing microphone...")
def callback(indata, frames, time, status):
    if status: print(f"Status: {status}")
    volume_norm = np.linalg.norm(indata)*10
    print(f"Volume: {volume_norm:.2f}")

try:
    with sd.InputStream(channels=1, samplerate=16000, callback=callback):
        sd.sleep(3000)
    print("Test finished.")
except Exception as e:
    print(f"Error: {e}")
