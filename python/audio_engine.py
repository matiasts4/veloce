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
from collections import deque
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
PRE_ROLL_SECONDS = 1.5
WHISPERCPP_SERVER_HOST = "127.0.0.1"
WHISPERCPP_SERVER_PORT = 8178
WHISPERCPP_SERVER_HEALTH_TIMEOUT = 30.0

GRATITUDE_PHRASES = [
    "gracias",
    "muchas gracias",
    "gracias por ver",
    "thank you",
    "thanks",
]

# Globals
recording = False
current_recording_id = 0
audio_queue = queue.Queue()
selected_device = None
selected_model = "large-v3-turbo"
selected_model_dir = ""
selected_language = "es"
gpu_enabled = True
selected_backend = "auto"
active_backend = "faster-whisper"
current_stream = None
model_whisper = None
model_lock = threading.Lock()
download_lock = threading.Lock()
model_load_lock = threading.Lock()
whisper_server_lock = threading.Lock()
whisper_server_process = None
whisper_server_model_path = ""
pre_roll_chunks = deque(maxlen=max(1, int((RATE * PRE_ROLL_SECONDS) / CHUNK)))
pre_roll_lock = threading.Lock()

# Reduce CPU thread pressure to avoid MKL/OMP memory spikes on Windows.
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

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


def project_root() -> Path:
    return Path(__file__).resolve().parent.parent


def normalize_backend_name(name: str) -> str:
    normalized = (name or "auto").strip().lower()
    return normalized if normalized in SUPPORTED_BACKENDS else "auto"


def get_whispercpp_executable() -> Path | None:
    env_path = os.environ.get("WHISPERCPP_EXE")
    if env_path:
        candidate = Path(env_path)
        if candidate.exists() and candidate.is_file():
            return candidate

    root = project_root()
    candidates = [
        Path("C:/wsp/build/bin/Release/whisper-cli.exe"),
        Path("C:/wsp/build/bin/Release/main.exe"),
        root / "python" / "whispercpp" / "whisper-cli.exe",
        root / "python" / "whispercpp" / "main.exe",
        root / "python" / "whispercpp" / "build" / "bin" / "Release" / "whisper-cli.exe",
        root / "python" / "whispercpp" / "build" / "bin" / "Release" / "main.exe",
        root / "whispercpp" / "build" / "bin" / "Release" / "whisper-cli.exe",
        root / "whispercpp" / "build" / "bin" / "Release" / "main.exe",
    ]

    for candidate in candidates:
        if candidate.exists() and candidate.is_file():
            return candidate

    return None


def get_whispercpp_server_executable() -> Path | None:
    env_path = os.environ.get("WHISPERCPP_SERVER_EXE")
    if env_path:
        candidate = Path(env_path)
        if candidate.exists() and candidate.is_file():
            return candidate

    cli_candidate = get_whispercpp_executable()
    if cli_candidate is not None:
        server_from_cli = cli_candidate.with_name("whisper-server.exe")
        if server_from_cli.exists() and server_from_cli.is_file():
            return server_from_cli

    root = project_root()
    candidates = [
        Path("C:/wsp/build/bin/Release/whisper-server.exe"),
        root / "python" / "whispercpp" / "whisper-server.exe",
        root / "python" / "whispercpp" / "build" / "bin" / "Release" / "whisper-server.exe",
        root / "whispercpp" / "build" / "bin" / "Release" / "whisper-server.exe",
    ]

    for candidate in candidates:
        if candidate.exists() and candidate.is_file():
            return candidate

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


def ensure_whisper_server(model_path: str, prefer_gpu: bool) -> tuple[bool, str]:
    global whisper_server_process, whisper_server_model_path

    server_exe = get_whispercpp_server_executable()
    if server_exe is None:
        return False, "No se encontró whisper-server.exe"

    with whisper_server_lock:
        if whisper_server_process is not None and whisper_server_process.poll() is None and is_whisper_server_ready():
            if whisper_server_model_path == model_path:
                return True, ""

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
            except Exception:
                stop_whisper_server()

        stop_whisper_server()

        command = [
            str(server_exe),
            "--host",
            WHISPERCPP_SERVER_HOST,
            "--port",
            str(WHISPERCPP_SERVER_PORT),
            "-m",
            model_path,
            "-nt",
            "-pp",
        ]
        if not prefer_gpu:
            command.append("-ng")

        try:
            whisper_server_process = subprocess.Popen(
                command,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform.startswith("win") else 0,
            )
        except Exception as e:
            whisper_server_process = None
            return False, f"No se pudo iniciar whisper-server: {e}"

        started_at = time.time()
        while (time.time() - started_at) < WHISPERCPP_SERVER_HEALTH_TIMEOUT:
            if whisper_server_process.poll() is not None:
                whisper_server_process = None
                return False, "whisper-server terminó inesperadamente al iniciar"

            if is_whisper_server_ready():
                whisper_server_model_path = model_path
                return True, ""

            time.sleep(0.3)

        stop_whisper_server()
        return False, "Timeout iniciando whisper-server"


def get_whispercpp_model_dir() -> Path:
    if selected_model_dir:
        return Path(selected_model_dir)

    env_dir = os.environ.get("WHISPERCPP_MODEL_DIR")
    if env_dir:
        return Path(env_dir)

    root = project_root()
    candidates = [
        Path("C:/wsp/models"),
        root / "python" / "whispercpp" / "models",
        root / "whispercpp" / "models",
        root / "models",
    ]

    for candidate in candidates:
        if candidate.exists() and candidate.is_dir():
            return candidate

    return candidates[0]


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
    any_models = [candidate for candidate in any_models if candidate.exists() and candidate.is_file()]
    if any_models:
        any_models.sort(key=lambda path: (len(path.name), path.name))
        model_path = any_models[0]
        return model_path, infer_model_from_whispercpp_filename(model_path)

    return None, ""


def get_whispercpp_status(model_name: str) -> dict:
    executable = get_whispercpp_executable()
    model_file, resolved_model = find_whispercpp_model_file(model_name)
    available = executable is not None and model_file is not None

    reason = ""
    if executable is None:
        reason = "No se encontró whisper-cli.exe. Configura WHISPERCPP_EXE o instala whisper.cpp compilado para Windows."
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

    if requested == "faster-whisper":
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
    if prefer_gpu and not torch.cuda.is_available():
        status = get_whispercpp_status(model_name)
        if status["available"]:
            emit({"log": "Auto backend: usando whisper.cpp para compatibilidad GPU en Windows/AMD."})
            if status.get("resolved_model") and status.get("resolved_model") != model_name:
                emit({"log": f"Auto backend: modelo local usado por whisper.cpp: {status['resolved_model']}"})
            return "whispercpp"

    return "faster-whisper"


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
    global selected_backend, active_backend
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
    gpu_reason = ""
    if not gpu_available:
        torch_version = getattr(torch, "__version__", "unknown")
        if sys.platform.startswith("win") and "+cpu" in torch_version:
            gpu_reason = "PyTorch CPU-only detectado. faster-whisper/CTranslate2 no tiene GPU activa aquí; usa backend Auto/whisper.cpp para intentar aceleración GPU en Windows (si whisper.cpp está instalado con Vulkan)."
        elif sys.platform.startswith("win"):
            gpu_reason = "CUDA no disponible para faster-whisper en este runtime. En Windows puedes usar backend whisper.cpp para GPUs AMD/NVIDIA (con build Vulkan)."
        else:
            gpu_reason = "No se detectó runtime GPU compatible para el backend actual."
    
    models = get_downloaded_models()
    whispercpp_status = get_whispercpp_status(selected_model)

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
        model_file, _ = find_whispercpp_model_file(model_entry["id"])
        if model_file is not None:
            model_entry["downloaded"] = True

    merged_models = {m["id"]: m for m in fallback_models}
    for model in models:
        merged_models[model["id"]] = model
    
    return {
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
        "models": sorted(list(merged_models.values()), key=lambda model: model["id"])
    }


def load_whisper(model_name, prefer_gpu):
    global model_whisper
    if prefer_gpu and not torch.cuda.is_available():
        emit({"error": "GPU mode requested but no compatible GPU runtime was detected. Running on CPU."})

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


def load_backend(model_name, prefer_gpu, backend_name):
    global active_backend, model_whisper

    chosen_backend = resolve_backend(model_name, prefer_gpu, backend_name)

    if chosen_backend == "whispercpp":
        emit({"status": "loading_model"})

        with model_lock:
            previous_model = model_whisper
            model_whisper = None

        if previous_model is not None:
            del previous_model
            gc.collect()

        status = get_whispercpp_status(model_name)
        if not status["available"]:
            emit({"error": f"whisper.cpp no disponible: {status['reason']}"})
            active_model = load_whisper(model_name, prefer_gpu)
            active_backend = "faster-whisper" if active_model else "none"
            return active_model

        resolved_model = status.get("resolved_model") or model_name
        model_path = status.get("model_path", "")
        ready, error = ensure_whisper_server(model_path, prefer_gpu)
        if not ready:
            emit({"error": f"No se pudo inicializar whisper-server: {error}"})
            active_model = load_whisper(model_name, prefer_gpu)
            active_backend = "faster-whisper" if active_model else "none"
            return active_model

        active_backend = "whispercpp"
        emit({"status": "ready"})
        emit({"log": f"Model ready: {resolved_model} on whisper.cpp server ({model_path})"})
        return resolved_model

    active_backend = "faster-whisper"
    active_model = load_whisper(model_name, prefer_gpu)
    if not active_model:
        active_backend = "none"
    return active_model


def load_backend_async(model_name, prefer_gpu, backend_name):
    def _run():
        active_model = load_backend(model_name, prefer_gpu, backend_name)
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

    def audio_callback(indata, frames, callback_time, status):
        if status:
            return
        chunk = indata.copy()
        with pre_roll_lock:
            pre_roll_chunks.append(chunk)
        if recording:
            audio_queue.put(chunk)

    if current_stream is not None and not force_restart:
        return

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


def inject_pre_roll_audio():
    with pre_roll_lock:
        chunks = list(pre_roll_chunks)

    for chunk in chunks:
        audio_queue.put(chunk)

def main():
    # Emit hardware info immediately
    emit(get_hardware_info())
    load_backend(selected_model, gpu_enabled, selected_backend)

    try:
        start_input_stream(selected_device)
    except Exception as e:
        emit({"error": f"Audio Stream Warmup Error: {e}"})

    # Command listener thread
    threading.Thread(target=command_listener, daemon=True).start()

    emit({"log": "Audio engine started"})

    buffer = []
    buffered_frames = 0
    max_frames = RATE * MAX_BUFFER_SECONDS if MAX_BUFFER_SECONDS > 0 else 0
    
    while True:
        try:
            if not audio_queue.empty():
                audio_chunk = audio_queue.get()
                buffer.append(audio_chunk)
                buffered_frames += int(audio_chunk.shape[0])

                while max_frames > 0 and buffered_frames > max_frames and buffer:
                    removed = buffer.pop(0)
                    buffered_frames -= int(removed.shape[0])
            
            # If stopped recording but buffer has content, transcribe
            if not recording and len(buffer) > 0:
                emit({"status": "transcribing"})
                transcribe(buffer)
                emit({"status": "ready"})
                buffer = []
                buffered_frames = 0
                # Clear queue to avoid processing stale audio
                with audio_queue.mutex:
                    audio_queue.queue.clear()
            
            else:
                time.sleep(0.01)

        except Exception as e:
            emit({"error": str(e)})
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


def cleanup_transcription_text(text: str, duration_s: float) -> str:
    normalized = re.sub(r"\s+", " ", text or "").strip()
    if not normalized:
        return ""

    lowered = normalized.lower().strip(" .,!?:;¡!¿?\"'`[]()")

    if duration_s <= 4.0 and lowered in GRATITUDE_PHRASES:
        return ""

    words = normalized.split()
    if len(words) >= 6:
        for phrase in GRATITUDE_PHRASES:
            prefix_pattern = re.compile(rf"^\s*{re.escape(phrase)}[\s\.,;:!\?¡¿-]+", re.IGNORECASE)
            suffix_pattern = re.compile(rf"[\s\.,;:!\?¡¿-]+{re.escape(phrase)}\s*$", re.IGNORECASE)

            if duration_s <= 10.0:
                normalized = prefix_pattern.sub("", normalized).strip()
                normalized = suffix_pattern.sub("", normalized).strip()

    return normalized


def transcribe_whispercpp(audio_int16: np.ndarray, language: str) -> tuple[str, str | None]:
    status = get_whispercpp_status(selected_model)
    if not status.get("available", False):
        return "", f"whisper.cpp no disponible: {status.get('reason', 'unknown reason')}"

    model_path = status.get("model_path", "")
    if not model_path:
        return "", "whisper.cpp executable/model path missing"

    ready, error = ensure_whisper_server(model_path, gpu_enabled)
    if not ready:
        return "", f"whisper-server no disponible: {error}"

    wav_temp_file = None
    try:
        wav_temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=".wav")
        wav_path = Path(wav_temp_file.name)
        wav_temp_file.close()

        audio_contiguous = np.ascontiguousarray(audio_int16.reshape(-1).astype(np.int16))
        with wave.open(str(wav_path), "wb") as wav_writer:
            wav_writer.setnchannels(1)
            wav_writer.setsampwidth(2)
            wav_writer.setframerate(RATE)
            wav_writer.writeframes(audio_contiguous.tobytes())

        audio_bytes = wav_path.read_bytes()
        _, _, inference_url = whisper_server_urls()
        fields: dict[str, str] = {
            "response_format": "json",
            "temperature": "0.0",
            "temperature_inc": "0.0",
            "no_timestamps": "true",
            "suppress_non_speech": "true",
        }
        if language and language != "auto":
            fields["language"] = language

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
    finally:
        if wav_temp_file is not None:
            try:
                Path(wav_temp_file.name).unlink(missing_ok=True)
            except Exception:
                pass

def transcribe(buffer):
    global current_recording_id
    if not buffer:
        return

    # sounddevice with CHANNELS=1 yields shape (frames, 1); flatten to mono 1D
    audio_data = np.concatenate(buffer, axis=0)
    if audio_data.ndim > 1:
        audio_data = audio_data[:, 0]

    if audio_data.size < int(RATE * 0.25):
        return

    chunk_duration_s = float(audio_data.size) / float(RATE)

    if active_backend == "whispercpp":
        started_at = time.perf_counter()
        text, error = transcribe_whispercpp(audio_data, selected_language)
        if error:
            emit({"error": error})
            return

        text = cleanup_transcription_text(text, chunk_duration_s)

        elapsed_ms = (time.perf_counter() - started_at) * 1000.0
        if text:
            emit({"transcription": text, "response_ms": elapsed_ms, "recording_id": current_recording_id})
        return

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
    text = cleanup_transcription_text(text, chunk_duration_s)
    elapsed_ms = (time.perf_counter() - started_at) * 1000.0
    
    if text:
        emit({"transcription": text, "response_ms": elapsed_ms, "recording_id": current_recording_id})

def command_listener():
    global recording, selected_device, selected_model, selected_model_dir, selected_language, gpu_enabled, selected_backend, current_recording_id
    for line in sys.stdin:
        line = line.strip()
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
            recording = True
            inject_pre_roll_audio()
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
                model_dir = str(payload.get("model_dir", selected_model_dir or "")).strip()
                language = str(payload.get("language", selected_language))
                prefer_gpu = bool(payload.get("gpu_enabled", gpu_enabled))
                backend = normalize_backend_name(str(payload.get("backend", selected_backend)))

                previous_device = selected_device

                selected_device = None if microphone == "default" else int(microphone)
                if selected_device != previous_device and not recording:
                    try:
                        start_input_stream(selected_device, force_restart=True)
                    except Exception as e:
                        emit({"error": f"No se pudo actualizar el micrófono activo: {e}"})

                if model == "voxtral-mini-4b-realtime-2602":
                    emit({"error": "Voxtral requiere runtime vLLM + GPU (CUDA o ROCm). En Windows esta app no lo ejecuta de forma nativa; usa Linux/WSL con backend GPU compatible. No es compatible con faster-whisper en esta app."})
                    model = selected_model

                model_changed = model != selected_model
                model_dir_changed = model_dir != selected_model_dir
                gpu_changed = prefer_gpu != gpu_enabled
                backend_changed = backend != selected_backend
                selected_language = language
                gpu_enabled = prefer_gpu
                selected_backend = backend
                selected_model_dir = model_dir

                if selected_model_dir:
                    os.environ["WHISPERCPP_MODEL_DIR"] = selected_model_dir
                elif "WHISPERCPP_MODEL_DIR" in os.environ:
                    del os.environ["WHISPERCPP_MODEL_DIR"]

                if model_changed or model_dir_changed or gpu_changed or backend_changed:
                    selected_model = model
                    load_backend_async(selected_model, gpu_enabled, selected_backend)
                else:
                    selected_model = model

                emit({"log": f"Engine config updated: mic={microphone}, model={selected_model}, model_dir={selected_model_dir}, language={selected_language}, gpu={gpu_enabled}, backend={selected_backend}, active_backend={active_backend}"})
                emit(get_hardware_info())
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
