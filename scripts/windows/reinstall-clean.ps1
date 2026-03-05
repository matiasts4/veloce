param(
    [string]$SetupPath = ".\artifacts\windows\Veloce_0.1.0_x64-setup.exe"
)

$ErrorActionPreference = "Stop"

Write-Host "[1/4] Cerrando procesos de Veloce..." -ForegroundColor Cyan
$processNames = @("veloce", "audio-engine", "whisper-cli", "whisper-server")
foreach ($name in $processNames) {
    Get-Process -Name $name -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Seconds 1

Write-Host "[2/4] Eliminando instalación previa local..." -ForegroundColor Cyan
$installDir = Join-Path $env:LOCALAPPDATA "Veloce"
if (Test-Path $installDir) {
    Remove-Item -Path $installDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "[3/4] Verificando instalador..." -ForegroundColor Cyan
$resolvedSetup = Resolve-Path -Path $SetupPath -ErrorAction SilentlyContinue
if (-not $resolvedSetup) {
    throw "No se encontró el instalador en: $SetupPath"
}

Write-Host "[4/4] Lanzando setup: $($resolvedSetup.Path)" -ForegroundColor Cyan
Start-Process -FilePath $resolvedSetup.Path

Write-Host "Reinstalación limpia iniciada." -ForegroundColor Green