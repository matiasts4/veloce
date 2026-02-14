# Guía Windows: instalación en equipo nuevo (todo en uno)

Esta versión de Veloce se instala en Windows con instalador completo y motor embebido.

Si necesitas configuración avanzada de GPU/backends (NVIDIA CUDA, AMD, whisper.cpp), revisa también:

- `docs/WINDOWS_GPU_BACKEND.md`

## 1) Qué ejecutar en el equipo nuevo

Usa uno de estos instaladores (solo uno):

- `artifacts/windows/Veloce_0.1.0_x64-setup.exe` (recomendado)
- `artifacts/windows/Veloce_0.1.0_x64_en-US.msi` (entornos corporativos)

No es necesario ejecutar manualmente `audio-engine.exe` ni `veloce-runtime.exe` cuando instalas con setup/msi.

## 2) Requisitos mínimos

- Windows 10/11 x64.
- Internet para primera descarga de modelo.
- Micrófono permitido en configuración de privacidad de Windows.

No requiere instalar Python manualmente para uso normal.

### Si el equipo tiene NVIDIA (recomendado)

1. Instala/actualiza driver NVIDIA.
2. Verifica en PowerShell:

```powershell
nvidia-smi
```

3. En Veloce usa `Backend = Auto` y `GPU = ON`.

Con eso, Veloce intentará usar `faster-whisper` con CUDA automáticamente cuando esté disponible.

## 3) Primera ejecución (onboarding)

1. Abre Veloce.
2. Descarga un modelo recomendado desde el onboarding.
3. Espera a que termine y prueba captura.

## 4) Configuración recomendada

En `Configuración`:

- Backend: `Auto`.
- Modelo: `large-v3-turbo` (u otro detectado).
- Ruta de modelos: seleccionar desde el desplegable detectado.
- Atajo captura: `Home` (tecla única), si lo prefieres.

### Ajuste rápido por tipo de GPU

- NVIDIA (ej. RTX 4060 6GB): `Backend = faster-whisper` o `Auto`, `GPU = ON`.
- AMD (ej. RX 9070 XT): `Backend = whisper.cpp` o `Auto` con `whisper.cpp` instalado.
- Si hay cortes por memoria/latencia en 4060 6GB: bajar a `distil-large-v3` o `medium`.

## 5) Errores comunes y solución

### Orden recomendado de diagnóstico (si hay muchos errores)

1. Reinstala con `Veloce_0.1.0_x64-setup.exe`.
2. Reinicia Windows.
3. Abre Veloce y descarga un modelo desde onboarding.
4. En `Configuración`, pulsa `Actualizar`.
5. Si usas GPU avanzada/whisper.cpp, sigue `docs/WINDOWS_GPU_BACKEND.md`.

### Error al instalar: `Error opening file for writing ... _up_\dist\audio-engine.exe`

Esto ocurre cuando una instancia previa dejó el engine en uso.

Pasos:

1. Cierra Veloce.
2. Abre Administrador de tareas y finaliza:
   - `veloce.exe`
   - `audio-engine.exe`
3. Reintenta instalador.

Si persiste, reinicia Windows y ejecuta nuevamente el setup.

### App abre pero no transcribe

1. Verifica permiso de micrófono en Windows.
2. En Configuración, pulsa `Actualizar`.
3. Comprueba que haya al menos un modelo descargado y seleccionado.
4. Si tienes NVIDIA y quieres CUDA, confirma que `nvidia-smi` responde.
5. Si usas `whisper.cpp`, confirma ruta de `whisper-cli.exe` y modelo `ggml/gguf`.

### Se ven dos iconos distintos en barra de tareas

Windows puede mantener caché de iconos antigua.

1. Desancla Veloce de la barra.
2. Cierra Veloce.
3. Abre Veloce desde acceso directo nuevo del menú inicio.
4. Vuelve a anclar.

### Error de backend GPU en NVIDIA

Si activaste GPU y no acelera:

1. Verifica `nvidia-smi`.
2. En el entorno Python del proyecto (si aplica), verifica:

```powershell
python -c "import torch; print(torch.cuda.is_available())"
```

3. Si devuelve `False`, usa temporalmente CPU o `whisper.cpp` y revisa `docs/WINDOWS_GPU_BACKEND.md`.

## 6) Entrega para otros equipos

Para compartir por Git o ZIP, usa directamente:

- `artifacts/windows/Veloce_0.1.0_x64-setup.exe`
- `artifacts/windows/Veloce_0.1.0_x64_en-US.msi`

Esto evita subir `src-tauri/target` completo y simplifica despliegue.

## 7) Publicar en GitHub sin error de 100MB

GitHub bloquea archivos mayores a 100MB en git normal (setup/msi de Veloce lo superan).

Opciones recomendadas:

1. **GitHub Releases (recomendado)**: subir `setup.exe` y `msi` como assets del release.
2. **Git LFS**: si necesitas versionar binarios pesados dentro del repositorio.

Comando para regenerar instaladores localmente:

```powershell
npm run tauri build
```

Salidas:

- `src-tauri/target/release/bundle/nsis/Veloce_0.1.0_x64-setup.exe`
- `src-tauri/target/release/bundle/msi/Veloce_0.1.0_x64_en-US.msi`
