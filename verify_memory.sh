#!/usr/bin/env bash
# verify_memory.sh — Levanta el audio engine, mide RAM en tiempo real y reporta si las
# optimizaciones de memoria funcionaron.
#
# Uso:
#   chmod +x verify_memory.sh
#   ./verify_memory.sh
#
# Variables de entorno opcionales:
#   PYTHON_BIN   — ruta al intérprete Python (default: python3)
#   MODEL        — modelo a cargar (default: large-v3-turbo)
#   BASELINE_MB  — consumo previo conocido en MB para comparar (default: 5428, ~5.3GB)
#   TARGET_MB    — consumo máximo aceptable tras la optimización (default: 3500)

set -euo pipefail

# ─── Configuración ────────────────────────────────────────────────────────────
PYTHON_BIN="${PYTHON_BIN:-python3}"
ENGINE_SCRIPT="$(dirname "$0")/python/audio_engine.py"
MODEL="${MODEL:-large-v3-turbo}"
BASELINE_MB="${BASELINE_MB:-5428}"
TARGET_MB="${TARGET_MB:-3500}"

WARMUP_SECS=12          # segundos para que el engine arranque e importe todo
LOAD_SECS=30            # segundos adicionales para que el modelo se cargue en RAM
SAMPLE_INTERVAL=2       # segundos entre muestras RSS
LOG_FILE="/tmp/veloce_mem_$(date +%s).log"
ENGINE_LOG="/tmp/veloce_engine_$(date +%s).log"

# ─── Colores ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

# ─── Helpers ──────────────────────────────────────────────────────────────────
log()  { echo -e "${CYAN}[verify]${NC} $*"; }
ok()   { echo -e "${GREEN}[  OK  ]${NC} $*"; }
warn() { echo -e "${YELLOW}[ WARN ]${NC} $*"; }
fail() { echo -e "${RED}[ FAIL ]${NC} $*"; }

# Obtiene RSS en KB para un PID (Linux /proc)
get_rss_kb() {
    local pid="$1"
    # Suma el RSS de todos los threads del proceso
    local rss=0
    if [[ -f "/proc/${pid}/smaps_rollup" ]]; then
        rss=$(grep -i "^Rss:" /proc/${pid}/smaps_rollup | awk '{print $2}')
    elif [[ -f "/proc/${pid}/status" ]]; then
        rss=$(grep -i "^VmRSS:" /proc/${pid}/status | awk '{print $2}')
    else
        # fallback: ps
        rss=$(ps -o rss= -p "$pid" 2>/dev/null || echo 0)
    fi
    echo "${rss:-0}"
}

kb_to_mb() { echo $(( $1 / 1024 )); }

# ─── Prerequisitos ────────────────────────────────────────────────────────────
log "Verificando entorno..."

if [[ ! -f "$ENGINE_SCRIPT" ]]; then
    fail "No encontré el engine en: $ENGINE_SCRIPT"
    exit 1
fi

if ! "$PYTHON_BIN" -c "import faster_whisper" 2>/dev/null; then
    warn "faster_whisper no está instalado para $PYTHON_BIN — el engine podría fallar."
fi

# ─── Arranque del engine ──────────────────────────────────────────────────────
log "Iniciando audio engine (modelo: $MODEL)..."
log "Logs del engine → $ENGINE_LOG"

# Creamos un FIFO para leerle el stdout al engine en background
ENGINE_FIFO=$(mktemp -u /tmp/veloce_fifo_XXXXXX)
mkfifo "$ENGINE_FIFO"

# Lanzamos el engine con stdin/stdout redirigidos
"$PYTHON_BIN" "$ENGINE_SCRIPT" > "$ENGINE_FIFO" 2>>"$ENGINE_LOG" &
ENGINE_PID=$!

log "Engine PID: $ENGINE_PID"

# Thread que consume el FIFO y lo graba al log (evita bloqueo)
cat "$ENGINE_FIFO" >> "$ENGINE_LOG" &
FIFO_CAT_PID=$!

# ─── Cleanup al salir ─────────────────────────────────────────────────────────
cleanup() {
    log "Deteniendo engine (PID $ENGINE_PID)..."
    kill "$ENGINE_PID" 2>/dev/null || true
    kill "$FIFO_CAT_PID" 2>/dev/null || true
    rm -f "$ENGINE_FIFO"
}
trap cleanup EXIT INT TERM

# ─── Espera de warmup (imports Python, inicialización) ───────────────────────
log "Esperando ${WARMUP_SECS}s de warmup (imports y arranque)..."
sleep "$WARMUP_SECS"

if ! kill -0 "$ENGINE_PID" 2>/dev/null; then
    fail "El engine murió durante el warmup. Revisá: $ENGINE_LOG"
    exit 1
fi

# ─── Enviar CONFIG + load del modelo ─────────────────────────────────────────
log "Enviando CONFIG al engine para cargar el modelo '$MODEL'..."
CONFIG_JSON="{\"command\":\"CONFIG\",\"model\":\"${MODEL}\",\"gpu_enabled\":false,\"backend\":\"faster-whisper\",\"language\":\"es\"}"

# El engine lee de stdin del proceso, pero lo arrancamos sin stdin. 
# Usamos /proc/<pid>/fd/0 si existe, sino re-lanzamos con un pipe.
# Estrategia más robable: re-lanzar con pipe para poder escribir comandos.

kill "$ENGINE_PID" 2>/dev/null || true
kill "$FIFO_CAT_PID" 2>/dev/null || true
rm -f "$ENGINE_FIFO"
mkfifo "$ENGINE_FIFO"

log "Re-lanzando engine con pipe de comandos..."
CMD_PIPE=$(mktemp -u /tmp/veloce_cmd_XXXXXX)
mkfifo "$CMD_PIPE"

# Mantenemos el pipe abierto durante toda la ejecución
exec 3>"$CMD_PIPE"

"$PYTHON_BIN" "$ENGINE_SCRIPT" < "$CMD_PIPE" > "$ENGINE_FIFO" 2>>"$ENGINE_LOG" &
ENGINE_PID=$!
log "Engine PID (con pipe): $ENGINE_PID"

cat "$ENGINE_FIFO" >> "$ENGINE_LOG" &
FIFO_CAT_PID=$!

cleanup() {
    log "Deteniendo engine (PID $ENGINE_PID)..."
    echo 'EXIT' >&3 2>/dev/null || true
    exec 3>&-
    sleep 1
    kill "$ENGINE_PID" 2>/dev/null || true
    kill "$FIFO_CAT_PID" 2>/dev/null || true
    rm -f "$ENGINE_FIFO" "$CMD_PIPE"
}

log "Esperando ${WARMUP_SECS}s de warmup..."
sleep "$WARMUP_SECS"

if ! kill -0 "$ENGINE_PID" 2>/dev/null; then
    fail "El engine murió durante el warmup. Revisá: $ENGINE_LOG"
    exit 1
fi

# Enviar CONFIG para triggerear la carga del modelo
echo "CONFIG ${CONFIG_JSON}" >&3
log "CONFIG enviado. Esperando ${LOAD_SECS}s para que el modelo cargue en RAM..."

# ─── Muestreo de RSS ─────────────────────────────────────────────────────────
PEAK_RSS_KB=0
SAMPLES=()
ELAPSED=0

echo "" > "$LOG_FILE"

while [[ $ELAPSED -lt $LOAD_SECS ]]; do
    if ! kill -0 "$ENGINE_PID" 2>/dev/null; then
        warn "Engine terminó antes de tiempo."
        break
    fi

    RSS_KB=$(get_rss_kb "$ENGINE_PID")
    RSS_MB=$(kb_to_mb "$RSS_KB")
    SAMPLES+=("$RSS_MB")
    echo "$(date +%H:%M:%S) ${RSS_MB} MB" >> "$LOG_FILE"

    if [[ $RSS_KB -gt $PEAK_RSS_KB ]]; then
        PEAK_RSS_KB=$RSS_KB
    fi

    printf "\r  RAM actual: %5d MB  | Pico: %5d MB  | Muestra %d" \
        "$RSS_MB" "$(kb_to_mb "$PEAK_RSS_KB")" "${#SAMPLES[@]}"

    sleep "$SAMPLE_INTERVAL"
    ELAPSED=$(( ELAPSED + SAMPLE_INTERVAL ))
done

echo ""  # newline tras el \r

# ─── Reporte final ───────────────────────────────────────────────────────────
PEAK_MB=$(kb_to_mb "$PEAK_RSS_KB")
SAVED_MB=$(( BASELINE_MB - PEAK_MB ))
SAVED_PCT=$(( SAVED_MB * 100 / BASELINE_MB ))

echo ""
echo "════════════════════════════════════════════════════════════"
echo "  REPORTE DE MEMORIA — $(date '+%Y-%m-%d %H:%M')"
echo "════════════════════════════════════════════════════════════"
printf "  Modelo cargado          : %s\n" "$MODEL"
printf "  Muestras tomadas        : %d (cada %ds)\n" "${#SAMPLES[@]}" "$SAMPLE_INTERVAL"
printf "  Pico RSS                : %d MB\n" "$PEAK_MB"
printf "  Baseline (antes)        : %d MB (~%.1f GB)\n" "$BASELINE_MB" "$(echo "scale=1; $BASELINE_MB/1024" | bc)"
printf "  Target máximo aceptable : %d MB (~%.1f GB)\n" "$TARGET_MB" "$(echo "scale=1; $TARGET_MB/1024" | bc)"
printf "  Ahorro estimado         : %d MB (%d%%)\n" "$SAVED_MB" "$SAVED_PCT"
echo "────────────────────────────────────────────────────────────"

if [[ $PEAK_MB -le $TARGET_MB ]]; then
    ok "OPTIMIZACIÓN VERIFICADA — consumo dentro del target (${PEAK_MB} MB ≤ ${TARGET_MB} MB)"
    EXIT_CODE=0
elif [[ $PEAK_MB -lt $BASELINE_MB ]]; then
    warn "MEJORA PARCIAL — bajó de ${BASELINE_MB} MB a ${PEAK_MB} MB, pero aún supera el target de ${TARGET_MB} MB"
    EXIT_CODE=1
else
    fail "SIN MEJORA — consumo (${PEAK_MB} MB) sigue igual o mayor al baseline (${BASELINE_MB} MB)"
    fail "Revisá que el engine que está corriendo sea python/audio_engine.py con los cambios aplicados."
    EXIT_CODE=2
fi

echo ""
log "Log completo de muestras → $LOG_FILE"
log "Log del engine           → $ENGINE_LOG"

# Mostrar últimas líneas del engine para confirmar que cargó bien
echo ""
log "Últimas líneas del engine:"
tail -20 "$ENGINE_LOG" | sed 's/^/    /'

echo ""
exit $EXIT_CODE
