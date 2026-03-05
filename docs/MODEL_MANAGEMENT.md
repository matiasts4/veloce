# Gestión de Modelos y Descargas

Este documento detalla el funcionamiento del sistema unificado de gestión de modelos en Veloce, incluyendo el proceso de descarga, la selección de directorios personalizados y los formatos soportados.

## Resumen de Características

- **Gestor Unificado:** Descarga modelos directamente desde la interfaz de configuración sin scripts externos.
- **Progreso Detallado:** Visualización en tiempo real del porcentaje, tamaño descargado y tamaño total (ej. "45% (1.2/2.5 GB)").
- **Directorios Personalizados:** Permite elegir dónde almacenar los modelos, ideal para gestionar espacio en disco o compartir modelos entre aplicaciones.
- **Validación:** Verificación automática de integridad post-descarga y filtrado de archivos locales válidos.
- **Soporte Multi-Backend:** Compatible con modelos para `faster-whisper` (formato original/HF) y `whisper.cpp` (GGUF).

## Protocolo de Descarga

El frontend (React/Tauri) se comunica con el backend (Python) mediante comandos a través de `stdin/stdout`.

### Comando DOWNLOAD

El comando `DOWNLOAD` ha sido actualizado para aceptar un payload JSON, permitiendo especificar el modelo y el directorio de destino.

**Formato:**
```json
DOWNLOAD {"model": "large-v3-turbo", "dir": "C:/Ruta/Personalizada/Modelos"}
```

- `model`: Identificador del modelo (ej. `tiny`, `base`, `large-v3-turbo`).
- `dir` (Opcional): Ruta absoluta donde se descargará el modelo. Si se omite, se usa la caché estándar de HuggingFace o el directorio configurado en la variable de entorno `HF_HOME`.

### Evento de Progreso

El backend emite eventos `model-download-progress` con información detallada para la UI.

**Payload:**
```json
{
  "type": "model-download-progress",
  "model": "large-v3-turbo",
  "progress": 45,
  "loaded": 1258291200,  // Bytes descargados
  "total": 2796202666,   // Total bytes
  "unit": "B"            // Unidad (generalmente Bytes)
}
```

## Configuración de Directorios

Veloce busca modelos en las siguientes ubicaciones, en orden de prioridad:

1. **Directorio Seleccionado en UI:** La ruta elegida manualmente en la configuración (`Model Directory`).
2. **Variable de Entorno `WHISPERCPP_MODEL_DIR`:** Si está definida.
3. **Recursos Empaquetados (Frozen):**
   - `resources/models` (junto al ejecutable).
   - `_internal/models` (en instalaciones PyInstaller).
4. **Caché de HuggingFace:**
   - Linux/Mac: `~/.cache/huggingface/hub`
   - Windows: `%USERPROFILE%\.cache\huggingface\hub` o `%LOCALAPPDATA%\huggingface\hub`.
5. **Rutas de Desarrollo:** `python/models`, `models/`.

### Cambiar el Directorio de Modelos

1. Abre la configuración (icono de engranaje).
2. Ve a la sección **AI Model** -> **Model Directory**.
3. Selecciona una ruta existente o usa "Browse Folder" para elegir una nueva carpeta.
4. Al descargar un nuevo modelo, este se guardará automáticamente en la carpeta seleccionada.

## Modelos Soportados

### Faster Whisper (Backend por defecto)
Descarga modelos desde HuggingFace (repositorio `Systran` o `openai`).
- `tiny`, `base`, `small`, `medium`, `large-v3`
- `large-v3-turbo` (Recomendado por velocidad/precisión)
- `distil-large-v3`

### Whisper.cpp (Backend C++)
Requiere modelos en formato `.bin` (GGML antiguo) o `.gguf` (nuevo estándar).
- La aplicación intentará encontrar modelos compatibles en el directorio seleccionado.
- Nomenclatura esperada: `ggml-large-v3-turbo.bin`, `large-v3-turbo.gguf`, etc.

## Solución de Problemas

**La descarga se queda en "Starting..."**
- Verifica tu conexión a internet.
- Asegúrate de que Veloce tenga permisos de escritura en la carpeta de destino.

**Error "Model download failed"**
- Revisa el log de la aplicación (visible en la ventana principal si hay errores).
- Si usas un directorio personalizado en una unidad externa, asegúrate de que esté conectada.

**El modelo no aparece después de descargar**
- Pulsa el botón "Refresh Hardware" en la configuración.
- Reinicia la aplicación si el problema persiste.
