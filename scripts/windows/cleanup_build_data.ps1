$ErrorActionPreference = "SilentlyContinue"

Write-Host "🧹 Iniciando limpieza completa de Veloce..." -ForegroundColor Cyan

# 1. Matar procesos
Write-Host "🛑 Deteniendo procesos..." -ForegroundColor Yellow
Stop-Process -Name "Veloce" -Force
Stop-Process -Name "audio-engine" -Force

# 2. Directorios de Build (Proyecto)
Write-Host "🗑️ Eliminando artefactos de build..." -ForegroundColor Yellow
Remove-Item -Path "dist" -Recurse -Force
Remove-Item -Path "build" -Recurse -Force
Remove-Item -Path "src-tauri\target" -Recurse -Force
Remove-Item -Path "src-tauri\gen" -Recurse -Force

# 3. Datos de Aplicación (Usuario)
Write-Host "🗑️ Eliminando datos de usuario..." -ForegroundColor Yellow
$appData = "$env:APPDATA\Veloce"
$localAppData = "$env:LOCALAPPDATA\Veloce"
$localAppDataId = "$env:LOCALAPPDATA\com.veloce.app"

if (Test-Path $appData) { Remove-Item -Path $appData -Recurse -Force; Write-Host "   - Borrado: $appData" }
if (Test-Path $localAppData) { Remove-Item -Path $localAppData -Recurse -Force; Write-Host "   - Borrado: $localAppData" }
if (Test-Path $localAppDataId) { Remove-Item -Path $localAppDataId -Recurse -Force; Write-Host "   - Borrado: $localAppDataId" }

# 4. Instaladores antiguos
Write-Host "🗑️ Buscando instaladores antiguos..." -ForegroundColor Yellow
Get-ChildItem -Path "src-tauri" -Filter "*.msi" -Recurse | Remove-Item -Force
Get-ChildItem -Path "src-tauri" -Filter "*.exe" -Recurse | Where-Object { $_.Name -like "*setup*" } | Remove-Item -Force

Write-Host "✅ Limpieza completada. Ahora puedes reconstruir desde cero." -ForegroundColor Green
Write-Host "Pasos recomendados:"
Write-Host "1. .\.venv\Scripts\pyinstaller.exe audio-engine.spec --clean"
Write-Host "2. Copy-Item -Path 'dist\audio-engine.exe' -Destination 'src-tauri\resources\audio-engine.exe' -Force"
Write-Host "3. bun run tauri build"
