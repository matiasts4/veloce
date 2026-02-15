import wave
import struct
import math

# Create a simple 16kHz, 16-bit mono 1-second WAV file with a beep
# This is enough to verify that the audio library can open a file.
sample_rate = 16000
duration = 1.0  # seconds
frequency = 440.0  # Hz

with wave.open('tests/assets/test_audio.wav', 'w') as f:
    f.setnchannels(1)
    f.setsampwidth(2)
    f.setframerate(sample_rate)
    for i in range(int(sample_rate * duration)):
        value = int(32767.0 * math.sin(2.0 * math.pi * frequency * i / sample_rate))
        data = struct.pack('<h', value)
        f.writeframesraw(data)

print("Generated tests/assets/test_audio.wav")
