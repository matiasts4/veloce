# 🛠️ Solución Definitiva: Congelamiento de Kali Linux al Bootear (NVIDIA + Wayland)

## 🚨 El Problema
Luego de instalar los drivers privativos de NVIDIA y CUDA, el equipo se quedaba congelado en el logo de Kali Linux o en una pantalla negra antes de mostrar la pantalla de inicio de sesión (GDM). El sistema entraba en pánico y no permitía cargar el entorno de escritorio.

## 🔍 El Causante (Root Cause)
El problema radicaba en un conflicto arquitectónico profundo en la secuencia de arranque del sistema operativo:

1. **Early Boot (Initramfs)**: Los módulos críticos del driver de NVIDIA (`nvidia`, `nvidia_modeset`, `nvidia_drm`) **no estaban empaquetados en el `initramfs`** (la mochila de arranque o sistema de archivos temporal mínimo que usa Linux antes de montar todo el disco). Por lo tanto, la GPU no se "despertaba" durante los primeros segundos críticos del inicio.
2. **Wayland Exclusivo**: GNOME 49 (la versión actual de Kali Rolling) hizo una limpieza extrema y eliminó las sesiones clásicas de fallback de X11 (`/usr/share/xsessions/`). Esto significa que GDM y GNOME están **obligados** a iniciar usando el protocolo moderno **Wayland**.
3. **El Choque Mortal**: Cuando GDM (GNOME Display Manager) intentaba levantar el servidor Wayland, requería acceder al manejador de renderizado directo de la GPU (`DRM`). Como los módulos de NVIDIA no estaban cargados todavía, Wayland explotaba con un error fatal (`Failed to start org.gnome.Shell@wayland.service`) y abortaba toda la sesión gráfica. 

## 💡 La Solución Aplicada
Para arreglar esto, en lugar de pelear con el entorno gráfico, fuimos a la raíz (la arquitectura del boot) y obligamos a Linux a cargar la GPU desde el segundo cero.

### Pasos técnicos ejecutados:

**1. Forzar la carga temprana de módulos (Initramfs)**
Se añadieron explícitamente los módulos base de la GPU al archivo `/etc/initramfs-tools/modules`:
```text
nvidia
nvidia_modeset
nvidia_drm
```

**2. Habilitar DRM Modeset en el Kernel (GRUB)**
Se modificó el archivo `/etc/default/grub` para asegurar que el Kernel exponga las capacidades gráficas temprano a Wayland, inyectando el flag `nvidia-drm.modeset=1`:
```bash
GRUB_CMDLINE_LINUX_DEFAULT="quiet splash nvidia-drm.modeset=1"
```

**3. Restaurar la configuración de Wayland en GDM**
Nos aseguramos de deshacer cualquier intento de forzar X11 en `/etc/gdm3/daemon.conf` (dejando comentada la línea `#WaylandEnable=false`), ya que sin paquetes X11 instalados, deshabilitar Wayland provocaba un crash inmediato.

**4. Recompilación de la Secuencia de Boot**
Finalmente, inyectamos estas configuraciones al núcleo del arranque ejecutando:
```bash
sudo update-initramfs -u
sudo update-grub
```

## 🧠 Aprendizaje Técnico
¡Nunca intentes apagar Wayland ciegamente como "solución rápida" en distros modernas! En ecosistemas nuevos (GNOME 49+), X11 ya no es el salvavidas garantizado. Con NVIDIA, **el verdadero arreglo estructural es asegurar que `nvidia_drm` y el DRM modesetting estén cargados de manera síncrona en la fase de `initramfs`**, para que Wayland tenga el hardware disponible cuando inicie.

---

## ⚠️ Actualización 2026-03-31 (Incidentes posteriores)

Este documento describe correctamente la **primera capa** de la solución (boot/Wayland), pero luego aparecieron nuevos incidentes distintos:

1. **Módulos DKMS con nombre `-current` en Kali/Debian**
   - El initramfs debía incluir `nvidia-current`, `nvidia-current-modeset`, `nvidia-current-drm`.
   - Con nombres genéricos (`nvidia_drm`, etc.) aparecía `Failed to find module 'nvidia_drm'`.

2. **Kernel panic en ruta ACPI de NVIDIA (login/inactividad)**
   - Evidencia en logs: `rm_acpi_notify`, `Trying to vfree() bad/nonexistent vm area`, `BUG: kernel NULL pointer dereference`.
   - Síntoma: freeze duro al iniciar sesión o a los pocos minutos.

3. **Inestabilidad de runtime CUDA en Python (Veloce)**
   - `nvidia-smi` y OpenGL podían verse OK, pero `torch.cuda.is_available()` devolvía `False`.
   - Con eventos `NVRM: Xid 31 MMU Fault` asociados.

Para seguimiento completo de intentos, resultados y próximos pasos, ver:

➡️ `docs/NVIDIA_KALI_CRASH_ATTEMPTS_LOG.md`
