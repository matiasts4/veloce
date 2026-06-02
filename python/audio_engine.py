import sys
import json
import time
import threading
import queue
import gc
import warnings
import tempfile
import subprocess
import wave
import uuid
import re
import urllib.request
import urllib.error
import io
import os
from pathlib import Path
from collections import deque


def configure_windows_cuda_dll_paths():
    if os.name != "nt":
        return

    site_packages_root = Path(sys.executable).parent / "Lib" / "site-packages"
    candidates = [
        site_packages_root / "torch" / "lib",
        site_packages_root / "nvidia" / "cublas" / "bin",
        site_packages_root / "nvidia" / "cudnn" / "bin",
        site_packages_root / "nvidia" / "cuda_runtime" / "bin",
        site_packages_root / "nvidia" / "cuda_nvrtc" / "bin",
    ]

    for dll_dir in candidates:
        try:
            if dll_dir.exists() and dll_dir.is_dir():
                os.add_dll_directory(str(dll_dir))
        except Exception:
            pass


configure_windows_cuda_dll_paths()

import numpy as np
import sounddevice as sd
from queue import Queue, Empty
from faster_whisper import WhisperModel
from huggingface_hub import HfApi, snapshot_download
from tqdm.auto import tqdm
import torch
import torchaudio
import logging
import datetime
import atexit
import signal

# Clean up any orphaned whisper-server processes from previous ungraceful exits
try:
    subprocess.run(
        ["taskkill", "/F", "/IM", "whisper-server.exe"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
        shell=True
    )
except Exception:
    pass

# Setup logging
def setup_logging():
    app_data = get_app_data_dir()
    app_data.mkdir(parents=True, exist_ok=True)
    log_file = app_data / "audio_engine_debug.log"
    
    logging.basicConfig(
        filename=str(log_file),
        level=logging.DEBUG,
        format='%(asctime)s - %(levelname)s - %(message)s',
        filemode='w' # Overwrite each run to keep it clean, or 'a' to append
    )
    logging.info(f"Audio Engine Started. PID: {os.getpid()}")
    return log_file


# VAD & Diarization models (lazy loaded)
# NOTE: sklearn and speechbrain are imported lazily inside the methods that use
# them so that the Python process does not pay their import cost (~400MB) at
# startup when diarization is disabled.
vad_model = None
vad_utils = None
diarization_model = None
diarization_pipeline = None

class VADDetector:
    def __init__(self):
        global vad_model, vad_utils
        try:
            # Load Silero VAD from torch hub (force_reload=False to use cache)
            if vad_model is None:
                # Use a specific commit/tag for stability if needed, but 'snakers4/silero-vad' is standard.
                # 'silero_vad' returns model + utils (get_speech_timestamps, save_audio, read_audio, VADIterator, collect_chunks)
                model, utils = torch.hub.load(repo_or_dir='snakers4/silero-vad',
                                              model='silero_vad',
                                              force_reload=False,
                                              onnx=False) # Use PyTorch version for simplicity with existing torch
                vad_model = model
                vad_utils = utils
            
            self.model = vad_model
            self.utils = vad_utils
            self.reset()
            emit({"log": "VAD (Silero) loaded successfully."})
        except Exception as e:
            emit({"error": f"Failed to load VAD model: {e}"})
            self.model = None

    def reset(self):
        if self.model:
            self.model.reset_states()

    def is_speech(self, audio_chunk, sr=16000):
        # 1. Energy Calculation (RMS)
        # Keep thresholds in int16-equivalent scale even if chunk arrives normalized.
        is_float = getattr(audio_chunk, 'dtype', None) in (np.float32, np.float64)
        if isinstance(audio_chunk, np.ndarray):
            chunk_np = audio_chunk.astype(np.float32)
        else:
            chunk_np = np.asarray(audio_chunk, dtype=np.float32)

        peak = float(np.max(np.abs(chunk_np))) if chunk_np.size else 0.0
        
        # If the input was ALREADY floats normalized to [-1, 1], scale to int16 range
        if is_float and peak > 0 and peak <= 1.0:
            chunk_np = chunk_np * 32768.0
            
        rms = float(np.sqrt(np.mean(chunk_np ** 2)))

        # 2. Hard Silence Gate (Noise Floor)
        # If it's barely audible noise, ignore it immediately.
        if rms < 50.0: 
            return False

        # 3. Energy Bypass (Force Speech)
        # If the volume is clearly human speech levels (RMS > 300), 
        # assume it is speech without waiting for the neural model.
        # This fixes the "missing real-time" issue for normal volumes.
        if rms > 300.0:
            return True

        # 4. Neural VAD (Silero) for softer speech (between 50 and 300 RMS)
        if not self.model:
            return True # Fallback: if moderate energy and no model, assume speech

        # Prepare for Silero
        if isinstance(audio_chunk, np.ndarray):
            audio_float = audio_chunk.astype(np.float32)
            if np.max(np.abs(audio_float)) > 1.5:
                audio_float = audio_float / 32768.0
            audio_chunk = torch.from_numpy(audio_float)
        
        if audio_chunk.ndim > 1:
            audio_chunk = audio_chunk.squeeze()
        if audio_chunk.ndim == 1:
            audio_chunk = audio_chunk.unsqueeze(0)

        try:
            if sr != 16000 and sr != 8000:
                sr = 16000
            
            speech_prob = self.model(audio_chunk, sr).item()
            # emit({"log": f"VAD Neural Prob: {speech_prob:.2f}"}) # Debug probability
            return speech_prob > 0.4 # Slightly lower confidence threshold
        except Exception:
            return True # Fail open if moderate energy

class DiarizationManager:
    def __init__(self):
        self.embeddings = []
        self.encoder = None
        self.similarity_threshold = 0.45 # Lower threshold for short segments
        self.next_speaker_id = 1
        self.model_source = "speechbrain/spkrec-ecapa-voxceleb"
        self.lock = threading.Lock()
        
        # Async load
        threading.Thread(target=self._load_model, daemon=True).start()

    def _load_model(self):
        try:
            from speechbrain.inference.speaker import EncoderClassifier  # lazy import
        except Exception as e:
            emit({"log": f"Diarization: SpeechBrain not available or error: {e}"})
            return

        try:
            emit({"log": "Diarization: Loading Speaker Recognition model..."})
            savedir = project_root() / "python" / "models" / "spkrec-ecapa-voxceleb"
            savedir.mkdir(parents=True, exist_ok=True)
            
            # Use GPU if available
            run_opts = {"device": "cuda"} if torch.cuda.is_available() else {"device": "cpu"}

            self.encoder = EncoderClassifier.from_hparams(
                source=self.model_source, 
                savedir=str(savedir),
                run_opts=run_opts
            )
            emit({"log": "Diarization: Model ready."})
        except Exception as e:
            emit({"error": f"Diarization model load failed: {e}"})

    def get_speaker(self, audio_segment, sr=16000):
        if not self.encoder:
            return None
        
        try:
            # Convert to torch tensor
            if isinstance(audio_segment, np.ndarray):
                waveform = torch.from_numpy(audio_segment.astype(np.float32) / 32768.0)
            else:
                waveform = audio_segment
            
            if waveform.ndim > 1:
                waveform = waveform.squeeze()
            
            # Length check (ECAPA needs ~0.1s minimum)
            if waveform.shape[0] < 1600: 
                return None
            
            # Prepare batch (1, N)
            signal = waveform.unsqueeze(0)
            if torch.cuda.is_available():
                signal = signal.to("cuda")

            # Extract embedding
            embeddings = self.encoder.encode_batch(signal)
            emb = embeddings.squeeze().cpu()
            
            # Compare
            best_score = -1.0
            best_id = -1
            
            with self.lock:
                for entry in self.embeddings:
                    score = torch.nn.functional.cosine_similarity(emb, entry["emb"], dim=0).item()
                    if score > best_score:
                        best_score = score
                        best_id = entry["id"]

                if best_score > self.similarity_threshold:
                     return f"Hablante {best_id}"
                else:
                     new_id = self.next_speaker_id
                     self.next_speaker_id += 1
                     self.embeddings.append({"emb": emb, "id": new_id})
                     return f"Hablante {new_id}"

        except Exception:
            return None

# Configuration
CHANNELS = 1
RATE = 16000
CHUNK = 512
SILENCE_THRESHOLD = 0.018  # RMS threshold in normalized float audio
SILENCE_DURATION = 0.45    # Seconds of silence to trigger segmented transcription
MAX_BUFFER_SECONDS = 120  # Prevent huge allocations on very long recordings
PRE_ROLL_SECONDS = 2.2
WHISPERCPP_SERVER_HOST = "127.0.0.1"
WHISPERCPP_SERVER_PORT = 8178
WHISPERCPP_SERVER_HEALTH_TIMEOUT = 30.0

GRATITUDE_PHRASES = [
    "gracias",
    "muchas gracias",
    "un saludo",
    "saludos",
    "gracias por ver",
    "gracias por ver el video",
    "gracias por ver el vídeo",
    "gracias por su atención",
    "gracias a todos",
    "gracias amén",
    "gracias. amén",
    "gracias gracias",
    "amén",
    "y cosas así",
    "y cosas asi",
    "qué es lo que se ha hablado",
    "que es lo que se ha hablado",
    "amen",
    "suscríbete",
    "suscríbete a mi canal",
    "suscríbanse",
    "dale like",
    "hasta la próxima",
    "thank you",
    "thanks",
    "thank you for watching",
]

# Phrases that frequently appear as hallucinated openings/closings in short chunks.
# Keep this list conservative to avoid deleting valid sentence content.
EDGE_HALLUCINATION_PHRASES = [
    "gracias",
    "muchas gracias",
    "un saludo",
    "saludos",
    "gracias a todos",
    "gracias por su atencion",
    "gracias por su atención",
    "hasta la proxima",
    "hasta la próxima",
    "al final",
    "gracias gracias",
    "thank you",
    "thanks",
    # "al canal" family — frequently hallucinated "subscribe to my channel" variants
    # without "mi" or with typos. The Whisper model emits these on near-silence
    # or at the end of recordings where a creator would say "subscribe to the channel".
    "al canal",
    "suscríbete al canal",
    "suscribete al canal",
    "subscribete al canal",
    "suscríbanse al canal",
    "subscribanse al canal",
    "cánal",          # elongated "a" variant
    "al canaal",      # double-elongated
    "al canaaal",     # triple-elongated (just in case)
]

# Globals
word_substitutions: dict[str, str] = {}
recording = False
current_recording_id = 0
session_transcript = ""  # Accumulates all final phrases for the active recording session
stopping = False  # Flag for immediate-stop mode: when True, worker emits "stopped" without draining queue
debug_callback_count = 0
debug_process_count = 0
audio_queue = queue.Queue()
transcription_queue = queue.Queue() # New queue for async processing
selected_device = None
selected_model = "large-v3-turbo"
selected_model_dir = ""
selected_language = "es"
gpu_enabled = True
selected_backend = "auto"
active_backend = "faster-whisper"
current_stream = None
model_whisper = None
loaded_model = ""
loaded_gpu = None
loaded_backend_type = ""
model_lock = threading.Lock()
download_lock = threading.Lock()
model_load_lock = threading.Lock()
whisper_server_lock = threading.Lock()
whisper_server_process = None
whisper_server_model_path = ""
backend_load_lock = threading.Lock()
pre_roll_chunks = deque(maxlen=max(1, int((RATE * PRE_ROLL_SECONDS) / CHUNK)))
pre_roll_lock = threading.Lock()

# Reduce CPU thread pressure to avoid MKL/OMP memory spikes on Windows.
os.environ["OMP_NUM_THREADS"] = "1"
os.environ["MKL_NUM_THREADS"] = "1"
os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"

warnings.filterwarnings("ignore", message=r".*huggingface_hub.*symlinks.*")
warnings.filterwarnings("ignore", message=r".*HF Hub.*")


SUPPORTED_MODELS = ["tiny", "base", "small", "medium", "large-v3", "large-v3-turbo", "distil-large-v3", "voxtral-mini-4b-realtime-2602"]
SUPPORTED_BACKENDS = ["auto", "faster-whisper", "whispercpp"]
WHISPERCPP_FALLBACK_MODELS = ["large-v3-turbo", "large-v3", "medium", "small", "base", "tiny"]
MODEL_REPOS = {
    "tiny": "Systran/faster-whisper-tiny",
    "base": "Systran/faster-whisper-base",
    "small": "Systran/faster-whisper-small",
    "medium": "Systran/faster-whisper-medium",
    "large-v3": "Systran/faster-whisper-large-v3",
    "large-v3-turbo": "deepdml/faster-whisper-large-v3-turbo-ct2",
    "distil-large-v3": "distil-whisper/distil-large-v3",
}


def model_repo_id(model_name):
    return MODEL_REPOS.get(model_name, f"Systran/faster-whisper-{model_name}")


def model_repo_candidates(model_name):
    # Distil must download from distil-whisper; fallback to large-v3 would be a different model.
    if model_name == "distil-large-v3":
        return ["distil-whisper/distil-large-v3"]
    return [model_repo_id(model_name)]


def project_root() -> Path:
    return Path(__file__).resolve().parent.parent


def normalize_backend_name(name: str) -> str:
    normalized = (name or "auto").strip().lower()
    return normalized if normalized in SUPPORTED_BACKENDS else "auto"


def get_exe_ext() -> str:
    return ".exe" if sys.platform.startswith("win") else ""


import ctranslate2

def get_torch_cuda_info() -> dict:
    cuda_available = torch.cuda.is_available()
    
    # Fallback: check ctranslate2 if torch returns False (e.g. missing torch_cuda.dll)
    if not cuda_available:
        try:
            if ctranslate2.get_cuda_device_count() > 0:
                cuda_available = True
        except Exception:
            pass

    info = {
        "cuda_available": cuda_available,
        "torch_version": getattr(torch, "__version__", "unknown"),
        "gpu_name": "None",
        "vram_gb": None,
    }

    if not cuda_available:
        return info

    try:
        info["gpu_name"] = torch.cuda.get_device_name(0)
    except Exception:
        # Try to distinguish if we found it via ctranslate2
        info["gpu_name"] = "CUDA GPU (Detected)"

    try:
        props = torch.cuda.get_device_properties(0)
        info["vram_gb"] = round(float(props.total_memory) / (1024 ** 3), 2)
    except Exception:
        info["vram_gb"] = None

    return info


def choose_faster_whisper_runtime(prefer_gpu: bool) -> tuple[str, str, str]:
    cuda_info = get_torch_cuda_info()
    if prefer_gpu and cuda_info["cuda_available"]:
        # int8_float16 is compatible with all CT2 models (int8, float16, float32)
        # and gives near-float16 speed. Pure float16 fails on int8-quantized models.
        return "cuda", "int8_float16", "cuda"

    if prefer_gpu:
        return "cpu", "int8", "no_cuda"

    return "cpu", "int8", "gpu_disabled"


def get_whispercpp_executable() -> Path | None:
    env_path = os.environ.get("WHISPERCPP_EXE")
    if env_path:
        candidate = Path(env_path)
        if candidate.exists() and candidate.is_file():
            return candidate

    root = project_root()
    ext = get_exe_ext()
    
    # Check for bundled resources in freeze/installer mode
    # Check for bundled resources in freeze/installer mode
    if getattr(sys, 'frozen', False):
        # In frozen mode, sys.executable is the path to the executable (e.g., .../resources/audio-engine.exe)
        exe_path = Path(sys.executable).parent
        
        candidates = [
            # Standard Tauri layout: siblings in the same resources folder
            exe_path / "whispercpp" / f"whisper-cli{ext}",
            # Flat layout (if tauri flattened resources)
            exe_path / f"whisper-cli{ext}", 
            exe_path / "whisper-cli.exe", 
            exe_path / "whispercpp" / "whisper-cli.exe",
            
            exe_path / "whispercpp" / f"main{ext}",
            # Nested layout: sometimes resources are under a 'resources' subfolder
            exe_path / "resources" / "whispercpp" / f"whisper-cli{ext}",
            exe_path / "resources" / "whispercpp" / f"main{ext}",
            # Parent layout: if engine is in a subfolder of resources
            exe_path.parent / "whispercpp" / f"whisper-cli{ext}",
            exe_path.parent / "resources" / "whispercpp" / f"whisper-cli{ext}",
            # App root layout (Windows installer usually flattens or keeps structure)
            exe_path.parent / "resources" / "whispercpp" / f"whisper-cli{ext}",
            exe_path / f"whisper-cli{ext}", # Sibling check
            exe_path / "whisper-cli.exe", 
        ]
        
        emit({"log": f"Frozen mode detected. Sys.exe: {sys.executable}. Exe path: {exe_path}"})
        logging.info(f"Frozen mode detected. Sys.exe: {sys.executable}")
        logging.info(f"Exe path: {exe_path}")

        try:
             # Listing directories for debug
             if exe_path.exists():
                 logging.info(f"Directory contents of {exe_path}: {os.listdir(exe_path)}")
             if (exe_path / "whispercpp").exists():
                 logging.info(f"Contents of whispercpp subdir: {os.listdir(exe_path / 'whispercpp')}")
        except Exception as e:
             logging.error(f"Failed to list directory: {e}")

    else:
        # Dev mode
        exe_path = project_root()
        candidates = [
            project_root() / "src-tauri" / "resources" / "whispercpp" / f"whisper-cli{ext}",
            project_root() / "src-tauri" / "resources" / "whispercpp" / "main.exe",
             # Also check relative to script if distinct
            Path(__file__).parent.parent / "src-tauri" / "resources" / "whispercpp" / f"whisper-cli{ext}"
        ]
        logging.info(f"Dev mode detected. Exe path (root): {exe_path}")

    # 1. Standard candidates check
    for candidate in candidates:
        if candidate.exists() and candidate.is_file():
            logging.info(f"Found whispercpp (standard) at: {candidate}")
            return candidate

    # 2. Recursive search in resources or parent directories
    # This handles unexpected flattening or nesting by Tauri
    try:
        logging.info("Standard paths failed. Attempting recursive search...")
        
        # Define search roots: current dir, parent, and potential resource dirs
        search_roots = [exe_path]
        if exe_path.parent != exe_path:
            search_roots.append(exe_path.parent)
            
        # Add common 'resources' or '_up_' paths seen in Tauri
        extras = ["resources", "_up_", "dist"]
        for extra in extras:
            if (exe_path / extra).exists(): search_roots.append(exe_path / extra)
            if (exe_path.parent / extra).exists(): search_roots.append(exe_path.parent / extra)
        
        # Deduplicate
        search_roots = list(set(search_roots))
        
        for root in search_roots:
            if not root.exists(): continue
            logging.info(f"Searching root: {root}")
            # Walk the tree
            for dirpath, dirnames, filenames in os.walk(root):
                if f"whisper-cli{ext}" in filenames:
                    found = Path(dirpath) / f"whisper-cli{ext}"
                    logging.info(f"Found whispercpp via walk at: {found}")
                    return found
                    
    except Exception as e:
         logging.error(f"Recursive search failed: {e}")
            
    # Dev and general search candidates (fallback)
    candidates = [
        # Dev layout (from project root)
        root / "src-tauri" / "resources" / "whispercpp" / f"whisper-cli{ext}",
        root / "src-tauri" / "resources" / "whispercpp" / f"main{ext}",
        # Resource folder next to script
        root / "resources" / "whispercpp" / f"whisper-cli{ext}",
        # Known legacy/custom paths
        Path(f"C:/wsp/build/bin/Release/whisper-cli{ext}"),
        root / "python" / "whispercpp" / f"whisper-cli{ext}",
        root / "whispercpp" / "build" / "bin" / "Release" / f"whisper-cli{ext}",
    ]

    logging.info(f"[DEBUG PATHS] Project Root: {root}")
    # logging.info(f"[DEBUG PATHS] Checking candidates: {[str(c) for c in candidates]}")

    for candidate in candidates:
        if candidate.exists() and candidate.is_file():
            logging.info(f"Found whispercpp (dev fallback) at: {candidate}")
            return candidate
        else:
            logging.info(f"[DEBUG PATHS] Not found: {candidate}")

    logging.error(f"Could not find whisper-cli.exe. Searched standardized and recursive locations.")
    return None


def get_whispercpp_server_executable() -> Path | None:
    env_path = os.environ.get("WHISPERCPP_SERVER_EXE")
    if env_path:
        candidate = Path(env_path)
        if candidate.exists() and candidate.is_file():
            return candidate

    cli_candidate = get_whispercpp_executable()
    if cli_candidate is not None:
        server_from_cli = cli_candidate.with_name(f"whisper-server{get_exe_ext()}")
        if server_from_cli.exists() and server_from_cli.is_file():
            return server_from_cli

    root = project_root()
    ext = get_exe_ext()
    
    candidates = [
        # Dev paths
        root / "src-tauri" / "resources" / "whispercpp" / f"whisper-server{ext}",
        # Legacy/Custom
        Path(f"C:/wsp/build/bin/Release/whisper-server{ext}"),
        root / "python" / "whispercpp" / f"whisper-server{ext}",
        root / "whispercpp" / "build" / "bin" / "Release" / f"whisper-server{ext}",
    ]

    for candidate in candidates:
        if candidate.exists() and candidate.is_file():
            emit({"log": f"Found whispercpp at: {candidate}"})
            return candidate

    emit({"error": f"Could not find whisper-cli.exe. Searched {len(candidates)} locations."})
    emit({"log": f"Search paths included: {[str(c) for c in candidates]}"})
    return None


def build_multipart_payload(fields: dict[str, str], file_field: tuple[str, str, bytes, str] | None = None):
    boundary = f"----Veloce{uuid.uuid4().hex}"
    chunks: list[bytes] = []

    for key, value in fields.items():
        chunks.append(f"--{boundary}\r\n".encode("utf-8"))
        chunks.append(f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode("utf-8"))
        chunks.append(str(value).encode("utf-8"))
        chunks.append(b"\r\n")

    if file_field is not None:
        field_name, filename, file_bytes, content_type = file_field
        chunks.append(f"--{boundary}\r\n".encode("utf-8"))
        chunks.append(
            f'Content-Disposition: form-data; name="{field_name}"; filename="{filename}"\r\n'.encode("utf-8")
        )
        chunks.append(f"Content-Type: {content_type}\r\n\r\n".encode("utf-8"))
        chunks.append(file_bytes)
        chunks.append(b"\r\n")

    chunks.append(f"--{boundary}--\r\n".encode("utf-8"))
    body = b"".join(chunks)
    content_type = f"multipart/form-data; boundary={boundary}"
    return body, content_type


def http_get(url: str, timeout_s: float = 5.0):
    request = urllib.request.Request(url=url, method="GET")
    with urllib.request.urlopen(request, timeout=timeout_s) as response:
        data = response.read()
        return response.getcode(), data.decode("utf-8", errors="ignore")


def http_post_multipart(url: str, fields: dict[str, str], file_field: tuple[str, str, bytes, str] | None = None, timeout_s: float = 120.0):
    body, content_type = build_multipart_payload(fields, file_field)
    request = urllib.request.Request(url=url, data=body, method="POST")
    request.add_header("Content-Type", content_type)
    request.add_header("Accept", "application/json")

    with urllib.request.urlopen(request, timeout=timeout_s) as response:
        data = response.read()
        return response.getcode(), data.decode("utf-8", errors="ignore")


def whisper_server_urls() -> tuple[str, str, str]:
    base = f"http://{WHISPERCPP_SERVER_HOST}:{WHISPERCPP_SERVER_PORT}"
    return base, f"{base}/health", f"{base}/inference"


def is_whisper_server_ready() -> bool:
    _, health_url, _ = whisper_server_urls()
    try:
        status, payload = http_get(health_url, timeout_s=1.5)
        return status == 200 and "\"status\":\"ok\"" in payload.replace(" ", "")
    except Exception:
        return False


def stop_whisper_server():
    global whisper_server_process, whisper_server_model_path
    if whisper_server_process is None:
        return

    try:
        whisper_server_process.terminate()
        whisper_server_process.wait(timeout=5)
    except Exception:
        try:
            whisper_server_process.kill()
        except Exception:
            pass

    whisper_server_process = None
    whisper_server_model_path = ""

atexit.register(stop_whisper_server)

def handle_sigterm(signum, frame):
    stop_whisper_server()
    os._exit(0)

try:
    signal.signal(signal.SIGTERM, handle_sigterm)
    signal.signal(signal.SIGINT, handle_sigterm)
except Exception:
    pass


def _whisper_server_log_listener(process):
    """Thread to read whisper-server stderr and filter/emit logs."""
    if not process or not process.stderr:
        return
        
    for line_bytes in process.stderr:
        try:
            line = line_bytes.decode("utf-8", errors="ignore").strip()
            if not line:
                continue
            
            # Simple filtering
            lower_line = line.lower()
            
            # Known info/status messages
            info_patterns = [
                "whisper_init_state:", 
                "whisper_init_from_file_with_params_no_state:",
                "compute buffer",
                "system_info:",
                "llama_perf_context_print:",
                "model_load:",
                "params.n_threads =",
            ]
            
            is_info = any(p in lower_line for p in info_patterns)
            
            # Filter out noisy "processing" logs from whisper-server
            noisy_patterns = [
                "operator ():",
                "processing 'chunk.wav'",
                "timestamps = 0",
                "lang ="
            ]
            if any(p in lower_line for p in noisy_patterns):
                continue

            if is_info:
                # emit({"log": f"whisper-server: {line}"}) # Reduce noise even on info
                pass
            elif "error" in lower_line or "fail" in lower_line:
                emit({"error": f"whisper-server error: {line}"})
            else:
                # Default to log to avoid too many "red" popups for non-errors
                # Only emit if it looks meaningful
                if len(line) > 5:
                    emit({"log": f"whisper-server info: {line}"})
                
        except Exception:
            pass


def ensure_whisper_server(model_path: str, prefer_gpu: bool) -> tuple[bool, str]:
    global whisper_server_process, whisper_server_model_path
    emit({"log": f"Ensuring whisper-server is running for model: {model_path}"})

    server_exe = get_whispercpp_server_executable()
    if server_exe is None:
        emit({"error": "whisper-server.exe not found"})
        return False, "No se encontró whisper-server.exe"

    # Ensure model exists (download if needed)
    emit({"log": f"Verifying model file: {model_path}"})
    downloaded_path = ensure_model_exists(selected_model)
    if downloaded_path:
        model_path = downloaded_path

    with whisper_server_lock:
        if whisper_server_process is not None and whisper_server_process.poll() is None and is_whisper_server_ready():
            if whisper_server_model_path == model_path:
                emit({"log": "whisper-server is already running with the correct model"})
                return True, ""

            emit({"log": f"Switching whisper-server to model: {model_path}"})
            try:
                base, _, _ = whisper_server_urls()
                status, _ = http_post_multipart(
                    f"{base}/load",
                    fields={"model": model_path},
                    timeout_s=60.0,
                )
                if status == 200:
                    whisper_server_model_path = model_path
                    return True, ""
            except Exception as e:
                emit({"log": f"Failed to switch model, restarting server: {e}"})
                stop_whisper_server()

        stop_whisper_server()

        cpu_threads = min(os.cpu_count() or 4, 8)
        command = [
            str(server_exe),
            "--host",
            WHISPERCPP_SERVER_HOST,
            "--port",
            str(WHISPERCPP_SERVER_PORT),
            "-m",
            model_path,
            "-nt",           # no timestamps (faster)
            "-t", str(cpu_threads),  # CPU threads
            "--beam-size", "1",      # greedy decoding (fastest)
        ]
        if prefer_gpu:
            command += ["-ngl", "99"]  # offload all layers to GPU
        else:
            command.append("-ng")
        
        emit({"log": f"Starting whisper-server: {' '.join(command)}"})

        try:
            whisper_server_process = subprocess.Popen(
                command,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE, # Capture to filter
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform.startswith("win") else 0,
            )
            # Start log filter thread
            threading.Thread(target=_whisper_server_log_listener, args=(whisper_server_process,), daemon=True).start()
        except Exception as e:
            whisper_server_process = None
            emit({"error": f"Failed to spawn whisper-server: {e}"})
            return False, f"No se pudo iniciar whisper-server: {e}"

        started_at = time.time()
        while (time.time() - started_at) < WHISPERCPP_SERVER_HEALTH_TIMEOUT:
            if whisper_server_process.poll() is not None:
                whisper_server_process = None
                emit({"error": "whisper-server terminated unexpectedly during startup"})
                return False, "whisper-server terminó inesperadamente al iniciar"

            if is_whisper_server_ready():
                whisper_server_model_path = model_path
                emit({"log": "whisper-server is ready"})
                return True, ""

            time.sleep(0.3)

        stop_whisper_server()
        emit({"error": "whisper-server health check timeout"})
        return False, "Timeout iniciando whisper-server"


def get_app_data_dir() -> Path:
    if sys.platform == "win32":
        return Path(os.environ["APPDATA"]) / "Veloce"
    elif sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Veloce"
    else:
        return Path.home() / ".config" / "veloce"

def get_dictionary_path() -> Path:
    if sys.platform == "win32":
        return Path(os.environ["APPDATA"]) / "Veloce" / "word_dictionary.json"
    elif sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Veloce" / "word_dictionary.json"
    else:
        return Path.home() / ".config" / "veloce" / "word_dictionary.json"

def load_word_dictionary():
    global word_substitutions
    dict_path = get_dictionary_path()
    if dict_path.exists():
        try:
            with open(dict_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                word_substitutions = {
                    entry["from"].lower(): entry["to"]
                    for entry in data.get("substitutions", [])
                    if entry.get("from") and entry.get("to")
                }
            emit({"log": f"Word dictionary loaded: {len(word_substitutions)} entries"})
        except Exception as e:
            emit({"log": f"Failed to load word dictionary: {e}"})
            word_substitutions = {}
    else:
        word_substitutions = {}

def _detect_case_style(word: str) -> str:
    """Classify the case style of a single word.

    Returns one of: "upper" (ALL UPPERCASE, multi-char), "title" (first char
    upper, rest lower), "lower" (all lowercase), or "as-is" (mixed, non-Latin,
    empty, or single non-letter char).

    Each token is classified independently — the same word in different
    positions may have different case in the transcript (e.g. "tauri" and
    "TAURI") and is handled per-occurrence.
    """
    if not word or not word[0].isalpha():
        return "as-is"
    if word.isupper() and len(word) > 1:
        return "upper"
    if word[0].isupper() and (len(word) == 1 or word[1:].islower()):
        return "title"
    if word.islower():
        return "lower"
    return "as-is"


def _apply_case_style(replacement: str, style: str) -> str:
    """Render the user's `to` value using the source token's case style.

    Per spec:
    - ``upper``  → ALL UPPERCASE
    - ``title``  → per-word Title Case (e.g. ``tauri inc`` → ``Tauri Inc``).
      Mixed separators are preserved: ``tauri-DEV`` → ``Tauri-Dev``.
    - ``lower``  → user's ``to`` as-is (the user controls the case; do not lowercase)
    - ``as-is``  → user's ``to`` as-is
    """
    if style == "upper":
        return replacement.upper()
    if style == "title":
        if not replacement:
            return replacement
        # Per-word Title Case: capitalize the first letter of each contiguous
        # letter run, lowercase the rest. Preserves any non-letter separators
        # (spaces, hyphens, dots) verbatim.
        return re.sub(
            r"[A-Za-z]+",
            lambda m: m.group(0)[:1].upper() + m.group(0)[1:].lower(),
            replacement,
        )
    if style == "lower":
        # Spec: lower source → user's `to` as-is. Do NOT lowercase.
        return replacement
    return replacement


def apply_word_substitutions(text: str) -> str:
    if not word_substitutions:
        return text
    # Strip common punctuation for matching, but preserve original spacing/punctuation in output
    PUNCT = '.,;:!?¡¿¿—\'"()[]{}'
    words = text.split()
    corrected = []
    for w in words:
        key = w.lower().strip(PUNCT)
        if key in word_substitutions:
            # Preserve the source token's case style in the replacement.
            # Mixed-case and non-Latin tokens fall through to "as-is" (verbatim).
            style = _detect_case_style(w)
            corrected.append(_apply_case_style(word_substitutions[key], style))
        else:
            corrected.append(w)
    return " ".join(corrected)

def get_writable_models_dir() -> Path:
    return get_app_data_dir() / "models"

def get_whispercpp_model_dir() -> Path:
    if selected_model_dir:
        return Path(selected_model_dir)

    env_dir = os.environ.get("WHISPERCPP_MODEL_DIR")
    if env_dir:
        return Path(env_dir)

    # 1. Check user-writable AppData location (Priority for downloaded models)
    writable_dir = get_writable_models_dir()
    if writable_dir.exists() and writable_dir.is_dir():
        # Only return if it actually has bin/gguf files to avoid empty dirs
        if any(writable_dir.glob("*.bin")) or any(writable_dir.glob("*.gguf")):
            return writable_dir

    root = project_root()

    # Check for bundled resources in freeze/installer mode
    if getattr(sys, 'frozen', False):
        exe_path = Path(sys.executable).parent
        
        candidates = [
            # Standard Tauri layout: models are siblings to audio-engine.exe
            exe_path / "models",
            # Nested layout: resources/models
            exe_path / "resources" / "models",
            # Parent layout
            exe_path.parent / "models",
            exe_path.parent / "resources" / "models",
        ]
        
        for candidate in candidates:
            if candidate.exists() and candidate.is_dir():
                if any(candidate.glob("*.bin")) or any(candidate.glob("*.gguf")):
                    return candidate

    candidates = [
        writable_dir,
        root / "src-tauri" / "resources" / "models",
        root / "models",
        Path("C:/wsp/models"),
        Path(os.environ.get("WHISPERCPP_MODEL_DIR", "C:/wsp/models")),
        root / "python" / "whispercpp" / "models",
    ]

    existing_dirs = []
    for candidate in candidates:
        if candidate.exists() and candidate.is_dir():
            existing_dirs.append(candidate)
            if any(candidate.glob("*.bin")) or any(candidate.glob("*.gguf")):
                return candidate

    if existing_dirs:
        return existing_dirs[0]

    return candidates[0]

def download_file(url, dest_path):
    emit({"log": f"Descargando modelo desde {url}..."})
    try:
        # Stream download with progress
        with urllib.request.urlopen(url) as response:
            total_size = int(response.info().get('Content-Length').strip())
            downloaded = 0
            chunk_size = 1024 * 1024 # 1MB chunks
            
            with open(dest_path, 'wb') as out_file:
                while True:
                    chunk = response.read(chunk_size)
                    if not chunk:
                        break
                    out_file.write(chunk)
                    downloaded += len(chunk)
                    # Optional: Emit percentage if needed, but logging "downloading..." is often enough
                    # percent = int(downloaded / total_size * 100)
                    # if percent % 10 == 0: ...
        
        emit({"log": "Descarga de modelo completada."})
    except Exception as e:
        emit({"error": f"Error descargando modelo: {e}"})
        # Clean up partial
        if dest_path.exists():
            os.remove(dest_path)
        raise

def ensure_model_exists(model_name: str) -> str:
    # 1. Check if already exists
    model_file, resolved_name = find_whispercpp_model_file(model_name)
    if model_file and model_file.exists():
        return str(model_file)
    
    # 2. If not, verify if it's the default/supported one we can download
    if model_name not in ["large-v3-turbo", "ggml-large-v3-turbo"]:
        emit({"log": f"Modelo '{model_name}' no encontrado. No hay descarga automática para este modelo."})
        return ""

    # 3. Download
    target_dir = get_writable_models_dir()
    target_dir.mkdir(parents=True, exist_ok=True)
    
    filename = "ggml-large-v3-turbo.bin"
    target_path = target_dir / filename
    
    url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin"
    
    emit({"log": f"Modelo no encontrado. Iniciando descarga automática a {target_path}..."})
    
    # Use a lock to prevent parallel downloads
    with download_lock:
        if target_path.exists():
             return str(target_path)
             
        try:
            download_file(url, target_path)
            return str(target_path)
        except Exception as e:
            emit({"error": f"Fallo la descarga del modelo: {e}"})
            return ""


def whispercpp_model_keys(model_name: str) -> list[str]:
    # distil maps better to large-v3 family for whisper.cpp naming.
    normalized = model_name.strip().lower()
    if normalized == "distil-large-v3":
        return ["large-v3", "large-v3-turbo"]
    return [normalized]


def infer_model_from_whispercpp_filename(model_path: Path) -> str:
    stem = model_path.stem.lower()
    if stem.startswith("ggml-"):
        stem = stem[len("ggml-"):]

    known_ids = sorted([m for m in SUPPORTED_MODELS if m != "voxtral-mini-4b-realtime-2602"], key=len, reverse=True)
    for model_id in known_ids:
        if model_id in stem:
            return model_id

    return stem


def find_whispercpp_model_file(model_name: str) -> tuple[Path | None, str]:
    model_dir = get_whispercpp_model_dir()
    if not model_dir.exists() or not model_dir.is_dir():
        return None, ""

    def collect_candidates(keys: list[str]) -> list[Path]:
        exact_candidates: list[Path] = []
        glob_candidates: list[Path] = []

        for key in keys:
            exact_candidates.extend([
                model_dir / f"ggml-{key}.bin",
                model_dir / f"ggml-{key}.gguf",
                model_dir / f"{key}.bin",
                model_dir / f"{key}.gguf",
            ])

            glob_candidates.extend(model_dir.glob(f"ggml-{key}*.bin"))
            glob_candidates.extend(model_dir.glob(f"ggml-{key}*.gguf"))
            glob_candidates.extend(model_dir.glob(f"{key}*.bin"))
            glob_candidates.extend(model_dir.glob(f"{key}*.gguf"))

        for candidate in exact_candidates:
            if candidate.exists() and candidate.is_file():
                return [candidate]

        valid_glob_candidates = [c for c in glob_candidates if c.exists() and c.is_file()]
        if valid_glob_candidates:
            valid_glob_candidates.sort(key=lambda path: (len(path.name), path.name))
            return [valid_glob_candidates[0]]

        return []

    keys = whispercpp_model_keys(model_name)
    primary = collect_candidates(keys)
    if primary:
        model_path = primary[0]
        return model_path, infer_model_from_whispercpp_filename(model_path)

    fallback_keys = [key for key in WHISPERCPP_FALLBACK_MODELS if key not in keys]
    fallback = collect_candidates(fallback_keys)
    if fallback:
        model_path = fallback[0]
        return model_path, infer_model_from_whispercpp_filename(model_path)

    any_models = [*model_dir.glob("ggml-*.bin"), *model_dir.glob("ggml-*.gguf")]
    
    # Dev environment fallback
    env_dir = os.environ.get("WHISPERCPP_MODEL_DIR", "")
    if env_dir and os.path.isdir(env_dir):
        env_path = Path(env_dir)
        any_models.extend(env_path.glob("*.bin"))
        any_models.extend(env_path.glob("*.gguf"))
        
    any_models = [candidate for candidate in any_models if candidate.exists() and candidate.is_file()]
    if any_models:
        any_models.sort(key=lambda path: (len(path.name), path.name))
        model_path = any_models[0]
        return model_path, infer_model_from_whispercpp_filename(model_path)

    return None, ""


def get_whispercpp_status(model_name: str) -> dict:
    executable = get_whispercpp_executable()
    emit({"log": f"get_whispercpp_status: exec={executable}"})
    model_file, resolved_model = find_whispercpp_model_file(model_name)
    available = executable is not None and model_file is not None

    reason = ""
    if executable is None:
        reason = f"No se encontró whisper-cli{get_exe_ext()}. Configura WHISPERCPP_EXE o instala whisper.cpp compilado."
    elif model_file is None:
        reason = f"No se encontró modelo ggml/gguf para '{model_name}' en {get_whispercpp_model_dir()}"
    elif resolved_model and resolved_model != model_name:
        reason = f"Modelo exacto '{model_name}' no encontrado; usando '{resolved_model}'"

    return {
        "available": available,
        "executable": str(executable) if executable else "",
        "model_path": str(model_file) if model_file else "",
        "model_dir": str(get_whispercpp_model_dir()),
        "requested_model": model_name,
        "resolved_model": resolved_model,
        "reason": reason,
    }


def resolve_backend(model_name: str, prefer_gpu: bool, backend_name: str) -> str:
    requested = normalize_backend_name(backend_name)
    cuda_available = get_torch_cuda_info()["cuda_available"]

    if requested == "faster-whisper":
        if prefer_gpu and not cuda_available:
            emit({"log": "Backend faster-whisper seleccionado con GPU ON, pero CUDA no está disponible; se ejecutará en CPU."})
        return "faster-whisper"

    if requested == "whispercpp":
        status = get_whispercpp_status(model_name)
        if status["available"]:
            if status.get("resolved_model") and status.get("resolved_model") != model_name:
                emit({"log": f"whisper.cpp: usando modelo local '{status['resolved_model']}' para solicitud '{model_name}'"})
            return "whispercpp"
        emit({"error": f"Backend whisper.cpp no disponible: {status['reason']}"})
        return "faster-whisper"

    # auto
    if prefer_gpu and not cuda_available:
        status = get_whispercpp_status(model_name)
        if status["available"]:
            emit({"log": "Auto backend: usando whisper.cpp para compatibilidad GPU en Windows/AMD."})
            if status.get("resolved_model") and status.get("resolved_model") != model_name:
                emit({"log": f"Auto backend: modelo local usado por whisper.cpp: {status['resolved_model']}"})
            return "whispercpp"
        emit({"log": f"Auto backend: CUDA no disponible y whisper.cpp no está listo ({status['reason']}). Se usará faster-whisper en CPU."})

    return "faster-whisper"


def emit(payload):
    msg = json.dumps(payload)
    print(msg)
    sys.stdout.flush()
    # Log to file as well
    if "error" in payload:
        logging.error(f"EMIT ERROR: {payload['error']}")
    elif "log" in payload:
        logging.info(f"EMIT LOG: {payload['log']}")
    elif "status" in payload:
        logging.debug(f"EMIT STATUS: {payload['status']}")
    elif "transcription" in payload:
        logging.info(f"EMIT TRANSCRIPTION ({payload.get('is_final')}): {payload['transcription']}")


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
    
    # Also scan custom model dir if set
    custom_dir = get_whispercpp_model_dir()
    
    repo_to_model = {
        "models--Systran--faster-whisper-tiny": "tiny",
        "models--Systran--faster-whisper-base": "base",
        "models--Systran--faster-whisper-small": "small",
        "models--Systran--faster-whisper-medium": "medium",
        "models--Systran--faster-whisper-large-v3": "large-v3",
        "models--Systran--faster-whisper-large-v3-turbo": "large-v3-turbo",
        "models--deepdml--faster-whisper-large-v3-turbo-ct2": "large-v3-turbo",
        "models--openai--whisper-large-v3-turbo": "large-v3-turbo",
        "models--distil-whisper--distil-large-v3": "distil-large-v3",
        "models--mistralai--Voxtral-Mini-4B-Realtime-2602": "voxtral-mini-4b-realtime-2602",
    }
    
    unique_ids: set[str] = set()
    
    # Scan HF Cache
    if cache_dir:
        try:
            for item in cache_dir.iterdir():
                if not item.is_dir():
                    continue

                model_name = repo_to_model.get(item.name)
                if not model_name and item.name.startswith("models--Systran--faster-whisper-"):
                    model_name = item.name.replace("models--Systran--faster-whisper-", "")

                if model_name and model_name in SUPPORTED_MODELS and model_name not in unique_ids and has_valid_model_snapshot(item):
                    # Calculate size
                    size = sum(f.stat().st_size for f in item.rglob('*') if f.is_file())
                    models.append({
                        "id": model_name,
                        "name": model_name.replace("-", " ").title(),
                        "downloaded": True,
                        "path": str(item),
                        "size": size,
                        "source": "huggingface"
                    })
                    unique_ids.add(model_name)
        except Exception:
            pass

    # Scan Custom/Local Dir for CT2 (faster-whisper) folders AND .bin/.gguf (whisper.cpp) files
    scan_dirs = []
    if custom_dir and custom_dir.exists():
        scan_dirs.append(custom_dir)
    
    # Also scan user's selected model dir if it differs
    if selected_model_dir:
        sel_path = Path(selected_model_dir).expanduser().resolve()
        if sel_path.exists() and sel_path not in scan_dirs:
            scan_dirs.append(sel_path)
        # Also scan the parent dir in case selected_model_dir IS the model folder itself
        parent = sel_path.parent
        if parent.exists() and parent not in scan_dirs and parent != sel_path:
            scan_dirs.append(parent)
    
    for scan_dir in scan_dirs:
        try:
            for f in scan_dir.iterdir():
                # Check for CT2-format model folders (faster-whisper): requires model.bin > 100MB and config.json
                if f.is_dir() and (f / "config.json").exists():
                    model_bin = f / "model.bin"
                    if model_bin.exists() and model_bin.stat().st_size > 50 * 1024 * 1024:  # > 50MB
                        # Try to infer model ID from folder name
                        folder_name = f.name.lower().replace("_", "-")
                        matched_id = None
                        for mid in sorted(SUPPORTED_MODELS, key=len, reverse=True):
                            if mid in folder_name or folder_name == mid:
                                matched_id = mid
                                break
                        if not matched_id and "large" in folder_name and "turbo" in folder_name:
                            matched_id = "large-v3-turbo"
                        elif not matched_id and "large" in folder_name:
                            matched_id = "large-v3"
                        elif not matched_id and "medium" in folder_name:
                            matched_id = "medium"
                        elif not matched_id and "small" in folder_name:
                            matched_id = "small"
                        elif not matched_id and "base" in folder_name:
                            matched_id = "base"
                        elif not matched_id and "tiny" in folder_name:
                            matched_id = "tiny"
                        
                        if matched_id and matched_id in SUPPORTED_MODELS and matched_id not in unique_ids:
                            size = int(model_bin.stat().st_size)
                            models.append({
                                "id": matched_id,
                                "name": matched_id.replace("-", " ").title(),
                                "downloaded": True,
                                "path": str(f),
                                "size": size,
                                "source": "local_folder"
                            })
                            unique_ids.add(matched_id)

                # Check for whispercpp-style .bin/.gguf files (only outside a CT2 model dir)
                elif f.is_file() and (f.suffix in ('.bin', '.gguf')) and f.stem.lower() != "model":
                    model_id = infer_model_from_whispercpp_filename(f)
                    if model_id and model_id in SUPPORTED_MODELS and model_id not in unique_ids:
                        models.append({
                            "id": model_id,
                            "name": model_id.replace("-", " ").title(),
                            "downloaded": True,
                            "path": str(f),
                            "size": f.stat().st_size,
                            "source": "local"
                        })
                        unique_ids.add(model_id)
        except Exception:
            pass

    unique_models = {}
    for m in models:
        mid = m["id"]
        if mid not in unique_models:
            unique_models[mid] = m
        else:
            # Prefer local_folder over HuggingFace cache (user explicitly chose it)
            if m.get("source") == "local_folder":
                unique_models[mid] = m

    return list(unique_models.values())


def get_model_directory_options() -> list[str]:
    options: list[str] = []
    seen: set[str] = set()

    def add_path(path_value):
        if not path_value:
            return
        try:
            candidate = Path(path_value).expanduser().resolve()
        except Exception:
            return

        if not candidate.exists() or not candidate.is_dir():
            return

        normalized = str(candidate)
        if normalized in seen:
            return

        seen.add(normalized)
        options.append(normalized)

    add_path(selected_model_dir)
    add_path(os.environ.get("WHISPERCPP_MODEL_DIR"))
    add_path(get_whispercpp_model_dir())
    # Well-known local install location
    add_path(str(Path.home() / "Descargas"))
    add_path(str(Path.home() / "Downloads"))
    add_path(str(project_root() / "src-tauri" / "resources" / "whispercpp"))

    home = Path.home()
    hf_candidates = [
        home / ".cache" / "huggingface" / "hub",
        home / "AppData" / "Local" / "huggingface" / "hub",
    ]

    hf_home = os.environ.get("HF_HOME")
    if hf_home:
        hf_candidates.insert(0, Path(hf_home) / "hub")

    for candidate in hf_candidates:
        add_path(candidate)

    return options

def get_hardware_info():
    """Fetch available microphones and GPU status."""
    global selected_backend, active_backend
    emit({"log": "Querying hardware info..."})
    devices = []
    try:
        # Reset portaudio cache to detect newly plugged-in mics
        try:
            sd._terminate()
            sd._initialize()
        except Exception:
            pass

        all_devices = sd.query_devices()
        emit({"log": f"Found {len(all_devices)} total audio endpoints"})
        default_device = sd.default.device
        default_input = default_device[0] if isinstance(default_device, (list, tuple)) else None
        
        seen_names = set()
        
        # Common output/loopback keywords to ignore (more specific to avoid false positives)
        ignore_keywords = [
            "altavoces", "altavoz", "speaker", "mezcla estéreo", "stereo mix", 
            "loopback", "mapper", "onda", "wave", "mezclador", "headphones", "auriculares"
        ]

        if sys.platform.startswith('linux'):
            import subprocess, re
            try:
                out = subprocess.check_output(["wpctl", "status"], stderr=subprocess.DEVNULL, timeout=2).decode("utf-8")
                sources_section = False
                for line in out.split("\n"):
                    if "├─ Sources:" in line:
                        sources_section = True
                        continue
                    if sources_section and ("├─" in line or "└─" in line or line.strip() == ""):
                        sources_section = False
                    if sources_section:
                        match = re.search(r"(\*?)\s+(\d+)\.\s+(.+?)\s+\[vol:", line)
                        if match:
                            is_default = match.group(1) == "*"
                            node_id = match.group(2)
                            name = match.group(3).strip()
                            if is_default:
                                name = f"{name} (Default)"
                            devices.append({
                                "id": f"pw_{node_id}",
                                "name": name,
                                "host_api": "pipewire"
                            })
            except Exception:
                pass

        if not devices:
            for i, dev in enumerate(all_devices):
                if dev.get('max_input_channels', 0) > 0:
                    name = dev.get('name', f"Device {i}")
                    
                    # Cleanup ALSA/Linux formatting issues
                    if " (hw:" in name:
                        name = name.split(" (hw:")[0]
                    elif "(hw:" in name:
                        name = name.split("(hw:")[0]
                        
                    if name.endswith(":-") or name.endswith(": -"):
                        name = name[:-2].strip()
                        
                    if name.lower() == "default":
                        name = "Default System Microphone"
                        
                    name_lower = name.lower()
                    
                    # Filter out output devices acting as inputs
                    if any(kw in name_lower for kw in ignore_keywords):
                        continue
                    
                    # Check for exact duplicates
                    if name in seen_names:
                        continue
                    seen_names.add(name)

                    if i == default_input:
                        name = f"{name} (Default)"
                        
                    devices.append({
                        "id": i,
                        "name": name,
                        "host_api": dev.get('hostapi')
                    })
    except Exception as e:
        err_str = str(e)
        emit({"error": f"Error querying audio devices: {err_str}"})
        friendly = "Audio no disponible - verifica que PulseAudio/PipeWire esté corriendo"
        if "PortAudio" in err_str or "PaError" in err_str:
            friendly = "Sin acceso a audio (PortAudio no inicializado)"
        devices = [{"id": -1, "name": friendly, "host_api": -1}]
    
    cuda_info = get_torch_cuda_info()
    gpu_available = bool(cuda_info["cuda_available"])
    gpu_name = str(cuda_info["gpu_name"])
    whispercpp_status = get_whispercpp_status(selected_model)
    gpu_reason = ""
    
    # Improved GPU reporting for whisper.cpp
    if active_backend == "whispercpp":
        # whisper.cpp has its own GPU detection (CUDA/Vulkan). 
        # If available and server is ready/starting with GPU enabled, we consider GPU active even if torch doesn't see it.
        if whispercpp_status.get("available"):
            if gpu_enabled:
                gpu_available = True
                gpu_reason = "Backend activo: whisper.cpp (Aceleración GPU activa via CUDA/Vulkan)."
            else:
                gpu_reason = "Backend activo: whisper.cpp (Aceleración GPU desactivada por configuración)."
        else:
            gpu_reason = f"whisper.cpp no listo: {whispercpp_status.get('reason', '')}"
    elif not gpu_available:
        torch_version = getattr(torch, "__version__", "unknown")
        if sys.platform.startswith("win") and "+cpu" in torch_version:
            gpu_reason = "PyTorch CPU-only detectado. faster-whisper/CTranslate2 no tiene GPU activa aquí; usa backend Auto/whisper.cpp para intentar aceleración GPU en Windows (si whisper.cpp está instalado con Vulkan)."
        elif sys.platform.startswith("win"):
            gpu_reason = "CUDA no disponible para faster-whisper en este runtime. En Windows puedes usar backend whisper.cpp para GPUs AMD/NVIDIA (con build Vulkan)."
        else:
            gpu_reason = "No se detectó runtime GPU compatible para el backend actual."
    else:
        vram = cuda_info.get("vram_gb")
        if isinstance(vram, (int, float)):
            gpu_reason = f"CUDA disponible para faster-whisper ({vram} GB VRAM detectados)."
        else:
            gpu_reason = "CUDA disponible para faster-whisper."
    
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

    for model_entry in fallback_models:
        # Only check for whispercpp-style .bin/.gguf files when whispercpp is the active backend.
        # For faster-whisper, trust only HF/CT2 scan to avoid false positives from wildcard matching.
        if active_backend in ("whispercpp",):
            model_file, _ = find_whispercpp_model_file(model_entry["id"])
            if model_file is not None:
                model_entry["downloaded"] = True
                model_entry["path"] = str(model_file)

    merged_models = {m["id"]: m for m in fallback_models}
    for model in models:
        merged_models[model["id"]] = model
    
    info = {
        "type": "hardware-info",
        "microphones": devices,
        "gpu": {
            "available": gpu_available,
            "name": gpu_name,
            "reason": gpu_reason,
        },
        "backends": {
            "requested": selected_backend,
            "active": active_backend,
            "available": [
                {
                    "id": "auto",
                    "available": True,
                    "reason": "Automatic backend selection",
                },
                {
                    "id": "faster-whisper",
                    "available": True,
                    "reason": "Default backend",
                },
                {
                    "id": "whispercpp",
                    "available": bool(whispercpp_status.get("available", False)),
                    "reason": whispercpp_status.get("reason", ""),
                    "executable": whispercpp_status.get("executable", ""),
                    "model_path": whispercpp_status.get("model_path", ""),
                    "model_dir": whispercpp_status.get("model_dir", ""),
                },
            ],
        },
        "models": sorted(list(merged_models.values()), key=lambda model: model["id"]),
        "model_dirs": get_model_directory_options(),
        "default_model_dir": str(get_whispercpp_model_dir()),
    }
    return info


def load_whisper(model_name, prefer_gpu):
    global model_whisper
    cuda_info = get_torch_cuda_info()
    device, compute_type, runtime_reason = choose_faster_whisper_runtime(prefer_gpu)

    if prefer_gpu and device == "cpu":
        emit({"log": "GPU mode requested for faster-whisper, but CUDA runtime is not available in this environment. Running faster-whisper on CPU."})

    vram = cuda_info.get("vram_gb")
    vram_text = f", vram_gb={vram}" if isinstance(vram, (int, float)) else ""
    # emit({"log": f"faster-whisper runtime: device={device}, compute_type={compute_type}, reason={runtime_reason}, prefer_gpu={prefer_gpu}, cuda_available={cuda_info['cuda_available']}, torch={cuda_info['torch_version']}, gpu={cuda_info['gpu_name']}{vram_text}"})

    emit({"status": "loading_model"})

    model_load_lock.acquire()

    try:
        with model_lock:
            previous_model = model_whisper

        target_path = model_name
        
        # Check if the model exists in the custom model directory
        if selected_model_dir and os.path.isdir(selected_model_dir):
            potential_path = os.path.join(selected_model_dir, model_name)
            if os.path.isdir(potential_path) and os.path.exists(os.path.join(potential_path, "model.bin")):
                target_path = potential_path
                emit({"log": f"Found faster-whisper model in custom directory: {target_path}"})
            elif os.path.exists(os.path.join(selected_model_dir, "model.bin")) and os.path.exists(os.path.join(selected_model_dir, "config.json")):
                target_path = selected_model_dir
                emit({"log": f"Found faster-whisper model root in custom directory: {target_path}"})

        cpu_count = os.cpu_count() or 4
        # min(4, cpu_count): enough for real-time audio; max() inflated thread-local buffers
        cpu_threads = min(4, cpu_count)
        # num_workers=1: CT2 inter_threads — each extra worker duplicates the full model in RAM.
        # For a single real-time audio stream, one worker is sufficient.
        num_workers = 1
        emit({"log": f"Loading WhisperModel: {target_path} | device={device} compute={compute_type} threads={cpu_threads} workers={num_workers}"})
        loaded = WhisperModel(target_path, device=device, compute_type=compute_type, cpu_threads=cpu_threads, num_workers=num_workers)

        # Swap model atomically only after new model is fully loaded.
        with model_lock:
            old_model = model_whisper
            model_whisper = loaded
        if old_model is not None and old_model is not loaded:
            del old_model
            gc.collect()

        load_uuid = str(uuid.uuid4())[:6]
        emit({"status": "ready"})
        emit({"log": f"Model loaded [{load_uuid}]: {model_name} on {device}"})
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


def load_backend(model_name, prefer_gpu, backend_name):
    global active_backend, model_whisper, loaded_model, loaded_gpu, loaded_backend_type
    
    with backend_load_lock:
        requested_backend = resolve_backend(model_name, prefer_gpu, backend_name)

        # Avoid redundant reloads — compare by RESOLVED backend (not the raw name).
        # "auto" and "faster-whisper" can both resolve to the same backend; treating
        # them as different would cause unnecessary reloads on startup CONFIG bursts.
        if (loaded_model == model_name and
            loaded_gpu == prefer_gpu and
            active_backend == requested_backend and
            active_backend != "none"):

            # Additional check for backend health
            if active_backend == "whispercpp" and is_whisper_server_ready():
                emit({"status": "ready"})
                return model_name
            elif active_backend == "faster-whisper" and model_whisper is not None:
                emit({"status": "ready"})
                return model_name

        chosen_backend = requested_backend

        if chosen_backend == "whispercpp":
            emit({"status": "loading_model"})
            emit({"log": "Switching to whisper.cpp backend"})

            with model_lock:
                previous_model = model_whisper
                model_whisper = None

            if previous_model is not None:
                emit({"log": "Unloading faster-whisper model from memory"})
                del previous_model
                gc.collect()

            status = get_whispercpp_status(model_name)
            if not status["available"]:
                emit({"log": f"whisper.cpp not available, falling back to faster-whisper: {status['reason']}"})
                active_model = load_whisper(model_name, prefer_gpu)
                if active_model:
                    active_backend = "faster-whisper"
                    loaded_model = model_name
                    loaded_gpu = prefer_gpu
                    loaded_backend_type = backend_name # We requested this, so we cache it as processed to avoid retry loop
                else:
                    active_backend = "none"
                return active_model

            resolved_model = status.get("resolved_model") or model_name
            model_path = status.get("model_path", "")
            emit({"log": f"Ensuring whisper-server for {resolved_model} at {model_path}"})
            ready, error = ensure_whisper_server(model_path, prefer_gpu)
            if not ready:
                emit({"error": f"Failed to initialize whisper-server: {error}"})
                emit({"log": "Falling back to faster-whisper after whisper-server failure"})
                active_model = load_whisper(model_name, prefer_gpu)
                if active_model:
                    active_backend = "faster-whisper"
                    loaded_model = model_name
                    loaded_gpu = prefer_gpu
                    loaded_backend_type = backend_name 
                else:
                    active_backend = "none"
                return active_model

            active_backend = "whispercpp"
            loaded_model = model_name
            loaded_gpu = prefer_gpu
            loaded_backend_type = backend_name
            emit({"status": "ready"})
            emit({"log": f"Model ready: {resolved_model} on whisper.cpp server ({model_path})"})
            return resolved_model

        emit({"log": "Using faster-whisper backend"})
        active_backend = "faster-whisper"
        active_model = load_whisper(model_name, prefer_gpu)
        if active_model:
            loaded_model = model_name
            loaded_gpu = prefer_gpu
            loaded_backend_type = backend_name
        else:
            active_backend = "none"
        return active_model


def load_backend_async(model_name, prefer_gpu, backend_name):
    def _run():
        active_model = load_backend(model_name, prefer_gpu, backend_name)
        if active_model and active_model != model_name:
            emit({"log": f"Active model adjusted to: {active_model}"})
        # Emit hardware info AFTER loading completes to sync frontend state correctly
        emit(get_hardware_info())

    threading.Thread(target=_run, daemon=True).start()


def download_model_to_cache(model_name, download_dir=None):
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
                            # Emit if progress changed or every 1MB chunk to keep alive
                            if progress != self._last_progress or (self.n % (1024*1024) == 0):
                                self._last_progress = progress
                                emit({
                                    "type": "model-download-progress", 
                                    "model": model_name, 
                                    "progress": progress,
                                    "loaded": self.n,
                                    "total": self.total,
                                    "unit": self.unit if hasattr(self, 'unit') else 'B'
                                })

                    def update(self, n=1):
                        result = super().update(n)
                        self._emit_progress()
                        return result

                    def refresh(self, *args, **kwargs):
                        result = super().refresh(*args, **kwargs)
                        self._emit_progress()
                        return result

                # Determine where to download
                local_dir_arg = download_dir if download_dir else None

                snapshot_download(
                    repo_id=repo_id,
                    repo_type="model",
                    local_dir=local_dir_arg,
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
        
        # If we downloaded to a custom path that isn't in standard search, downloaded_now might be false,
        # but the operation was successful.
        if downloaded_now or download_dir: 
            emit({"log": f"Download verification passed: {model_name}"})
            if model_name == selected_model:
                active_model = load_backend(selected_model, gpu_enabled, selected_backend)
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


def start_input_stream(device_id, force_restart=False):
    global current_stream

    # Variables to track stream properties
    stream_samplerate = RATE
    stream_channels = CHANNELS
    
    # We will instantiate a resampler lazily to avoid overhead if not needed
    resampler = None
    vu_last_emit = 0.0

    def audio_callback(indata, frames, callback_time, status):
        nonlocal resampler, vu_last_emit
        global recording
        try:
            if status:
                pass
            chunk = indata.copy()
            
            # Mix down to mono if needed
            if stream_channels > 1:
                chunk = np.mean(chunk, axis=1, keepdims=True).astype(np.int16)
                
            # Resample if needed
            if stream_samplerate != RATE:
                if resampler is None:
                    resampler = torchaudio.transforms.Resample(orig_freq=stream_samplerate, new_freq=RATE)
                
                # Convert to float32 tensor
                chunk_tensor = torch.from_numpy(chunk).float().T # [channels, time]
                chunk_tensor = resampler(chunk_tensor)
                chunk = chunk_tensor.T.numpy().astype(np.int16)

            # VU Meter emit
            if recording:
                now = time.time()
                if now - vu_last_emit >= 1.0 / 15.0:
                    rms = float(np.sqrt(np.mean(chunk.astype(np.float32)**2)))
                    emit({"vu_meter": {"rms": rms}})
                    vu_last_emit = now

            with pre_roll_lock:
                pre_roll_chunks.append(chunk)
            if recording:
                global debug_callback_count
                debug_callback_count += 1
                if debug_callback_count == 1 or debug_callback_count % 50 == 0:
                    emit({"log": f"Audio callback running, chunk len={len(chunk)}, rms={float(np.sqrt(np.mean(chunk.astype(np.float32)**2))):.2f}"})
                audio_queue.put(chunk)
        except Exception as e:
            emit({"error": f"Audio callback crashed: {e}"})

    if current_stream is not None and not force_restart:
        try:
            if getattr(current_stream, 'active', False):
                return
            else:
                emit({"log": "Existing stream is dead/inactive. Forcing restart."})
        except Exception as e:
            emit({"log": f"Stream active check failed: {e}. Forcing restart."})

    if current_stream is not None:
        try:
            current_stream.stop()
        except Exception:
            pass
        try:
            current_stream.close()
        except Exception:
            pass
        current_stream = None

    kwargs = {
        "callback": audio_callback,
        "channels": CHANNELS,
        "samplerate": RATE,
        "blocksize": CHUNK,
        "dtype": "int16",
    }
    if isinstance(device_id, str) and device_id.startswith("pw_"):
        node_id = device_id.split("_")[1]
        os.environ["PIPEWIRE_NODE"] = node_id
        emit({"log": f"Routed PipeWire ALSA to target node {node_id}"})
        # Allow ALSA default wrapper (pipewire) to capture via standard stream
        device_id = None
    else:
        # Clear any previously forced nodes
        if "PIPEWIRE_NODE" in os.environ:
            del os.environ["PIPEWIRE_NODE"]

    if device_id is not None:
        kwargs["device"] = device_id

    try:
        emit({"log": f"Attempting to start audio stream. Device={device_id}, channels={CHANNELS}, sr={RATE}"})
        current_stream = sd.InputStream(**kwargs)
        stream_samplerate = RATE
        stream_channels = CHANNELS
        current_stream.start()
        emit({"log": "Audio stream started explicitly."})
    except Exception as e:
        emit({"log": f"Failed to open stream with default settings: {e}. Trying fallback..."})
        try:
            # Fallback to device's default settings
            dev_info = sd.query_devices(device=device_id)
            fallback_channels = int(dev_info.get("max_input_channels", 1))
            fallback_samplerate = int(dev_info.get("default_samplerate", RATE))
            
            kwargs["channels"] = fallback_channels
            kwargs["samplerate"] = fallback_samplerate
            
            stream_channels = fallback_channels
            stream_samplerate = fallback_samplerate
            
            # Warn if fallback differs from VAD/Whisper requirements
            emit({"log": f"Fallback stream starting at {kwargs['samplerate']}Hz, {kwargs['channels']} channels. Audio will be actively resampled."})
            current_stream = sd.InputStream(**kwargs)
            current_stream.start()
        except Exception as e2:
            current_stream = None
            emit({"error": f"Failed to start audio stream even with fallback: {e2}"})
            raise RuntimeError(f"Audio stream error: {e2}")


def inject_pre_roll_audio():
    with pre_roll_lock:
        chunks = list(pre_roll_chunks)

    for chunk in chunks:
        audio_queue.put(chunk)

class StreamProcessor:
    def __init__(self, vad_detector, sample_rate=16000, chunk_size=512):
        self.vad = vad_detector
        self.sample_rate = sample_rate
        self.chunk_size = chunk_size
        
        self.speech_buffer = deque(maxlen=int(120 * RATE / 512))  # Bounded to ~120s of audio chunks
        self._last_partial_total_samples = 0  # Total samples transcribed in last partial — tracks delta window
        self.is_speech_active = False
        self.speech_start_time = 0
        self.last_speech_time = 0
        self.silence_counter = 0
        
        # Tuning parameters
        self.min_speech_duration_ms = 150 # Reduced to catch short words like "Hi"
        self.min_silence_duration_ms = 650  # Lower latency while preserving phrase grouping
        self.max_segment_duration_s = 3.2   # Force flush in continuous/noisy speech to avoid 20s delays
        self.speech_pad_ms = 100  
        
        self.accumulated_audio_duration = 0
        self.last_partial_time = 0
        
        # We no longer keep pending segments, we dispatch them immediately
        # self.pending_segments = []

    def process(self, audio_chunk):
        # audio_chunk: numpy array (int16 or float32)
        global debug_process_count
        debug_process_count += 1
        if debug_process_count == 1 or debug_process_count % 50 == 0:
            emit({"log": f"Processor tick: active={self.is_speech_active}, buffer={len(self.speech_buffer)}, sil_{self.silence_counter}"})
            
        is_speech_frame = self.vad.is_speech(audio_chunk, self.sample_rate)
        
        if is_speech_frame:
            self.silence_counter = 0
            if not self.is_speech_active:
                self.is_speech_active = True
                self.speech_start_time = time.time()
                # emit({"log": "VAD: Speech detected (Active)"}) # Debug Log
                # emit({"status": "speech_start"}) # Optional reduce noise
        else:
            if self.is_speech_active:
                self.silence_counter += (len(audio_chunk) / self.sample_rate) * 1000
        
        # Determine state transition
        if self.is_speech_active:
            self.speech_buffer.append(audio_chunk)
            self.accumulated_audio_duration += len(audio_chunk) / self.sample_rate

            # Force periodic segmentation even without full silence.
            if self.accumulated_audio_duration >= self.max_segment_duration_s:
                emit({"log": f"Forcing segment flush at {self.accumulated_audio_duration:.2f}s for low-latency transcription"})
                self.finalize_segment()
                return
            
            # Check for silence timeout -> Finalize
            if self.silence_counter > self.min_silence_duration_ms:
                self.finalize_segment()
                self.is_speech_active = False
                self.silence_counter = 0
            # If speaking continuously for a while, emit a partial update to reduce perceived latency
            elif self.accumulated_audio_duration - self.last_partial_time > 1.5:
                self.last_partial_time = self.accumulated_audio_duration
                self._transcribe_partial()

    def finalize_segment(self, is_final_flush=False):
        if not self.speech_buffer:
            return
            
        full_audio = np.concatenate(self.speech_buffer)
        duration = len(full_audio) / self.sample_rate
        
        if duration * 1000 < self.min_speech_duration_ms:
            # Too short, ignore but send an empty final to reset the UI waiting state
            transcription_queue.put({
                "audio": np.zeros((1,), dtype=np.int16),
                "is_final": True,
                "is_empty_drop": True
            })
            self.speech_buffer.clear()  # Clear deque in-place to preserve maxlen bound
            self.accumulated_audio_duration = 0
            self.last_partial_time = 0
            self._last_partial_total_samples = 0
            return
            
        # Dispatch immediately to background worker
        transcription_queue.put({
            "audio": full_audio,
            "is_final": True
        })
        
        if is_final_flush:
            self.speech_buffer.clear()
        else:
            self.speech_buffer.clear()
            
        self.accumulated_audio_duration = 0
        self.last_partial_time = 0
        self.silence_counter = 0
        self._last_partial_total_samples = 0
        
        # if recording:
        #     emit({"status": "listening"}) 

    def transcribe_all_pending(self):
        # Flush whatever is in the speech buffer right now as final
        if self.speech_buffer:
            self.finalize_segment(is_final_flush=True)

    def _transcribe_partial(self):
        """Transcribe only the NEW audio delta since last partial, not the full buffer.

        This is the key optimization: instead of re-transcribing the full accumulated
        buffer on every partial update (which causes O(n) cumulative work), we only
        send the ~1.5-2s of new audio that arrived since the last partial.

        _last_partial_total_samples tracks how many samples had been accumulated when
        the last partial ran. The delta is the new samples beyond that count.
        This works correctly even when the deque evicts old chunks via maxlen.
        """
        if not self.speech_buffer:
            return

        # Total samples currently in buffer
        current_total = sum(len(c) for c in self.speech_buffer)

        # Compute delta: new samples since last partial
        if current_total <= self._last_partial_total_samples:
            # Buffer wrapped or no new data — reset tracking
            self._last_partial_total_samples = 0

        delta_sample_count = current_total - self._last_partial_total_samples
        if delta_sample_count <= 0:
            return

        # Build delta audio by taking the newest chunks until we reach delta_sample_count
        delta_chunks = []
        samples_needed = delta_sample_count
        for chunk in reversed(self.speech_buffer):
            delta_chunks.insert(0, chunk)
            samples_needed -= len(chunk)
            if samples_needed <= 0:
                break

        if not delta_chunks:
            return

        # Enforce minimum 0.5s of new audio to avoid tiny/empty transcriptions
        delta_duration = sum(len(c) for c in delta_chunks) / self.sample_rate
        if delta_duration < 0.5:
            return

        delta_audio = np.concatenate(delta_chunks)

        # Advance tracking: mark total samples at end of this partial
        self._last_partial_total_samples = current_total

        # Run in thread to not block audio processing loop
        # We don't put partials in the queue to avoid blocking finals
        threading.Thread(target=transcribe_segment, args=(delta_audio, False), daemon=True).start()

def transcribe_segment(audio_data, is_final=False, retry_on_cpu=True):
    # This replaces the old transcribe() function logic but adapted
    global current_recording_id, diarization_manager
    
    # Flatten if needed
    if audio_data.ndim > 1:
        audio_data = audio_data.flatten()

    chunk_duration_s = float(audio_data.size) / float(RATE)
    
    # Determine speaker only on final segments to save compute
    speaker_label = None
    if is_final and diarization_manager:
        try:
             # Basic check to avoid errors if diarization is not ready
             # speaker_label = diarization_manager.get_speaker(audio_data)
             pass
        except Exception:
             pass

    if active_backend == "whispercpp":
        # whisper.cpp streaming via server is tricky for partials without active state maintenance
        # but we can just send the growing buffer for now.
        start_time = time.time()
        text, error = transcribe_whispercpp(audio_data, selected_language, is_final=is_final)
        latency_ms = (time.time() - start_time) * 1000
        if error:
            emit({"error": error})
            return
        
        # Cleanup
        # Cleanup
        text = cleanup_transcription_text(text, chunk_duration_s)
        
        if text:
            emit({
                "transcription": text, 
                "is_final": is_final, 
                "recording_id": current_recording_id,
                "speaker": speaker_label,
                "response_ms": int(latency_ms)
            })
        return

    # faster-whisper flow
    audio_float32 = audio_data.astype(np.float32) / 32768.0
    
    # Normalization (light)
    audio_float32 = audio_float32 - float(np.mean(audio_float32))
    peak = float(np.max(np.abs(audio_float32)))
    if peak > 0:
        audio_float32 = audio_float32 / peak * 0.95

    with model_lock:
        model = model_whisper
    
    if model is None:
        # If a model is currently loading, wait briefly before dropping the segment.
        if model_load_lock.locked():
            for _ in range(20):
                time.sleep(0.1)
                with model_lock:
                    model = model_whisper
                if model is not None:
                    break

    if model is None:
        emit({"error": "Model not loaded. Cannot transcribe. Check model selection and GPU settings."})
        return

    try:
        # Auto-switch to translation task if target is English (common use case for translation)
        # This helps real-time translation for non-English speakers selecting English.
        effective_task = "translate" if selected_language == "en" else "transcribe"

        start_time = time.time()
        segments, _ = model.transcribe(
            audio_float32,
            beam_size=1, # Faster for partials
            best_of=1,
            # Disable KV-cache growth that causes unbounded RAM usage in long sessions.
            # Delta-only partials mean we don't need cross-chunk context anyway.
            condition_on_previous_text=False,
            vad_filter=False, # We already did VAD, don't let whisper's internal VAD filter out partials
            language=None if selected_language == "auto" else selected_language,
            task=effective_task
        )
        
        text = " ".join([s.text for s in segments]).strip()
        text = cleanup_transcription_text(text, chunk_duration_s)
        
        latency_ms = (time.time() - start_time) * 1000

        if text:
            
            # Build cumulative session text for final segments
            cumulative = text
            if is_final:
                global session_transcript
                session_transcript = (session_transcript + " " + text).strip() if session_transcript else text
                cumulative = session_transcript
            else:
                # For partials, show the committed session so far + this partial
                cumulative = (session_transcript + " " + text).strip() if session_transcript else text
            
            emit({
                "transcription": cumulative,
                "phrase_text": text,
                "is_final": is_final, 
                "recording_id": current_recording_id,
                "speaker": speaker_label,
                "response_ms": int(latency_ms)
            })
            
    except Exception as e:
        error_text = str(e)

        # Common Windows CUDA runtime failures (missing cuBLAS/cuDNN DLLs).
        # If this happens, switch to CPU automatically and retry once.
        cuda_runtime_markers = [
            "cublas64_12.dll",
            "cudnn",
            "cuda",
            "cannot be loaded",
            "loadlibrary",
        ]
        is_cuda_runtime_error = any(marker in error_text.lower() for marker in cuda_runtime_markers)

        if retry_on_cpu and active_backend == "faster-whisper" and is_cuda_runtime_error:
            emit({"error": "CUDA runtime error during transcription. large-v3-turbo on GPU is required but CUDA libraries are unavailable."})

            # Retry once with the same requested configuration in case runtime paths were updated.
            reloaded = load_backend(selected_model, gpu_enabled, selected_backend)
            if reloaded:
                try:
                    # Retry once with the same model/backend setup.
                    transcribe_segment(audio_data, is_final=is_final, retry_on_cpu=False)
                    return
                except Exception:
                    pass

        emit({"error": f"Transcribe error: {e}"})

def transcription_worker():
    global stopping
    """Background thread to process transcription jobs synchronously one by one.

    Drain semantics: when STOP is pressed, the worker first drains any pending
    transcription jobs so their results are not lost, then emits
    ``{"status": "stopped"}`` exactly once on the final iteration when both
    ``recording`` and ``stopping`` are False AND the queue is empty. The terminal
    ``stopped`` event is gated on a finally block that fires for ALL job types
    (real jobs AND the ``STOP`` marker), so the UI returns to idle exactly once.
    """
    emit({"log": "Transcription worker thread started."})
    while True:
        try:
            # If STOP was pressed, reset the flag and fall through to drain any
            # queued transcription jobs. The terminal "stopped" event fires from
            # the inner finally once the queue is fully drained and the session
            # is no longer active.
            if stopping:
                emit({"log": "Stop signal received. Draining queue before emitting stopped."})
                stopping = False
                # fall through to process the remaining queue

            try:
                job = transcription_queue.get(timeout=0.1)
            except queue.Empty:
                continue
            # The job dispatch is wrapped in try/finally so the drain check
            # fires for ALL job types (including the STOP marker), not only
            # real transcription segments.
            try:
                if job is None:
                    # Poison pill received, ignore and continue
                    pass
                elif job.get("type") == "STOP":
                    # Synchronization marker from the main loop. The drain check
                    # in the finally below will emit "stopped" once the queue is
                    # empty and the session is no longer active.
                    emit({"log": "Transcription queue drained. Stop marker consumed."})
                else:
                    emit({"status": "transcribing_final"})
                    if job.get("is_empty_drop", False):
                         # If it was an empty drop from VAD, just emit empty text so React resets to idle.
                         emit({
                             "transcription": "",
                             "is_final": True,
                             "recording_id": current_recording_id,
                             "speaker": None,
                             "response_ms": 0
                         })
                    else:
                         transcribe_segment(job["audio"], is_final=job.get("is_final", True))
            except Exception as e:
                emit({"error": f"Error processing job: {e}"})
            finally:
                # Switch back to listening if the session is still active, OR
                # emit "stopped" once the queue is fully drained.
                if recording:
                    emit({"status": "listening"})
                elif transcription_queue.empty() and not stopping:
                    # Drain complete and not in an active session — terminal status.
                    emit({"status": "stopped"})
            transcription_queue.task_done()
        except Exception as e:
            emit({"error": f"Worker loop error: {e}"})

def main():
    emit({"log": "Main function started"})
    # Emit hardware info immediately
    emit(get_hardware_info())
    emit({"log": f"Initial backend load: model={selected_model}, gpu={gpu_enabled}, backend={selected_backend}"})
    load_backend(selected_model, gpu_enabled, selected_backend)
    load_word_dictionary()

    try:
        emit({"log": f"Warming up audio stream for device {selected_device}"})
        start_input_stream(selected_device)
        emit({"log": "Audio stream warmed up"})
    except Exception as e:
        emit({"error": f"Audio Stream Warmup Error: {e}"})

    # Command listener thread
    emit({"log": "Starting command listener thread"})
    threading.Thread(target=command_listener, daemon=True).start()

    # Transcription worker thread
    emit({"log": "Starting transcription worker thread"})
    threading.Thread(target=transcription_worker, daemon=True).start()

    # Initialize VAD and StreamProcessor
    emit({"log": "Initializing VAD and StreamProcessor..."})
    global diarization_manager
    # DiarizationManager loads SpeechBrain ECAPA-VoxCeleb (~300MB).
    # Only instantiate when diarization is actually enabled — the feature
    # is currently disabled (speaker assignment call is commented out).
    # diarization_manager = DiarizationManager()
    diarization_manager = None
    
    vad = VADDetector()
    processor = StreamProcessor(vad, chunk_size=CHUNK, sample_rate=RATE)

    emit({"log": "Audio engine started with VAD and Streaming"})

    was_recording = False

    while True:
        try:
            # Check for recording state change (Stop pressed)
            if was_recording and not recording:
                if processor.is_speech_active:
                    emit({"log": "Flushing remaining audio..."})
                    processor.finalize_segment()
                    processor.is_speech_active = False
                
                # Process all buffered segments now
                processor.transcribe_all_pending()
                
                # Signal the queue that this recording session is totally done.
                transcription_queue.put({"type": "STOP"})
                
                was_recording = False
            
            if recording:
                was_recording = True

            if not audio_queue.empty():
                audio_chunk = audio_queue.get()
                if recording:
                    processor.process(audio_chunk)
                else:
                    # Drain queue to prevent "ghost" audio processing after stop
                    pass
            
            else:
                time.sleep(0.005)

        except Exception as e:
            emit({"error": f"Stream loop error: {e}"})
            time.sleep(0.1)


def extract_whispercpp_text(stdout: str) -> str:
    lines = []
    for raw_line in stdout.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        lower = line.lower()
        if lower.startswith("main:") or lower.startswith("whisper_") or lower.startswith("system_info:"):
            continue

        if line.startswith("[") and "]" in line:
            line = line.split("]", 1)[1].strip()

        if line:
            lines.append(line)

    return " ".join(lines).strip()


def _strip_trailing_stutter(text: str) -> str:
    """Strip repeated-word stuttering from the END of text. Case-insensitive.
    
    E.g. "gracias gracias" → "gracias", "Y Y Y" → "Y", "si si si" → "si".
    Only the trailing stutter chain is removed — occurrences of words in the
    MIDDLE of the text are preserved.
    
    This handles hallucinated repeated words like "gracias gracias" and "Y Y Y"
    that appear at segment boundaries.
    """
    if not text:
        return text
    
    words = text.split()
    if len(words) < 2:
        return text
    
    # Count consecutive identical words from the end (case-insensitive)
    last_word_lower = words[-1].lower()
    count = 1
    for i in range(len(words) - 2, -1, -1):
        if words[i].lower() == last_word_lower:
            count += 1
        else:
            break
    
    if count >= 2:
        # Keep only the first occurrence of the stutter chain
        # words[:-count] = all words before the stutter chain
        # words[-count:] = the stutter chain (all same word)
        # words[-count] = first occurrence of the stuttered word (kept)
        return " ".join(words[:-count] + [words[-count]]).strip()
    
    return text


def cleanup_transcription_text(text: str, duration_s: float) -> str:
    normalized = re.sub(r"\s+", " ", text or "").strip()
    if not normalized:
        return ""

    lowered = normalized.lower().strip(" .,!?:;¡!¿?\"'`[]()")

    # Exact match for common hallucinations — apply to ALL segments regardless of
    # duration. Hallucinations occur at segment boundaries regardless of length.
    if lowered in GRATITUDE_PHRASES or lowered in EDGE_HALLUCINATION_PHRASES:
        return ""

    words = normalized.split()
    # Check suffixes/prefixes for gratitude phrases — apply to ALL segments.
    if len(words) >= 2:
        for phrase in GRATITUDE_PHRASES:
            prefix_pattern = re.compile(rf"^[\s\.,;:!\?¡¿-]*{re.escape(phrase)}[\s\.,;:!\?¡¿-]+", re.IGNORECASE)
            suffix_pattern = re.compile(rf"[\s\.,;:!\?¡¿-]+{re.escape(phrase)}[\s\.,;:!\?¡¿-]*$", re.IGNORECASE)

            # Remove all occurrences — no duration gate (hallucinations occur at any length)
            old_norm = None
            while old_norm != normalized:
                old_norm = normalized
                normalized = prefix_pattern.sub("", normalized).strip()
                normalized = suffix_pattern.sub("", normalized).strip()

    # Remove frequent hallucinated tail/opening chunks (e.g. "un saludo", "al final")
    # Apply to ALL segments — hallucinations at edges are independent of segment length.
    for phrase in EDGE_HALLUCINATION_PHRASES:
        edge_prefix = re.compile(rf"^[\s\.,;:!\?¡¿\-\"]*{re.escape(phrase)}[\s\.,;:!\?¡¿\-\"]+", re.IGNORECASE)
        edge_suffix = re.compile(rf"[\s\.,;:!\?¡¿\-\"]+{re.escape(phrase)}[\s\.,;:!\?¡¿\-\"]*$", re.IGNORECASE)

        previous = None
        while previous != normalized:
            previous = normalized
            normalized = edge_prefix.sub("", normalized).strip()
            normalized = edge_suffix.sub("", normalized).strip()

    # Strip repeated-word stuttering at end of segment (e.g. "gracias gracias", "Y Y Y")
    normalized = _strip_trailing_stutter(normalized)

    # Apply user word substitutions
    text = apply_word_substitutions(normalized)

    # Strip trailing exclamation marks and whitespace. Whisper frequently appends
    # an isolated "!" to short segments (especially gratitude / "al canal" tails),
    # which leaks into the final transcript and is rarely intended. Question marks
    # and periods are preserved — those are more likely to be speaker-intended
    # punctuation from the user. Exclamation strips are aggressive; the
    # word-substitution step above can still emit "!" if the user's mapping ends
    # with one (we re-apply the strip after substitutions to clean both sources).
    text = text.rstrip("!").rstrip()

    return text


def transcribe_whispercpp(audio_int16: np.ndarray, language: str, is_final: bool = True) -> tuple[str, str | None]:
    # Fast path: if server is already running with the cached model, skip expensive file search
    if whisper_server_process is not None and whisper_server_model_path:
        model_path = whisper_server_model_path
        if not is_whisper_server_ready():
            ready, error = ensure_whisper_server(model_path, gpu_enabled)
            if not ready:
                return "", f"whisper-server no disponible: {error}"
    else:
        status = get_whispercpp_status(selected_model)
        if not status.get("available", False):
            return "", f"whisper.cpp no disponible: {status.get('reason', 'unknown reason')}"
        model_path = status.get("model_path", "")
        if not model_path:
            return "", "whisper.cpp executable/model path missing"
        ready, error = ensure_whisper_server(model_path, gpu_enabled)
        if not ready:
            return "", f"whisper-server no disponible: {error}"

    # OPTIMIZATION: Use In-Memory Buffer (io.BytesIO) instead of disk I/O
    try:
        wav_buffer = io.BytesIO()
        audio_contiguous = np.ascontiguousarray(audio_int16.reshape(-1).astype(np.int16))
        
        with wave.open(wav_buffer, "wb") as wav_writer:
            wav_writer.setnchannels(1)
            wav_writer.setsampwidth(2)
            wav_writer.setframerate(RATE)
            wav_writer.writeframes(audio_contiguous.tobytes())
        
        # Reset pointer to start to read bytes
        wav_buffer.seek(0)
        audio_bytes = wav_buffer.read()

        _, _, inference_url = whisper_server_urls()
        
        # Performance trick: disable timestamps on partial generations to get ultra-fast chunk response
        timestamps_flag = "false" if is_final else "true"
        
        fields: dict[str, str] = {
            "response_format": "json",
            "temperature": "0.0",
            "temperature_inc": "0.0",
            "no_timestamps": timestamps_flag, 
            "suppress_non_speech": "true",
        }
        if language and language != "auto":
            fields["language"] = language
            if language == "en":
                fields["task"] = "translate"

        status_code, response_text = http_post_multipart(
            inference_url,
            fields=fields,
            file_field=("file", "chunk.wav", audio_bytes, "audio/wav"),
            timeout_s=120.0,
        )

        if status_code != 200:
            return "", f"whisper-server respondió {status_code}: {response_text[:240]}"

        try:
            payload = json.loads(response_text)
            text = str(payload.get("text", "")).strip()
        except Exception:
            text = extract_whispercpp_text(response_text)

        return text, None
    except urllib.error.HTTPError as e:
        response = e.read().decode("utf-8", errors="ignore") if hasattr(e, "read") else ""
        return "", f"whisper-server HTTP error {e.code}: {response[:240]}"
    except urllib.error.URLError as e:
        return "", f"whisper-server URL error: {e}"
    except Exception as e:
        return "", f"whisper.cpp error: {e}"


def command_listener():
    global recording, selected_device, selected_model, selected_model_dir, selected_language, gpu_enabled, selected_backend, current_recording_id, session_transcript, stopping
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
            
        # Add basic log to track incoming UI commands
        if not line.startswith("HARDWARE"):
            emit({"log": f"UI->Engine Command: {line[:100]}"})
            
        if line == "START":
            if active_backend == "whispercpp":
                model_ready = bool(get_whispercpp_status(selected_model).get("available", False))
            else:
                with model_lock:
                    model_ready = model_whisper is not None

            if not model_ready:
                active_model = load_backend(selected_model, gpu_enabled, selected_backend)
                if not active_model:
                    emit({"error": "No model is ready. Download a compatible model and refresh hardware."})
                    emit({"status": "stopped"})
                    continue

            try:
                with audio_queue.mutex:
                    audio_queue.queue.clear()
                start_input_stream(selected_device)
            except Exception as e:
                emit({"error": f"Audio Stream Error: {e}"})
                continue
            current_recording_id += 1
            session_transcript = ""  # Reset session buffer on new recording
            stopping = False  # Reset stop flag for new session
            recording = True
            inject_pre_roll_audio()
            emit({"status": "recording"})
        elif line == "STOP":
            stopping = True  # Signal worker to flush immediately without queue drain
            recording = False
            # Clear pre-roll buffer so next session starts fresh — no stale audio
            with pre_roll_lock:
                pre_roll_chunks.clear()
            # We do NOT emit "stopped" here.
            # The main loop detects recording=False, flushes the final audio chunk to the queue,
            # and posts a {"type": "STOP"} message. The worker checks `stopping` first and
            # emits "stopped" immediately without waiting for queue drain.
        elif line == "EXIT":
            emit({"log": "Received EXIT command. Shutting down."})
            break
        elif line == "HARDWARE":
            emit(get_hardware_info())
        elif line == "RELOAD_DICT":
            load_word_dictionary()
            emit({"log": "Word dictionary reloaded"})
        elif line.startswith("CONFIG "):
            try:
                payload = json.loads(line[len("CONFIG "):])
                microphone = str(payload.get("microphone", "default"))
                model = str(payload.get("model", selected_model))
                model_dir = str(payload.get("model_dir", selected_model_dir or "")).strip()
                language = str(payload.get("language", selected_language))
                prefer_gpu = bool(payload.get("gpu_enabled", gpu_enabled))
                backend = normalize_backend_name(str(payload.get("backend", selected_backend)))
                
                config_uuid = str(uuid.uuid4())[:6]
                emit({"log": f"Received CONFIG [{config_uuid}]: model={model}, gpu={prefer_gpu}, backend={backend}"})

                # Sanitize model name: __custom_file__ is invalid, use default
                if model == "__custom_file__" or not model or model.startswith("__"):
                    model = "large-v3-turbo"

                # Quality policy: when GPU is enabled and large-v3-turbo is available,
                # avoid staying on tiny due stale UI state from previous fallback tests.
                if prefer_gpu and model == "tiny":
                    try:
                        downloaded = get_downloaded_models()
                        has_large_turbo = any(item.get("id") == "large-v3-turbo" and item.get("downloaded", True) for item in downloaded)
                        if has_large_turbo:
                            emit({"log": "GPU mode active: promoting model from tiny to large-v3-turbo for better quality."})
                            model = "large-v3-turbo"
                    except Exception:
                        pass

                # Sanitize model_dir: ignore it if it doesn't exist or has no models
                if model_dir and model_dir not in ("__default__", ""):
                    model_dir_path = Path(model_dir)
                    has_models = (
                        model_dir_path.exists() and 
                        model_dir_path.is_dir() and 
                        (any(model_dir_path.glob("*.bin")) or any(model_dir_path.glob("*.gguf")))
                    )
                    if not has_models:
                        model_dir = ""
                
                if model_dir in ("__default__", ""):
                    model_dir = ""

                previous_device = selected_device

                if microphone == "default":
                    selected_device = None
                elif isinstance(microphone, str) and microphone.startswith("pw_"):
                    selected_device = microphone
                else:
                    selected_device = int(microphone)
                if selected_device != previous_device and not recording:
                    try:
                        start_input_stream(selected_device, force_restart=True)
                    except Exception as e:
                        emit({"error": f"No se pudo actualizar el micrófono activo: {e}"})

                if model == "voxtral-mini-4b-realtime-2602":
                    emit({"error": "Voxtral requiere runtime vLLM... Usa Linux."})
                    model = selected_model

                model_changed = model != selected_model
                model_dir_changed = model_dir != selected_model_dir
                gpu_changed = prefer_gpu != gpu_enabled
                # Compare RESOLVED backends to avoid false positives when "auto" and
                # "faster-whisper" refer to the same actual backend.
                # Use selected_backend (previous config value) NOT active_backend
                # (which is pre-initialized to "faster-whisper" and would prevent the
                # very first load from ever triggering).
                prev_resolved = resolve_backend(selected_model, gpu_enabled, selected_backend)
                new_resolved = resolve_backend(model, prefer_gpu, backend)
                backend_changed = new_resolved != prev_resolved
                # If nothing is loaded yet, always trigger a load regardless of flags.
                nothing_loaded = loaded_model == "" or model_whisper is None

                selected_language = language
                gpu_enabled = prefer_gpu
                selected_backend = backend
                selected_model_dir = model_dir

                if selected_model_dir:
                    os.environ["WHISPERCPP_MODEL_DIR"] = selected_model_dir

                if nothing_loaded or model_changed or model_dir_changed or gpu_changed or backend_changed:
                    selected_model = model
                    emit({"log": f"Engine config updated [{config_uuid}] (async load pending)"})
                    load_backend_async(selected_model, gpu_enabled, selected_backend)
                else:
                    selected_model = model
                    emit({"log": f"Engine config updated [{config_uuid}] (no change — skipping reload)"})
                    emit(get_hardware_info())

                load_word_dictionary()

            except Exception as e:
                emit({"error": f"Invalid CONFIG payload: {e}"})

        elif line.startswith("DOWNLOAD "):
            payload_str = line[len("DOWNLOAD "):].strip()
            model_name = ""
            download_dir = None
            
            try:
                # Try parsing as JSON first
                payload = json.loads(payload_str)
                if isinstance(payload, dict):
                    model_name = payload.get("model", "")
                    download_dir = payload.get("dir")
                else:
                     model_name = str(payload).strip()
            except json.JSONDecodeError:
                # Fallback to plain string
                model_name = payload_str
            
            if model_name:
                threading.Thread(target=download_model_to_cache, args=(model_name, download_dir), daemon=True).start()
            else:
                emit({"error": "DOWNLOAD command missing model name"})
        elif line.startswith("DELETE_MODEL "):
            try:
                payload = json.loads(line[len("DELETE_MODEL "):])
                model_id = payload.get("model", "")
                model_path = payload.get("path", "")
                
                if not model_id:
                    emit({"error": "DELETE_MODEL missing model ID"})
                    continue

                emit({"log": f"Deleting model: {model_id}"})
                
                # Check if it's a file path (custom/whisper.cpp)
                if model_path and os.path.exists(model_path):
                     try:
                        p = Path(model_path)
                        if p.is_file():
                            p.unlink()
                            emit({"log": f"Deleted model file: {model_path}"})
                        elif p.is_dir():
                            # Safety check: Is this really a model dir?
                            # For faster-whisper/huggingface, it's a dir with 'snapshots', etc. or a specific snapshot.
                            # We should be careful.
                            # If it's a HF repo dir like "models--Systran--faster-whisper-tiny"
                            import shutil
                            shutil.rmtree(model_path)
                            emit({"log": f"Deleted model directory: {model_path}"})
                     except Exception as e:
                        emit({"error": f"Failed to delete {model_path}: {e}"})
                
                # If no path provided, try to find it in HF cache via scan_cache_dir (complex)
                # For now, we rely on the frontend passing the path if known.
                # If not, we can try to use HfApi to find the cache path.
                
                emit(get_hardware_info())

            except Exception as e:
                 emit({"error": f"DELETE_MODEL failed: {e}"})

    # When we break out of the loop (EOF on stdin), the parent process has closed the pipe.
    # This means Tauri has been killed or shut down. We must exit to prevent zombie processes.
    emit({"log": "Stdin closed. Parent process likely died. Cleaning up and exiting."})
    stop_whisper_server()
    os._exit(0)

if __name__ == "__main__":
    try:
        log_path = setup_logging()
        logging.info("Logging initialized.")
        main()
    except Exception as e:
        import traceback
        error_details = traceback.format_exc()
        logging.critical(f"UNCAUGHT EXCEPTION: {e}\n{error_details}")
        emit({"error": f"Uncaught exception in main: {e}", "log": error_details})
        sys.exit(1)
