# Arquitectura de Tiempo Real y Almacenamiento

## 1. Streaming de Audio a Texto (Real-Time)

La arquitectura de streaming se basa en una tubería (pipeline) de baja latencia que conecta la captura de audio en Python con la interfaz de usuario en React/Tauri.

### Flujo de Datos

1.  **Captura (Python):** `sounddevice` captura audio en bloques de 512 muestras a 16kHz.
2.  **VAD (Python):**
    *   **Etapa 1:** Filtro de energía RMS (Gate) para descartar silencio absoluto (< 0.1ms latencia).
    *   **Etapa 2:** Modelo Neural Silero VAD para confirmar voz humana (~10-20ms latencia).
3.  **Procesamiento (Python):**
    *   Los chunks de voz se acumulan en un buffer.
    *   Cada **0.3 segundos** (configurable), el buffer activo se envía al motor de inferencia.
4.  **Inferencia (Whisper.cpp / Faster-Whisper):**
    *   El audio se convierte a WAV en **memoria RAM** (buffer `io.BytesIO`).
    *   Se envía vía HTTP local a `whisper-server` (si se usa `whispercpp`) o se procesa directamente en memoria (si se usa `faster-whisper`).
    *   Latencia típica de inferencia: 100-400ms (dependiendo de GPU/CPU).
5.  **Transporte (IPC):**
    *   El texto parcial se imprime en `stdout` como JSON.
    *   Rust (`engine.rs`) captura el `stdout`, parsea el JSON y emite un evento Tauri `transcription-update`.
6.  **Renderizado (React):**
    *   El frontend escucha el evento y actualiza el estado `latestTranscript`.
    *   Se aplica un algoritmo de "fusión de texto" para evitar duplicados en actualizaciones parciales superpuestas.

## 2. Persistencia de Datos (IndexedDB)

Para soportar un historial extenso sin degradar el rendimiento de la UI, hemos migrado de `localStorage` (síncrono/bloqueante) a **IndexedDB** (asíncrono).

### Estructura de Datos (`VeloceDB`)
- **Store:** `transcriptions`
- **Key:** `id` (UUID)
- **Index:** `createdAt` (ISO String) para ordenamiento eficiente.

### Ventajas
- **No bloqueante:** Las operaciones de lectura/escritura ocurren en un hilo separado del navegador.
- **Capacidad:** Soporta cientos de megabytes de texto (vs 5MB de `localStorage`).
- **Migración:** Se incluye una utilidad `migrateFromLocalStorage` que mueve automáticamente los datos antiguos al nuevo formato en el primer inicio.

## 3. Métricas de Rendimiento
El sistema ahora reporta `response_ms` (tiempo de inferencia del backend) en cada actualización. Esto permite monitorear la salud del motor de ASR en tiempo real desde la UI (si se habilita en configuración).
