#!/usr/bin/env bash
# install.sh — Instalación limpia de Veloce
# 1. Mata TODOS los procesos relacionados a Veloce
# 2. Limpia el engine cacheado en AppData
# 3. Instala el .deb
# 4. Verifica que los cambios de optimización estén presentes

set -euo pipefail

DEB_PATH="${1:-src-tauri/target/release/bundle/deb/Veloce_0.1.0_amd64.deb}"
INSTALLED_ENGINE="/usr/lib/Veloce/_up_/python/audio_engine.py"
CACHE_ENGINE="$HOME/.local/share/com.veloce.app/engine/audio_engine_embedded.py"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${CYAN}[install]${NC} $*"; }
ok()   { echo -e "${GREEN}[  OK  ]${NC} $*"; }
warn() { echo -e "${YELLOW}[ WARN ]${NC} $*"; }
fail() { echo -e "${RED}[ FAIL ]${NC} $*"; exit 1; }

# ── 0. Verificar que el .deb existe ──────────────────────────────────────────
if [[ ! -f "$DEB_PATH" ]]; then
    fail "No se encontró el .deb en: $DEB_PATH\nUso: $0 [ruta/al/archivo.deb]"
fi
log "Instalando: $DEB_PATH"

# ── 1. Matar todos los procesos Veloce ───────────────────────────────────────
log "Buscando procesos activos de Veloce..."

PIDS=$(pgrep -f 'veloce|audio_engine' 2>/dev/null || true)

if [[ -n "$PIDS" ]]; then
    log "Procesos encontrados: $PIDS"
    log "Enviando SIGTERM..."
    echo "$PIDS" | xargs kill -TERM 2>/dev/null || true
    sleep 2

    # Verificar si quedan vivos y forzar SIGKILL
    STILL_ALIVE=$(pgrep -f 'veloce|audio_engine' 2>/dev/null || true)
    if [[ -n "$STILL_ALIVE" ]]; then
        warn "Algunos procesos no respondieron a SIGTERM. Forzando SIGKILL..."
        echo "$STILL_ALIVE" | xargs kill -KILL 2>/dev/null || true
        sleep 1
    fi

    # Confirmación final
    STILL=$(pgrep -f 'veloce|audio_engine' 2>/dev/null || true)
    if [[ -n "$STILL" ]]; then
        fail "No se pudo matar los procesos: $STILL — cerrá la app manualmente y volvé a correr."
    fi
    ok "Todos los procesos de Veloce fueron terminados."
else
    ok "No había procesos de Veloce corriendo."
fi

# ── 2. Limpiar engine cacheado en AppData ────────────────────────────────────
CACHE_DIR="$HOME/.local/share/com.veloce.app/engine"
if [[ -f "$CACHE_ENGINE" ]]; then
    log "Eliminando engine cacheado en AppData (fuerza re-copia en el próximo inicio)..."
    rm -f "$CACHE_ENGINE"
    ok "Cache eliminada: $CACHE_ENGINE"
else
    log "No había engine cacheado en AppData."
fi

# ── 3. Instalar el .deb ───────────────────────────────────────────────────────
log "Instalando el paquete .deb (se requiere contraseña sudo)..."
# Forzar prompt interactivo de sudo aunque el script corra desde una pipe
sudo -k  # invalidar caché previa para asegurar prompt limpio
if ! sudo dpkg -i "$DEB_PATH"; then
    warn "dpkg retornó error. Intentando resolver dependencias faltantes..."
    sudo apt-get install -f -y || fail "No se pudo completar la instalación."
fi
ok "Instalación completada."

# ── 4. Verificar que los cambios de optimización están en el engine instalado ─
log "Verificando optimizaciones en el engine instalado..."

ERRORS=0

check() {
    local desc="$1"
    local pattern="$2"
    if grep -q "$pattern" "$INSTALLED_ENGINE" 2>/dev/null; then
        ok "$desc"
    else
        fail_check "$desc"
        ERRORS=$((ERRORS + 1))
    fi
}

fail_check() { echo -e "${RED}[ MISS ]${NC} $*"; }

check "num_workers = 1"                      "num_workers = 1"
check "cpu_threads usa min() no max()"       "cpu_threads = min(4"
check "DiarizationManager desactivado"       "diarization_manager = None"
check "DiarizationManager() comentado"       "# diarization_manager = DiarizationManager()"

echo ""
if [[ $ERRORS -eq 0 ]]; then
    ok "━━━ Todas las optimizaciones están presentes en el engine instalado ━━━"
    echo ""
    log "Para iniciar Veloce con slate limpio:"
    echo "    veloce &"
    echo ""
    log "Para verificar el consumo de RAM después de ~30s:"
    echo "    ps aux | grep audio_engine | grep -v grep | awk '{print \$6/1024 \" MB RSS\"}'"
else
    echo ""
    warn "━━━ $ERRORS optimización(es) NO encontradas en $INSTALLED_ENGINE ━━━"
    warn "El engine instalado puede no ser el correcto. Verificá el build."
    exit 1
fi
