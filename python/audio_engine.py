import sys
import json
import time
import threading
import queue
import gc
import warnings
import numpy as np
import sounddevice as sd
from faster_whisper import WhisperModel
from huggingface_hub import HfApi, snapshot_download
from tqdm.auto import tqdm
import torch
import os
from pathlib import Path

# Configuration
CHANNELS = 1
RATE = 16000
CHUNK = 512
SILENCE_THRESHOLD = 0.018  # RMS threshold in normalized float audio
SILENCE_DURATION = 0.45    # Seconds of silence to trigger segmented transcription
MAX_BUFFER_SECONDS = 20  # Prevent huge allocations on long recordings

# Globals
recording = False
current_recording_id = 0
audio_queue = queue.Queue()
selected_device = None
selected_model = "large-v3-turbo"
selected_language = "es"
gpu_enabled = True
current_stream = None
model_whisper = None
model_lock = threading.Lock()
download_lock = threading.Lock()
model_load_lock = threading.Lock()

# Reduce CPU thread pressure to avoid MKL/OMP memory spikes on Windows.
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

warnings.filterwarnings("ignore", message=r".*huggingface_hub.*symlinks.*")
warnings.filterwarnings("ignore", message=r".*HF Hub.*")


SUPPORTED_MODELS = ["tiny", "base", "small", "medium", "large-v3", "large-v3-turbo", "distil-large-v3", "voxtral-mini-4b-realtime-2602"]
MODEL_REPOS = {
    "tiny": "Systran/faster-whisper-tiny",
    "base": "Systran/faster-whisper-base",
    "small": "Systran/faster-whisper-small",
    "medium": "Systran/faster-whisper-medium",
    "large-v3": "Systran/faster-whisper-large-v3",
    "large-v3-turbo": "Systran/faster-whisper-large-v3-turbo",
    "distil-large-v3": "distil-whisper/distil-large-v3",
}


def model_repo_id(model_name):
    return MODEL_REPOS.get(model_name, f"Systran/faster-whisper-{model_name}")


def model_repo_candidates(model_name):
    # Distil must download from distil-whisper; fallback to large-v3 would be a different model.
    if model_name == "distil-large-v3":
        return ["distil-whisper/distil-large-v3"]
    return [model_repo_id(model_name)]


def emit(payload):
    print(json.dumps(payload))
    sys.stdout.flush()


def has_valid_model_snapshot(repo_dir: Path) -> bool:
    snapshots_dir = repo_dir / "snapshots"
    if not snapshots_dir.exists() or not snapshots_dir.is_dir():
        return False

    model_indicators = {
        "model.bin",
        "model.safetensors",
        "consolidated.safetensors",
        "config.json",
        "tokenizer.json",
        "params.json",
    }
    for snapshot in snapshots_dir.iterdir():
        if not snapshot.is_dir():
            continue
        present = {p.name for p in snapshot.iterdir() if p.is_file()}
        if any(name in present for name in model_indicators):
            return True
    return False

def get_downloaded_models():
    """Scan HuggingFace cache for downloaded Whisper models."""
    models = []
    # Default HF cache paths (Linux/macOS and Windows)
    home = Path.home()
    candidates = [
        home / ".cache" / "huggingface" / "hub",
        home / "AppData" / "Local" / "huggingface" / "hub",
    ]

    hf_home = os.environ.get("HF_HOME")
    if hf_home:
        candidates.insert(0, Path(hf_home) / "hub")
    
    cache_dir = next((p for p in candidates if p.exists()), None)
    if cache_dir is None:
        return []

    supported_set = set(SUPPORTED_MODELS)
    repo_to_model = {
        "models--Systran--faster-whisper-tiny": "tiny",
        "models--Systran--faster-whisper-base": "base",
        "models--Systran--faster-whisper-small": "small",
        "models--Systran--faster-whisper-medium": "medium",
        "models--Systran--faster-whisper-large-v3": "large-v3",
        "models--Systran--faster-whisper-large-v3-turbo": "large-v3-turbo",
        "models--openai--whisper-large-v3-turbo": "large-v3-turbo",
        "models--distil-whisper--distil-large-v3": "distil-large-v3",
        "models--mistralai--Voxtral-Mini-4B-Realtime-2602": "voxtral-mini-4b-realtime-2602",
    }
    
    try:
        for item in cache_dir.iterdir():
            if not item.is_dir():
                continue

            model_name = repo_to_model.get(item.name)
            if not model_name and item.name.startswith("models--Systran--faster-whisper-"):
                model_name = item.name.replace("models--Systran--faster-whisper-", "")

            if model_name and model_name in supported_set and has_valid_model_snapshot(item):
                models.append({
                    "id": model_name,
                    "name": model_name.replace("-", " ").title(),
                    "downloaded": True
                })
    except Exception:
        pass

    models.sort(key=lambda model: model["id"])
    return models

def get_hardware_info():
    """Fetch available microphones and GPU status."""
    devices = []
    try:
        all_devices = sd.query_devices()
        default_device = sd.default.device
        default_input = default_device[0] if isinstance(default_device, (list, tuple)) else None
        
        for i, dev in enumerate(all_devices):
            if dev.get('max_input_channels', 0) > 0:
                name = dev.get('name', f"Device {i}")
                if i == default_input:
                    name = f"{name} (Default)"
                    
                devices.append({
                    "id": i,
                    "name": name,
                    "host_api": dev.get('hostapi')
                })
    except Exception as e:
        devices = [{"id": -1, "name": f"Error: {e}", "host_api": -1}]
    
    gpu_available = torch.cuda.is_available()
    gpu_name = torch.cuda.get_device_name(0) if gpu_available else "None"
    
    models = get_downloaded_models()

    # Always expose selectable models; downloaded models are marked in the name.
    fallback_models = [
        {"id": "tiny", "name": "Tiny", "downloaded": False},
        {"id": "base", "name": "Base", "downloaded": False},
        {"id": "small", "name": "Small", "downloaded": False},
        {"id": "medium", "name": "Medium", "downloaded": False},
        {"id": "large-v3", "name": "Large V3", "downloaded": False},
        {"id": "large-v3-turbo", "name": "Large V3 Turbo", "downloaded": False},
        {"id": "distil-large-v3", "name": "Distil Large V3", "downloaded": False}
    ]

    merged_models = {m["id"]: m for m in fallback_models}
    for model in models:
        merged_models[model["id"]] = model
    
    return {
        "type": "hardware-info",
        "microphones": devices,
        "gpu": {
            "available": gpu_available,
            "name": gpu_name
        },
        "models": sorted(list(merged_models.values()), key=lambda model: model["id"])
    }


def load_whisper(model_name, prefer_gpu):
    global model_whisper
    device = "cuda" if (prefer_gpu and torch.cuda.is_available()) else "cpu"
    compute_type = "float16" if device == "cuda" else "int8"

    emit({"status": "loading_model"})

    model_load_lock.acquire()

    try:
        with model_lock:
            previous_model = model_whisper
            model_whisper = None

        if previous_model is not None:
            del previous_model
            gc.collect()

        loaded = WhisperModel(model_name, device=device, compute_type=compute_type)
        with model_lock:
            model_whisper = loaded
        emit({"status": "ready"})
        emit({"log": f"Model loaded: {model_name} on {device}"})
        return model_name
    except Exception as e:
        emit({"error": f"Whisper Load Error ({model_name}): {e}"})

        # Safe fallback to tiny on CPU for low-memory machines.
        if model_name != "tiny":
            try:
                fallback = WhisperModel("tiny", device="cpu", compute_type="int8")
                with model_lock:
                    model_whisper = fallback
                emit({"status": "ready"})
                emit({"log": "Fallback model loaded: tiny on cpu"})
                return "tiny"
            except Exception as fallback_error:
                emit({"error": f"Fallback Whisper Load Error (tiny): {fallback_error}"})

        return ""
    finally:
        model_load_lock.release()


def load_whisper_async(model_name, prefer_gpu):
    def _run():
        active_model = load_whisper(model_name, prefer_gpu)
        if active_model and active_model != model_name:
            emit({"log": f"Active model adjusted to: {active_model}"})

    threading.Thread(target=_run, daemon=True).start()


def download_model_to_cache(model_name):
    if not download_lock.acquire(blocking=False):
        emit({"error": "Another model download is already in progress"})
        return

    emit({"log": f"Downloading model: {model_name}"})
    emit({"type": "model-download-progress", "model": model_name, "progress": 0})

    try:
        api = HfApi()
        last_error = None
        downloaded = False

        for repo_id in model_repo_candidates(model_name):
            try:
                files = api.list_repo_files(repo_id=repo_id, repo_type="model")
                if not files:
                    raise RuntimeError(f"No files found for repo {repo_id}")

                class EmitTqdm(tqdm):
                    def __init__(self, *args, **kwargs):
                        super().__init__(*args, **kwargs)
                        self._last_progress = -1

                    def _emit_progress(self):
                        if self.total and self.total > 0:
                            progress = int((self.n / self.total) * 100)
                            if progress != self._last_progress:
                                self._last_progress = progress
                                emit({"type": "model-download-progress", "model": model_name, "progress": progress})

                    def update(self, n=1):
                        result = super().update(n)
                        self._emit_progress()
                        return result

                    def refresh(self, *args, **kwargs):
                        result = super().refresh(*args, **kwargs)
                        self._emit_progress()
                        return result

                snapshot_download(
                    repo_id=repo_id,
                    repo_type="model",
                    local_files_only=False,
                    max_workers=1,
                    tqdm_class=EmitTqdm,
                )

                emit({"type": "model-download-progress", "model": model_name, "progress": 100})

                emit({"log": f"Model source used: {repo_id}"})
                downloaded = True
                break
            except Exception as repo_error:
                last_error = repo_error

        if not downloaded:
            raise RuntimeError(str(last_error) if last_error else "unknown download error")

        emit({"type": "model-download-progress", "model": model_name, "progress": 100})
        emit({"log": f"Model downloaded: {model_name}"})

        downloaded_now = any(model.get("id") == model_name and model.get("downloaded", False) for model in get_hardware_info().get("models", []))
        if downloaded_now:
            emit({"log": f"Download verification passed: {model_name}"})
            if model_name == selected_model:
                active_model = load_whisper(selected_model, gpu_enabled)
                if active_model and active_model != selected_model:
                    emit({"error": f"Selected model unavailable after download; using {active_model}"})
        else:
            emit({"error": f"Download verification failed: {model_name}"})
    except Exception as e:
        emit({"error": f"Model download failed ({model_name}): {e}"})
        emit({"type": "model-download-progress", "model": model_name, "progress": 0})
    finally:
        emit(get_hardware_info())
        download_lock.release()


def start_input_stream(device_id):
    global current_stream

    def audio_callback(indata, frames, callback_time, status):
        if status:
            return
        if recording:
            audio_queue.put(indata.copy())

    if current_stream is not None:
        try:
            current_stream.stop()
            current_stream.close()
        except Exception:
            pass

    kwargs = {
        "callback": audio_callback,
        "channels": CHANNELS,
        "samplerate": RATE,
        "blocksize": CHUNK,
        "dtype": "int16",
    }
    if device_id is not None:
        kwargs["device"] = device_id

    current_stream = sd.InputStream(**kwargs)
    current_stream.start()

def main():
    # Emit hardware info immediately
    emit(get_hardware_info())
    load_whisper(selected_model, gpu_enabled)

    # Command listener thread
    threading.Thread(target=command_listener, daemon=True).start()

    emit({"log": "Audio engine started"})

    buffer = []
    buffered_frames = 0
    max_frames = RATE * MAX_BUFFER_SECONDS
    silence_seconds = 0.0
    
    while True:
        try:
            if not audio_queue.empty():
                audio_chunk = audio_queue.get()
                buffer.append(audio_chunk)
                buffered_frames += int(audio_chunk.shape[0])

                # While recording, detect silence and transcribe in segments for near real-time feedback.
                if recording:
                    chunk_float = audio_chunk.astype(np.float32) / 32768.0
                    if chunk_float.ndim > 1:
                        chunk_float = chunk_float[:, 0]
                    rms = float(np.sqrt(np.mean(np.square(chunk_float)))) if chunk_float.size else 0.0
                    chunk_seconds = float(audio_chunk.shape[0]) / float(RATE)

                    if rms < SILENCE_THRESHOLD:
                        silence_seconds += chunk_seconds
                    else:
                        silence_seconds = 0.0

                    enough_audio = buffered_frames >= int(RATE * 0.45)
                    if enough_audio and silence_seconds >= SILENCE_DURATION:
                        emit({"status": "transcribing"})
                        transcribe(buffer)
                        emit({"status": "recording"})
                        buffer = []
                        buffered_frames = 0
                        silence_seconds = 0.0
                        continue

                while buffered_frames > max_frames and buffer:
                    removed = buffer.pop(0)
                    buffered_frames -= int(removed.shape[0])
            
            # If stopped recording but buffer has content, transcribe
            if not recording and len(buffer) > 0:
                emit({"status": "transcribing"})
                transcribe(buffer)
                emit({"status": "ready"})
                buffer = []
                buffered_frames = 0
                silence_seconds = 0.0
                # Clear queue to avoid processing stale audio
                with audio_queue.mutex:
                    audio_queue.queue.clear()
            
            else:
                time.sleep(0.01)

        except Exception as e:
            emit({"error": str(e)})
            time.sleep(0.1)

def transcribe(buffer):
    global current_recording_id
    if not buffer:
        return

    # sounddevice with CHANNELS=1 yields shape (frames, 1); flatten to mono 1D
    audio_data = np.concatenate(buffer, axis=0)
    if audio_data.ndim > 1:
        audio_data = audio_data[:, 0]

    # Convert to float32 for Whisper
    audio_float32 = audio_data.astype(np.float32) / 32768.0
    audio_float32 = np.ascontiguousarray(audio_float32.reshape(-1))

    # Light preprocessing for better quality on fast models:
    # - DC offset removal
    # - light pre-emphasis (helps consonants)
    # - peak normalization
    audio_float32 = audio_float32 - float(np.mean(audio_float32))
    if audio_float32.size > 1:
        emphasized = np.empty_like(audio_float32)
        emphasized[0] = audio_float32[0]
        emphasized[1:] = audio_float32[1:] - 0.95 * audio_float32[:-1]
        audio_float32 = emphasized
    peak = float(np.max(np.abs(audio_float32))) if audio_float32.size else 0.0
    if peak > 0:
        audio_float32 = audio_float32 / peak * 0.98

    if audio_float32.size < int(RATE * 0.25):
        return

    with model_lock:
        model = model_whisper
    if model is None:
        emit({"error": "Model not loaded"})
        return

    language = None if selected_language == "auto" else selected_language
    started_at = time.perf_counter()

    try:
        beam_size = 2 if selected_model in {"tiny", "base"} else 1
        segments, info = model.transcribe(
            audio_float32,
            beam_size=beam_size,
            vad_filter=True,
            language=language,
            task="transcribe",
        )
    except MemoryError:
        emit({"error": "Not enough memory to transcribe the captured audio"})
        return
    except Exception as e:
        emit({"error": str(e)})
        return
    
    text = " ".join([segment.text for segment in segments]).strip()
    elapsed_ms = (time.perf_counter() - started_at) * 1000.0
    
    if text:
        emit({"transcription": text, "response_ms": elapsed_ms, "recording_id": current_recording_id})

def command_listener():
    global recording, selected_device, selected_model, selected_language, gpu_enabled, current_recording_id
    for line in sys.stdin:
        line = line.strip()
        if line == "START":
            with model_lock:
                model_ready = model_whisper is not None

            if not model_ready:
                active_model = load_whisper(selected_model, gpu_enabled)
                if not active_model:
                    emit({"error": "No model is ready. Download a compatible model and refresh hardware."})
                    emit({"status": "stopped"})
                    continue

            try:
                start_input_stream(selected_device)
            except Exception as e:
                emit({"error": f"Audio Stream Error: {e}"})
                continue
            current_recording_id += 1
            recording = True
            emit({"status": "recording"})
        elif line == "STOP":
            recording = False
            emit({"status": "stopped"})
        elif line == "HARDWARE":
            emit(get_hardware_info())
        elif line.startswith("CONFIG "):
            try:
                payload = json.loads(line[len("CONFIG "):])
                microphone = str(payload.get("microphone", "default"))
                model = str(payload.get("model", selected_model))
                language = str(payload.get("language", selected_language))
                prefer_gpu = bool(payload.get("gpu_enabled", gpu_enabled))

                selected_device = None if microphone == "default" else int(microphone)

                if model == "voxtral-mini-4b-realtime-2602":
                    emit({"error": "Voxtral requiere runtime vLLM + GPU (CUDA o ROCm). En Windows esta app no lo ejecuta de forma nativa; usa Linux/WSL con backend GPU compatible. No es compatible con faster-whisper en esta app."})
                    model = selected_model

                model_changed = model != selected_model
                gpu_changed = prefer_gpu != gpu_enabled
                selected_language = language
                gpu_enabled = prefer_gpu

                if model_changed or gpu_changed:
                    selected_model = model
                    load_whisper_async(selected_model, gpu_enabled)
                else:
                    selected_model = model

                emit({"log": f"Engine config updated: mic={microphone}, model={selected_model}, language={selected_language}, gpu={gpu_enabled}"})
            except Exception as e:
                emit({"error": f"Invalid CONFIG payload: {e}"})
        elif line.startswith("DOWNLOAD "):
            model_name = line[len("DOWNLOAD "):].strip()
            if model_name:
                threading.Thread(target=download_model_to_cache, args=(model_name,), daemon=True).start()
            else:
                emit({"error": "DOWNLOAD command missing model name"})

if __name__ == "__main__":
    main()
