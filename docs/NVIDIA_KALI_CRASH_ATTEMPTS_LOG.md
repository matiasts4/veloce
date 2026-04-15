# Registro de intentos — Crashes NVIDIA/Kali (Dell G15)

> Última actualización: 2026-03-31
> Alcance: boot/login freeze + crash en sesión + GPU runtime en Veloce

## 1) Contexto base

- Equipo: **Dell G15 5530**
- GPU: **NVIDIA RTX 4050 Laptop** (híbrida con Intel)
- SO: **Kali Rolling**, GNOME (Wayland), kernel `6.18.12+kali-amd64`
- Driver NVIDIA detectado: `550.163.01`
- Restricción de usuario: **mantener distro + GNOME** (sin migrar entorno)

## 2) Línea de tiempo de intentos

| Fecha | Síntoma | Acción / Cambio | Resultado | Estado |
|---|---|---|---|---|
| 2026-03-30 | Freeze al boot (logo/pantalla negra) tras cambios NVIDIA/CUDA | Diagnóstico inicial de stack GPU (no mezclar métodos runfile/APT, validar DKMS, priorizar estabilidad) | Se define plan por fases | ✅ Documentado |
| 2026-03-30 | Wayland no iniciaba (GDM fallando) | Se fuerza carga temprana de módulos NVIDIA en initramfs y `nvidia-drm.modeset=1` en GRUB | Sistema logra volver a iniciar sesión gráfica | ✅ Parcial |
| 2026-03-31 | Persistían errores de carga de módulo al boot | Se detecta mismatch de nombres en Kali/Debian DKMS (`nvidia-current*` vs `nvidia*`) | Initramfs queda con `nvidia-current*.ko.xz` incluido | ✅ Corregido |
| 2026-03-31 | En Veloce no habilitaba aceleración GPU | Validación runtime: `nvidia-smi` OK, OpenGL offload OK, pero `torch.cuda.is_available() == False` | Aparecen Xid de NVIDIA en kernel (`Xid 31 MMU Fault`) al invocar CUDA desde Python | ⚠️ Inestable |
| 2026-03-31 14:42 y 14:46 | Freeze duro en login o a los pocos minutos | Revisión de logs de boots fallidos (`-2`, `-1`) | Kernel panic repetido en ruta ACPI de NVIDIA: `rm_acpi_notify -> vfree() -> NULL pointer dereference` | ❌ Crash confirmado |
| 2026-03-31 (pendiente de validar) | Mitigar crashes por power transitions | Propuesto: habilitar `nvidia-suspend/resume/hibernate` + desactivar S0ix | Aún sin validación final (falta apagar/reiniciar y monitoreo) | ⏳ Pendiente |
| 2026-04-02 | Boot intermitente: a veces se congela antes de mostrar perfil de login; luego de varios reinicios logra entrar | Repriorización explícita: estabilizar arranque antes de revisar backend de Veloce | Confirmado que el backend queda en segundo plano hasta que el login sea estable | 🔥 Prioridad actual |
| 2026-04-02 | Dos crashes posteriores a abrir Antigravity | Correlación temporal en logs de kernel y userspace | `antigravity` aparece en soft lockups y stalls junto a `nvidia`/`WebKitWebProcess`/`brave` antes del freeze | ⚠️ Causa disparadora probable |

## 3) Evidencia técnica clave (logs)

### 3.1 Kernel panic repetido (boots fallidos recientes)

En los boots `-2` y `-1`:

```text
BUG: kernel NULL pointer dereference
Trying to vfree() bad/nonexistent vm area
Call Trace: ... rm_acpi_notify ... [nvidia]
```

Esto explica el síntoma de “aprieto iniciar sesión y se pega”.

### 3.2 Error de runtime CUDA en Python (impacta GPU en Veloce)

Durante validación:

```text
torch.cuda.is_available() -> False
CUDA initialization: CUDA unknown error
```

Con eventos en kernel del tipo:

```text
NVRM: Xid 31 ... MMU Fault ... pid=python
```

### 3.3 Hallazgo de packaging Kali/Debian

- Los módulos efectivos de DKMS para este driver aparecen como:
  - `nvidia-current.ko.xz`
  - `nvidia-current-modeset.ko.xz`
  - `nvidia-current-drm.ko.xz`

No usar nombres genéricos en configuraciones de arranque temprano si no se validan contra `/lib/modules/.../updates/dkms`.

### 3.4 Correlación con Antigravity

En los dos crashes más recientes, `antigravity` aparece como proceso activo justo antes del congelamiento:

```text
watchdog: BUG: soft lockup ... [antigravity:6823]
watchdog: BUG: soft lockup ... [antigravity:6803]
os_acquire_spinlock ... [nvidia]
_main_loop ... [nvidia]
```

También aparecen `brave`, `WebKitWebProcess`, `language_server` y `JITWorker` en soft lockups simultáneos, lo que sugiere una **tormenta de carga gráfica/JIT** que dispara un bug ya latente en el stack NVIDIA/Wayland, no necesariamente que Antigravity sea el único culpable.

## 4) Hipótesis técnica actual (la más fuerte)

Los crashes actuales **no** son el mismo problema inicial de “Wayland no levanta por falta de initramfs”.

Ahora el patrón es:

1. Hay transición de energía ACPI (login/inactividad/reanudación),
2. NVIDIA entra en ruta `rm_acpi_notify`,
3. Se dispara corrupción/uso inválido en `vfree()`,
4. Termina en kernel panic (freeze total).

Además, el estado de energía de la dGPU deja la pila CUDA inestable para Python (falso “GPU no disponible”).

### Conclusión provisional sobre Antigravity

Antigravity es el **disparador más probable** de los dos últimos crashes porque es el proceso visible al momento del lockup y coincide con múltiples soft lockups. Pero el **causante raíz** sigue siendo el stack NVIDIA/kernel/Wayland bajo presión (lockup dentro de `nvidia` + watchdog + stalls RCU), no una simple falla aislada de la app.

## 5) Prioridad actual: estabilizar el arranque

El problema que bloquea todo el resto es el **boot/login intermitente**. Hasta que el sistema inicie de forma consistente, no conviene seguir usando el backend como señal de diagnóstico.

### 5.1 Qué observar en cada intento fallido

- `journalctl -b -1 -p 3`
- `journalctl -b -1 -k | grep -iE "rm_acpi_notify|vfree|NVRM|Xid|wayland|gnome-shell"`
- `systemctl status nvidia-suspend.service nvidia-hibernate.service nvidia-resume.service`

### 5.2 Archivos a revisar primero

- `/etc/modprobe.d/nvidia-acpi-fix.conf`
- `/etc/modprobe.d/nvidia-power.conf`
- `/etc/modules-load.d/nvidia.conf`
- `/etc/initramfs-tools/modules`
- `/etc/default/grub`

### 5.3 Criterio de éxito mínimo

- 3 arranques fríos consecutivos sin congelamiento antes del login
- 1 sesión de 15 minutos sin panic del kernel
- `journalctl -b -p 3` sin `BUG`, `NULL pointer` ni `rm_acpi_notify`

### 5.4 Orden de ataque recomendado

1. Confirmar si el crash viene del arranque o de la reanudación.
2. Validar servicios de NVIDIA para suspend/resume.
3. Revisar si `S0ix` sigue habilitado.
4. Solo si el boot se estabiliza, volver a mirar el backend de `faster-whisper`.

## 6) Cambios propuestos pendientes de validar

> Estos pasos están definidos, pero faltan validar con ciclo completo de apagado y pruebas.

```bash
sudo systemctl enable nvidia-suspend.service nvidia-hibernate.service nvidia-resume.service
sudo sed -i 's/NVreg_EnableS0ixPowerManagement=1/NVreg_EnableS0ixPowerManagement=0/' /etc/modprobe.d/nvidia-acpi-fix.conf
sudo update-initramfs -u
```

Opcional de limpieza (si reaparece warning de module-load):

```bash
sudo sed -i 's/^nvidia-drm$/nvidia-current-drm/' /etc/modules-load.d/nvidia.conf
```

## 7) Qué ya se intentó y NO conviene repetir “a ciegas”

- ❌ Desactivar Wayland como solución universal (en GNOME 49+ no hay fallback X11 garantizado en Kali).
- ❌ Mezclar estrategias de instalación NVIDIA/CUDA sin control de versiones.
- ❌ Asumir que “si `nvidia-smi` funciona, todo CUDA en apps Python también funciona”.

## 8) Qué NO se aplicó todavía (para próximos intentos si persiste)

- Downgrade/upgrade controlado de driver NVIDIA a rama alternativa estable.
- Pinning de kernel/driver para evitar regresiones por update.
- Ajustes adicionales de PM NVIDIA (por ejemplo `NVreg_DynamicPowerManagement=0x00`) si continúa el patrón de panic.
- Revisión de BIOS/firmware de la notebook si persiste tras estabilizar servicios de suspend/resume.

## 9) Plan de validación cuando se reinicie

1. Apagado completo (no solo reinicio).
2. Login y uso ligero 15 min.
3. Uso real (Veloce + carga GPU) 30–60 min.
4. Revisar:
   - `journalctl -b -k -p 3`
   - `journalctl -b -k | grep -iE "BUG:|NVRM: Xid|rm_acpi_notify|vfree"`
5. Registrar resultado en este mismo archivo (éxito / falla + timestamp).

---

## 10) Referencias internas

- `solucion_nvidia_kali.md` (fix inicial de boot/Wayland)
- Memorias Engram relacionadas:
  - Diagnóstico inicial crash NVIDIA/CUDA + DisplayPort
  - Plan de recuperación NVIDIA/CUDA sin snapshot
  - Estrategia rollback snapshot + congelar stack GPU
  - Fix de freeze de boot por initramfs/Wayland

## 9) Solución Final (04 de abril de 2026)

**Problema:**
El equipo presentaba "freezes" (congelamientos totales) aleatorios, kernel panics en transiciones de energía (`rm_acpi_notify [nvidia]`), soft lockups reportados por watchdog, y módulos no cargables. Todo esto a menudo desencadenado al momento del boot o luego de usar Veloce bajo carga y hacer operaciones con la GPU de NVIDIA (RTX 4050 Laptop).

**Causa Raíz:**
El driver propietario de NVIDIA (550.x) entraba en conflicto nativo severo con la gestión de energía S0ix de Kali Linux/Wayland, lo cual causaba colisiones en los manejadores ACPI del kernel. Aunado a esto, las configuraciones en `/etc/modules-load.d/` y `/etc/initramfs-tools/modules` apuntaban a nombres equivocados tras actualizaciones de los headers DKMS, lo que entorpecía el arranque o simplemente colgaba Wayland.

**Acciones Resolutivas Aplicadas:**
1. **Limpieza profunda de configuraciones erróneas/huérfanas:**
   - Se vaciaron y eliminaron configuraciones en desuso como `nvidia-acpi-fix.conf`, `nvidia-power.conf`, `nvidia.conf`, y parámetros inútiles como `nvidia-drm.modeset=1` que sobraban en GRUB.
   - Se removió cualquier línea genérica `nvidia` del `/etc/initramfs-tools/modules`.

2. **Detección de los verdaderos módulos del repositorio DKMS (`nvidia-current-open-*.ko.xz`):**
   - Se observó que las fuentes listaban `nvidia-current-open`, `nvidia-current-open-drm`, `nvidia-current-open-modeset`, y `nvidia-current-open-uvm`.
   - Se configuró `/etc/modules-load.d/nvidia.conf` y `/etc/initramfs-tools/modules` usando **exactamente** esos identificadores para asegurar la carga.

3. **Desactivación de S0ix (La directiva clave antihang):**
   - Habilitar los servicios de suspensión ACPI sin problemas:
     ```
     options nvidia NVreg_EnableS0ixPowerManagement=0 NVreg_PreserveVideoMemoryAllocations=1 NVreg_DynamicPowerManagement=0x00
     options nvidia-drm modeset=1
     ```

4. **Regeneración final del entorno de arranque:**
   - `sudo update-initramfs -u`
   - `sudo update-grub`

5. **Activación del entorno virtual de Python (`Veloce`) para evaluar PyTorch:**
   - Después de los ajustes y habilitar bien los módulos `uvm`, PyTorch reconoció exitosamente la placa a través del virtual enviroment (`.venv/bin/activate`).
   - `nvidia-smi` ahora exhibe estabilidad marcando ~25W de consumo tope como P-State design (debido a perfil limitador Max-Q Mobile nativo del firmware).

**Estado:** Solucionado y estabilizado al 100%. Veloce en modo Desktop (Tauri) con soporte en backend (Fast-Whisper CUDA) no ocasiona lockups. El 80% de batería es una configuración esperada y benigna del firmware Dell.
