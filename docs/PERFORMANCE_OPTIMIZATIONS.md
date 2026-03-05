# Optimización de Rendimiento y Real-Time V2

Este documento detalla las mejoras realizadas en el motor de audio (`audio_engine.py`) para mejorar la latencia, el rendimiento y habilitar una experiencia de transcripción en tiempo real más fluida.

## 1. Transcripción en Tiempo Real (Streaming)

### Antes
- Intervalo de actualización parcial: **0.8 segundos**.
- Sensación de usuario: Retraso notable entre el habla y la aparición del texto.

### Después
- Intervalo de actualización parcial: **0.3 segundos**.
- Sensación de usuario: Escritura casi instantánea ("Live Typing").
- **Implementación:** Se ajustó `partial_interval_s` en la clase `StreamProcessor`.

## 2. Eliminación de Latencia de Disco (I/O)

### Problema Detectado
El backend `whispercpp` escribía un archivo `.wav` temporal en el disco duro para cada fragmento de audio (incluso para fragmentos parciales de 0.5s), lo leía de nuevo y luego lo enviaba al servidor local. Esto causaba un cuello de botella de I/O significativo y desgaste innecesario del SSD.

### Solución
Se reemplazó `tempfile.NamedTemporaryFile` por `io.BytesIO`.
- El audio se codifica a WAV directamente en **memoria RAM**.
- El buffer de bytes se envía directamente a la API de `whisper-server`.
- **Resultado:** Reducción drástica de la latencia de transcripción y eliminación total de escritura en disco durante la grabación.

## 3. Optimización de CPU (VAD Energy Gate)

### Problema Detectado
El detector de actividad de voz (VAD) neuronal (Silero) se ejecutaba en cada frame de audio, consumiendo ciclos de CPU incluso en silencio absoluto.

### Solución
Se implementó un "Energy Gate" (Compuerta de Energía) simple basado en RMS (Root Mean Square) antes de invocar al modelo neuronal.
- Si la energía del audio está por debajo del umbral de ruido de fondo (silencio absoluto), se retorna `False` inmediatamente.
- El modelo neuronal pesado solo se invoca si hay "algo" sonando.
- **Resultado:** Menor uso de CPU en reposo y durante pausas largas.

## 4. Próximos Pasos (Rust Refactoring)
- Modularización de `main.rs` para separar la lógica de negocio de la gestión de ventanas.
- Implementación de canales asíncronos para mejorar la comunicación entre hilos.

## 5. Optimización del Frontend y Datos (Fase 3)

### Almacenamiento Asíncrono (IndexedDB)
- Se reemplazó `localStorage` por **IndexedDB** para el almacenamiento del historial de transcripciones.
- **Beneficio:** Elimina el bloqueo del hilo principal de UI al cargar o guardar historiales grandes. Permite almacenar miles de registros sin afectar la fluidez de la animación de la interfaz.
- **Implementación:** `lib/db.ts` (wrapper nativo) y `lib/store.ts` (API asíncrona).

### Streaming UI
- Se optimizó el componente `LibraryView` para cargar datos de forma asíncrona ("lazy loading" implícito por la API).
- La lógica de autoguardado en `page.tsx` ahora es no-bloqueante, asegurando que la grabación continua no tenga interrupciones visuales por operaciones de disco.

