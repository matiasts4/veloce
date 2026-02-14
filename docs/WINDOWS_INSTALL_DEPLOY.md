# Guía Windows: instalación en equipo nuevo (todo en uno)

Esta versión de Veloce se instala en Windows con instalador completo y motor embebido.

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

## 5) Errores comunes y solución

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

### Se ven dos iconos distintos en barra de tareas

Windows puede mantener caché de iconos antigua.

1. Desancla Veloce de la barra.
2. Cierra Veloce.
3. Abre Veloce desde acceso directo nuevo del menú inicio.
4. Vuelve a anclar.

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
