# Artefactos Windows

Los instaladores `.exe/.msi` de Veloce suelen superar el límite de 100MB de GitHub para commits normales.

## Cómo generarlos localmente

```powershell
npm run tauri build
```

Salidas:

- `src-tauri/target/release/bundle/nsis/Veloce_0.1.0_x64-setup.exe`
- `src-tauri/target/release/bundle/msi/Veloce_0.1.0_x64_en-US.msi`

## Cómo compartirlos

- Recomendado: subirlos como assets en GitHub Releases.
- Alternativa: usar Git LFS si deseas versionar binarios pesados.
