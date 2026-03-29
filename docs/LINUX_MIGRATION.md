# Migración completa a Linux (Veloz Voice)

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
  libwebkit2gtk-4.1-dev libxdo-dev \
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
pkill -f "next|bun|cargo|veloz-voice" || true
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

## 13) Estabilización Específica (Wayland, CUDA, PipeWire)

La arquitectura de Veloce incluye estabilizaciones especiales necesarias para entornos Linux modernos:

### Bloqueo de Atajos Globales en Wayland
Como medida de seguridad, los compositores Wayland bloquean la lectura global del teclado a nivel de aplicación, inhabilitando los atajos de Tauri (`tauri-plugin-global-shortcut`). Para evadir este límite en Wayland sin requerir permisos de `root`:
1. El backend en Rust levanta un **microservidor HTTP en segundo plano** local (puerto `41414`).
2. El usuario debe configurar el atajo a **nivel del Sistema Operativo** (Ajustes de Kali / GNOME -> Teclado).
3. El atajo nativo debe ejecutar el comando: `curl -s http://127.0.0.1:41414/toggle`.
4. El servidor local en Rust recibe el comando y emite un evento `global-toggle-capture` al frontend React.

### Minimización Inconsistente en Wayland
Las animaciones de cierre (`Framer Motion`) provocan parpadeos y ventanas "fantasma" invisibles si el decorador de ventanas de Wayland redimensiona la aplicación *antes* de finalizar la animación. Se introdujo un delay asíncrono (`setTimeout` de 250ms) antes de aplicar un `window.setSize` minúsculo para permitir la salida limpia de los componentes.

### Estabilización del Motor de Audio
1. **Detección de Crash en PipeWire:** Se manejan excepciones para el error `PaErrorCode -9988` (Puntero de Stream Inválido) de PortAudio/PipeWire forzando un reinicio limpio del backend sin tirar la aplicación Rust.
2. **Alucinaciones Whisper:** Al no inyectar ruido o voz, el modelo puede "alucinar" frases como *"¿qué es lo que se ha hablado?"* o *"gracias por ver el video"*. Esto se parcha mediante el diccionario `GRATITUDE_PHRASES` y limpieza por RegEx estricta en el bucle de transcripción final del Python intermedio.
3. **Repeticiones (Ecos) de Final de Frase:** La función nativa de retener 1.5 segundos de "overlap" (solapamiento) de audio para contextualizar a Whisper causaba una duplicación física de los bytes de la última palabra hablada tras dispararse el Voice Activity Detection (VAD). Este buffer fue vaciado completamente a cero, permitiendo que la transición a texto ocurra limpiamente.

### Restricciones "Always On Top" en GNOME Wayland
Los compositores modernos de Wayland (especialmente Mutter en GNOME/Kali) bloquean activamente cualquier intento programático de fijar una ventana superpuesta (`setAlwaysOnTop`) si no cuenta con decoraciones o con rol asignado por sistema.
- **Solución implementada:** Se inyectó dinámicamente la variable de entorno `std::env::set_var("GDK_BACKEND", "x11");` en el punto de entrada de la aplicación en Rust (`src-tauri/src/main.rs`). Esto obliga a Tauri y WebKitGTK a operar en capa **XWayland (emulador X11)**, permitiendo saltarse las restricciones estrictas de Wayland y validando correctamente las ventanas siempre al frente.

### UX (Experiencia de Usuario) Minimizado
Debido a la naturaleza compartida de los eventos del ratón (Drag & Drop vs Clics) en marcos WebView sin decoraciones, la acción de sujetar el widget flotante con clics para moverlo (`data-tauri-drag-region`) detonaba accidentalmente el evento de expansión global `onClick` en DOM al soltarse. Se reemplazó estandarizadamente a interacción del tipo `onDoubleClick`, imitando el comportamiento nativo de widgets de sistema de Linux y macOS.

### Soporte a Hotplug de Micrófonos en PipeWire
Al utilizar la herramienta combinada de `wpctl` (PipeWire) sobre PortAudio/ALSA, los identificadores de nuevos micrófonos se abstraen temporalmente bajo strings ("pw_85") hasta reiniciar el stream. El backend detectaba esto y arrojaba una excepción silenciosa `ValueError` al castear el str a integer, bloqueando el refresco de dispositivos. Se corrigió la delegación de `selected_device` para inyectar correctamente la variable de entorno `PIPEWIRE_NODE` desde strings dinámicos, liberando el `device_id` natural al default wrapper de ALSA.

### Intercepción de Clics en Widget Minimizado
Debido a que XWayland y X11 manejan las áreas transparentes de la ventana como superficies sólidas que interceptan eventos del puntero magnético, el `MINI_WIDTH` de 240px x 68px original sobre-alcanzaba el componente visual del widget tipo "píldora" (que era de ~170px x 44px). Esto provocaba que clescar al lado del widget tomara el evento la app Veloce, bloqueando clics en ventanas de fondo (ej: barras superiores u otras aplicaciones). Se ajustó el tamaño lógico de Tauri (`184x56`) para que envuelva ajustadamente al componente, liberando el espacio invisible para que los eventos del ratón pasen limpiamente a través del sistema operativo.
