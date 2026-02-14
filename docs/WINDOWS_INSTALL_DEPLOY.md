# Guía Windows: instalación y despliegue en otros equipos

Esta guía está pensada para replicar **la misma configuración** en múltiples PCs sin romper backend/modelos.

## 1) Qué necesitas en el equipo destino

Mínimo recomendado:

- Windows 10/11 x64.
- `Python 3.10+` instalado y en `PATH`.
- Micrófono habilitado en Windows.

Opcional (solo para GPU AMD/NVIDIA con `whisper.cpp`):

- `whisper.cpp` compilado (Vulkan) + modelo `ggml/gguf` local.

## 2) Instalar la app (instalador)

Usa el instalador generado en este proyecto:

- `src-tauri/target/release/bundle/nsis/veloce_0.1.0_x64-setup.exe` (recomendado)
- `src-tauri/target/release/bundle/msi/veloce_0.1.0_x64_en-US.msi`

Recomendación de despliegue:

1. Desinstalar versiones anteriores.
2. Instalar la versión nueva.
3. Abrir Veloce una vez para que cree configuración local.

## 3) Configuración base estable (en la app)

En `Configuración`:

1. **Backend de inferencia**: `Auto`.
2. **Modelo**: `large-v3-turbo` (o el que tengas descargado).
3. **Ruta de modelos**: si usas modelos locales, apunta a carpeta (ejemplo: `C:/wsp/models`).
4. Pulsa **Actualizar** para re-detectar hardware/modelos.
5. (Opcional) Activa **Iniciar con Windows**.

## 4) Cómo descargar / preparar modelos

### Opción A: `faster-whisper` (CPU/CUDA)

- Descarga modelos desde Hugging Face (familia `faster-whisper`).
- Luego en la app pulsa **Actualizar** para que aparezcan en la lista.

### Opción B: `whisper.cpp` (recomendada en Windows + AMD)

Puedes usar el script incluido:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\setup-whispercpp.ps1 -Model large-v3-turbo
```

Esto deja:

- binarios `whisper.cpp`
- modelo `ggml-large-v3-turbo.bin`
- variables de entorno (`WHISPERCPP_EXE`, `WHISPERCPP_MODEL_DIR`)

También puedes **no usar variables** y definir la carpeta en la app con **Ruta de modelos**.

## 5) Checklist para que no se rompa

En cada equipo nuevo valida:

- La app abre y muestra estado `Listo`.
- En `Configuración > Backend activo` aparece uno válido.
- Hay modelos visibles en el selector.
- `Actualizar` no muestra error de `Audio engine is not running`.

## 6) Errores comunes y solución

### “Audio engine is not running”

Causa típica: Python no disponible en el equipo o bloqueo al iniciar sidecar.

Solución:

1. Verifica Python:
   ```powershell
   python --version
   ```
2. Reinicia app y usa **Actualizar**.
3. Si persiste, reinstala Python 64-bit y vuelve a abrir la app.

### “Audio engine script not found in dev/bundle paths”

La app ya incluye fallback embebido, pero si aparece:

1. Reinstala con el instalador más nuevo.
2. Ejecuta la app una vez como usuario normal (crea archivos de app data).

### No aparecen modelos

1. Verifica `Ruta de modelos` en settings.
2. Usa carpeta con archivos `ggml-*.bin` o `ggml-*.gguf`.
3. Pulsa **Actualizar**.

### Backend `whisper.cpp` no disponible

1. Confirma ejecutable `whisper-cli.exe`.
2. Confirma modelo en la carpeta configurada.
3. Revisa guía detallada: `docs/WINDOWS_GPU_BACKEND.md`.

## 7) Perfil recomendado para replicar en empresa/equipo

- Backend: `Auto`
- Modelo: `large-v3-turbo`
- Ruta de modelos: carpeta estándar compartida (ej. `C:/wsp/models`)
- Modo de captura: `Toggle`
- Inicio con Windows: `ON`
- Portapapeles: según política (`copiar` o `copiar+pegar`)

Con ese perfil la app queda consistente entre equipos con mínima intervención manual.
