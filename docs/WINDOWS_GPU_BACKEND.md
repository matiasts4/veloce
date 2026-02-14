# Windows GPU Backend (AMD/NVIDIA)

Para instalación completa en otros equipos (instalador, validación y troubleshooting), revisa:

- `docs/WINDOWS_INSTALL_DEPLOY.md`

Esta app ahora soporta selección de backend:

- `auto` (recomendado)
- `faster-whisper`
- `whisper.cpp`

En Windows con AMD, `auto` intenta usar `whisper.cpp` cuando:

1. No hay `CUDA` disponible para `faster-whisper`.
2. Existe `whisper-cli.exe`.
3. Existe un modelo `ggml/gguf` compatible con el modelo elegido.

## 1) Instalar whisper.cpp con Vulkan

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

## 2) Descargar modelo compatible

Coloca un modelo `ggml/gguf` en una carpeta local, por ejemplo:

- `python/whispercpp/models/ggml-large-v3-turbo.bin`

Puedes usar también nombres cuantizados (`ggml-large-v3-turbo-q5_0.bin`) y la app intentará detectarlos.

## 3) Variables opcionales (recomendado)

Si usas rutas personalizadas, define:

```powershell
setx WHISPERCPP_EXE "C:\ruta\a\whisper-cli.exe"
setx WHISPERCPP_MODEL_DIR "C:\ruta\a\models"
```

Abre una terminal nueva después de `setx`.

## 4) En la app

1. Abre `Settings`.
2. Selecciona modelo (`large-v3-turbo` recomendado).
3. En **Backend de inferencia**, usa `Auto` (o `whisper.cpp` manual).
4. Activa GPU.

Si falta algo, la UI mostrará motivo (ejecutable faltante/modelo faltante).

## 5) Prioridad de detección

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
