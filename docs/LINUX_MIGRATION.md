# Migración completa a Linux (Veloce)

Esta guía te deja el proyecto listo para desarrollo diario en Linux, evitando subir artefactos pesados a Git.

## 1) Objetivo

Al terminar tendrás:

- Entorno Linux preparado para `Tauri + Next + Python`.
- Sidecar de audio funcionando (`python/audio_engine.py`).
- Flujo de desarrollo estable con `bun run tauri dev`.
- Repositorio limpio (sin cachés/builds/modelos pesados en Git).

## 2) Requisitos recomendados

- Distribución: Ubuntu 24.04 LTS (o derivada compatible).
- CPU: 6+ núcleos recomendados.
- RAM: mínimo 16 GB (ideal 32 GB para modelos grandes).
- GPU: opcional para Whisper, recomendada para modelos pesados.

## 3) Dependencias del sistema

## Ubuntu/Debian

```bash
sudo apt update
sudo apt install -y \
  build-essential pkg-config curl wget git file \
  libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev \
  libwebkit2gtk-4.1-dev \
  python3 python3-venv python3-dev python3-pip \
  portaudio19-dev libasound2-dev \
  libx11-dev libxi-dev libxtst-dev
```

Notas:

- `portaudio19-dev` es clave para `sounddevice`.
- Las libs `x11/xi/xtst` ayudan al input simulado (`enigo`) en Linux.

## 4) Instalar Rust, Bun y Node

### Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
rustc --version
cargo --version
```

### Bun

```bash
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
bun --version
```

### Node (si lo necesitas para herramientas auxiliares)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version
npm --version
```

## 5) Clonar y preparar el proyecto

```bash
git clone <TU-REPO-URL>
cd veloz-voice-desktop-app
```

### Dependencias frontend

```bash
bun install
```

### Entorno Python

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip wheel setuptools
pip install -r python/requirements.txt
```

Verificación rápida:

```bash
python -m py_compile python/audio_engine.py
```

## 6) Ejecutar en desarrollo

```bash
bun run tauri dev
```

Si hay puertos/procesos colgados:

```bash
pkill -f "next|bun|cargo|veloce" || true
rm -f .next/dev/lock
bun run tauri dev
```

## 7) Build de producción

```bash
bun run build
cd src-tauri
cargo check
cd ..
bun run tauri build
```

## 8) Configuración Git para evitar subir peso

El `.gitignore` del repo ya está reforzado para excluir:

- Builds (`src-tauri/target`, `.next`, `out`, `build`, `dist`).
- Entornos/cachés de Python (`.venv`, `__pycache__`, etc.).
- Pesos/modelos grandes (`*.safetensors`, `*.bin`, `*.onnx`, `*.pt`, etc.).
- Cachés y carpetas de modelos locales (`.cache`, `models`, `checkpoints`).

### Verificar antes de commit

```bash
git status
```

### Si ya agregaste archivos pesados por error

```bash
git rm -r --cached .
git add .
git commit -m "chore: reindex with gitignore"
```

## 9) Ubicaciones recomendadas de modelos en Linux

Para mantener orden y no contaminar el repo:

- Usa caché global de Hugging Face en `~/.cache/huggingface`.
- No guardes modelos dentro del proyecto salvo que sea intencional.
- Si necesitas ruta personalizada:

```bash
export HF_HOME="$HOME/.cache/huggingface"
```

Puedes ponerlo en `~/.bashrc` para persistir.

## 10) Troubleshooting rápido

### Error de `sounddevice` o PortAudio

- Reinstala: `sudo apt install -y portaudio19-dev libasound2-dev`
- Reinstala wheel: `pip install --force-reinstall sounddevice`

### Error de WebKitGTK/Tauri al compilar

- Verifica `libwebkit2gtk-4.1-dev` instalado.
- Limpia y recompila:

```bash
rm -rf src-tauri/target
cargo check --manifest-path src-tauri/Cargo.toml
```

### El sidecar Python no inicia

- Asegura que el comando `python` exista en PATH del proceso Tauri.
- Si en Linux solo existe `python3`, crea alias o symlink:

```bash
sudo ln -sf /usr/bin/python3 /usr/local/bin/python
```

## 11) Flujo recomendado diario

```bash
source .venv/bin/activate
bun run tauri dev
```

Antes de push:

```bash
git status
git add .
git commit -m "feat: ..."
git push
```

## 12) Checklist final de migración

- [ ] Compila Rust: `cargo check --manifest-path src-tauri/Cargo.toml`
- [ ] Compila Python engine: `python -m py_compile python/audio_engine.py`
- [ ] Corre app: `bun run tauri dev`
- [ ] `.gitignore` bloquea artefactos pesados
- [ ] `git status` muestra solo código/config/docs relevantes
