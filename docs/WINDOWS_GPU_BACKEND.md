# Windows GPU Backend (AMD/NVIDIA)

Para instalación completa en otros equipos (instalador, validación y troubleshooting), revisa:

- `docs/WINDOWS_INSTALL_DEPLOY.md`

Esta app soporta selección de backend:

- `auto` (recomendado)
- `faster-whisper`
- `whisper.cpp`

## 1) Compatibilidad NVIDIA/CUDA (qué backend conviene)

### Resumen rápido

- NVIDIA con CUDA funcional: usa `faster-whisper` (o `auto`) para aprovechar CUDA.
- AMD o NVIDIA sin CUDA disponible en Python: `auto` cae a `whisper.cpp` si está instalado.
- `whisper.cpp` en este proyecto está preparado con script Vulkan por defecto.

### ¿NVIDIA + CUDA es compatible?

Sí, es compatible con Veloce por la ruta `faster-whisper` cuando Python detecta CUDA.

Comprobación recomendada en el equipo destino:

```powershell
nvidia-smi
```

Y dentro del entorno Python del proyecto:

```powershell
python -c "import torch; print(torch.cuda.is_available())"
```

Si devuelve `True`, en la app puedes usar `Backend = Auto` con `GPU = ON` y quedará en `faster-whisper`.

### ¿Y CUDA para whisper.cpp?

Es posible compilar `whisper.cpp` con CUDA, pero el script `setup-whispercpp.ps1` actual compila con Vulkan por simplicidad y compatibilidad.

Si necesitas `whisper.cpp` con CUDA, usa compilación manual con flags CUDA (ver sección manual).

## 2) Cómo decide `auto`

En Windows, `auto` prioriza `faster-whisper` con CUDA. Si no hay CUDA disponible en Python, intenta `whisper.cpp` cuando:

1. No hay `CUDA` disponible para `faster-whisper`.
2. Existe `whisper-cli.exe`.
3. Existe un modelo `ggml/gguf` compatible con el modelo elegido.

## 3) Instalar whisper.cpp con Vulkan

### Opción recomendada (automática)

Ejecuta el script del proyecto:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\setup-whispercpp.ps1 -Model large-v3-turbo
```

Opciones útiles:

```powershell
# Reusar instalación existente, solo validar
powershell -ExecutionPolicy Bypass -File .\scripts\windows\setup-whispercpp.ps1 -SkipClone -SkipBuild -SkipDownload

# Forzar ruta de instalación personalizada (por defecto usa C:\wsp)
powershell -ExecutionPolicy Bypass -File .\scripts\windows\setup-whispercpp.ps1 -InstallDir "D:\ai\whispercpp" -Model large-v3-turbo

# Ejecutar setup completo y lanzar app
powershell -ExecutionPolicy Bypass -File .\scripts\windows\setup-whispercpp.ps1 -Model large-v3-turbo -StartApp
```

El script:

- Clona/actualiza `whisper.cpp`.
- Compila con `Vulkan`.
- Descarga `ggml-large-v3-turbo.bin`.
- Configura `WHISPERCPP_EXE` y `WHISPERCPP_MODEL_DIR`.
- Valida que `audio_engine.py` detecta `whisper.cpp`.

Nota: usa `C:\wsp` por defecto para evitar errores de rutas largas en compilación MSVC.

### Opción manual

Compila `whisper.cpp` con Vulkan en Windows (Visual Studio + CMake):

```powershell
git clone https://github.com/ggml-org/whisper.cpp.git
cd whisper.cpp
cmake -B build -DGGML_VULKAN=1
cmake --build build --config Release
```

Ejecutable esperado (ejemplo):

- `whisper.cpp\build\bin\Release\whisper-cli.exe`

### Opción manual CUDA (NVIDIA)

Si quieres compilar `whisper.cpp` con CUDA explícitamente:

```powershell
git clone https://github.com/ggml-org/whisper.cpp.git
cd whisper.cpp
cmake -B build -DGGML_CUDA=1
cmake --build build --config Release
```

Luego configura rutas para Veloce:

```powershell
setx WHISPERCPP_EXE "C:\ruta\whisper.cpp\build\bin\Release\whisper-cli.exe"
setx WHISPERCPP_MODEL_DIR "C:\ruta\whisper.cpp\models"
```

Abre terminal nueva después de `setx`.

## 4) Descargar modelo compatible

Coloca un modelo `ggml/gguf` en una carpeta local, por ejemplo:

- `python/whispercpp/models/ggml-large-v3-turbo.bin`

Puedes usar también nombres cuantizados (`ggml-large-v3-turbo-q5_0.bin`) y la app intentará detectarlos.

## 5) Variables opcionales (recomendado)

Si usas rutas personalizadas, define:

```powershell
setx WHISPERCPP_EXE "C:\ruta\a\whisper-cli.exe"
setx WHISPERCPP_MODEL_DIR "C:\ruta\a\models"
```

Abre una terminal nueva después de `setx`.

## 6) En la app

1. Abre `Settings`.
2. Selecciona modelo (`large-v3-turbo` recomendado).
3. En **Backend de inferencia**, usa `Auto` (o `whisper.cpp` manual).
4. Activa GPU.

Si falta algo, la UI mostrará motivo (ejecutable faltante/modelo faltante).

Validación práctica:

1. Pulsa `Actualizar` en settings.
2. Revisa estado de backend en UI.
3. Si seleccionas `whisper.cpp` y falta algo, verás motivo exacto (exe/modelo).

## 7) Prioridad de detección

La app busca `whisper-cli.exe` en este orden:

1. `WHISPERCPP_EXE`
2. `python/whispercpp/whisper-cli.exe`
3. `python/whispercpp/build/bin/Release/whisper-cli.exe`
4. `whispercpp/build/bin/Release/whisper-cli.exe`

Y modelos en:

1. `WHISPERCPP_MODEL_DIR`
2. `python/whispercpp/models`
3. `whispercpp/models`
4. `models`

## 8) Diagnóstico rápido de errores

- `torch.cuda.is_available() = False` en NVIDIA:
	- Actualiza drivers NVIDIA.
	- Revisa que `nvidia-smi` funcione.
	- Verifica instalación de dependencias Python del proyecto.
- `whisper-cli.exe` no encontrado:
	- Ejecuta script `setup-whispercpp.ps1` o define `WHISPERCPP_EXE`.
- Modelo no encontrado:
	- Descarga un `ggml/gguf` y define `WHISPERCPP_MODEL_DIR` si corresponde.

## 9) Perfil de rendimiento recomendado (equipo destino)

### NVIDIA RTX 4060 6GB

- Backend recomendado: `faster-whisper` (o `Auto`) con `GPU = ON`.
- Modelo recomendado para estabilidad/rendimiento: `large-v3-turbo`.
- El engine ahora ajusta `compute_type` automáticamente:
	- VRAM baja: `int8_float16` (menos uso de memoria, más estable).
	- VRAM suficiente: `float16`.

Si ves consumo alto o latencia variable, prueba `distil-large-v3` o `medium`.

### AMD (ej. RX 9070 XT)

- Backend recomendado: `whisper.cpp` con build Vulkan.
- Modelo recomendado: `large-v3-turbo`.
- En esta ruta, la aceleración depende de cómo se compiló `whisper.cpp` (Vulkan/CUDA).

## 10) Leer los logs nuevos de depuración

Busca estas líneas en `engine-log`:

- `faster-whisper runtime: ...`
	- Muestra `device`, `compute_type`, `cuda_available`, `torch`, `gpu`, `vram_gb`.
- `Auto backend: ...`
	- Indica por qué eligió `whisper.cpp` o por qué cayó a CPU.
- `Backend faster-whisper seleccionado con GPU ON...`
	- Aclara cuando GPU está activada en UI pero CUDA no está listo en runtime.

Objetivo: diferenciar claramente incompatibilidad CUDA de `faster-whisper` versus disponibilidad real de `whisper.cpp`.
