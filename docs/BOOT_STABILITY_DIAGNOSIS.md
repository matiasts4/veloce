# Diagnóstico de prioridad: estabilidad de arranque

> Objetivo: aislar y corregir primero los freezes de inicio/login antes de volver a revisar el backend de Veloce.

## 1) Síntoma actual

- El sistema a veces se congela antes de mostrar el perfil/pantalla de login.
- Requiere varios reinicios (4–5) para lograr iniciar sesión.
- Cuando finalmente arranca, el problema del backend es secundario.

## 2) Señal en logs que importa

Los boot fallidos recientes muestran este patrón repetido:

```text
Trying to vfree() nonexistent vm area
BUG: kernel NULL pointer dereference
rm_acpi_notify [nvidia]
```

Además, en un arranque fallido previo apareció:

```text
Failed to start org.gnome.Shell@wayland.service
```

## 3) Qué significa

Esto apunta a un problema del stack NVIDIA/ACPI/energía, no a la app.

- Si falla **antes del login**, el culpable está en kernel / GDM / Wayland / módulos NVIDIA.
- Si falla **después del login**, hay que revisar servicios de energía y transiciones ACPI.

## 4) Orden correcto de diagnóstico

### Fase A — Arranque
1. Probar arranque en frío (apagado completo, no reinicio).
2. Verificar si el freeze ocurre antes o después de GDM.
3. Revisar `journalctl -b -1 -p 3`.
4. Revisar `journalctl -b -1 -k | grep -iE "rm_acpi_notify|vfree|NVRM|Xid|wayland|gnome-shell"`.

### Fase B — Energía NVIDIA
1. Confirmar servicios:
   - `nvidia-suspend.service`
   - `nvidia-hibernate.service`
   - `nvidia-resume.service`
2. Revisar `/etc/modprobe.d/nvidia-acpi-fix.conf`.
3. Revisar `/etc/modprobe.d/nvidia-power.conf`.
4. Revisar si S0ix sigue habilitado.

### Fase C — Solo después: backend de Veloce
1. Ver si el sidecar arranca.
2. Ver si aparece `Whisper Load Error`.
3. Ver si `torch.cuda.is_available()` sigue en `False`.

## 5) Criterio de éxito

- 3 arranques consecutivos sin freeze.
- Login visible sin múltiples reintentos.
- 15–30 min sin `BUG` ni `NULL pointer` en logs.

## 6) No confundir síntomas

- `nvidia-smi` funcionando **no** garantiza estabilidad del arranque.
- GPU offload en OpenGL **no** garantiza que PyTorch/CUDA esté estable.
- Backend de Veloce puede fallar aunque el sistema esté bien, pero primero hay que dejar el boot sano.
