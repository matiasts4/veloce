import sounddevice as sd
import numpy as np

def callback(indata, frames, time, status):
    chunk_np = indata.copy().astype(np.float32)
    rms = float(np.sqrt(np.mean(chunk_np ** 2)))
    print(f"RMS: {rms:.2f}")

try:
    with sd.InputStream(channels=1, samplerate=16000, dtype="int16", callback=callback):
        sd.sleep(3000)
except Exception as e:
    print(e)
