param(
  [string]$Model = "large-v3-turbo",
  [string]$InstallDir = "C:\wsp",
  [switch]$SkipClone,
  [switch]$SkipBuild,
  [switch]$SkipDownload,
  [switch]$SkipEnv,
  [switch]$SkipValidation,
  [switch]$StartApp
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Assert-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "No se encontró el comando requerido: $Name"
  }
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir "..\..")
$whisperRoot = $InstallDir
$buildDir = Join-Path $whisperRoot "build"
$modelDir = Join-Path $whisperRoot "models"
$modelFileName = "ggml-$Model.bin"
$modelPath = Join-Path $modelDir $modelFileName
$modelUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$modelFileName?download=true"

Write-Step "Validando herramientas"
Assert-Command "git"
Assert-Command "python"

$cmakeKnownPath = "C:\Program Files\CMake\bin"
if (Test-Path (Join-Path $cmakeKnownPath "cmake.exe")) {
  $env:Path = "$cmakeKnownPath;" + $env:Path
}
Assert-Command "cmake"

$vulkanBase = "C:\VulkanSDK"
if (Test-Path $vulkanBase) {
  $latestVulkan = Get-ChildItem $vulkanBase -Directory | Sort-Object Name -Descending | Select-Object -First 1
  if ($latestVulkan) {
    $env:VULKAN_SDK = $latestVulkan.FullName
    $env:Path = "$($latestVulkan.FullName)\Bin;" + $env:Path
  }
}

if (-not $SkipClone) {
  if (-not (Test-Path $whisperRoot)) {
    Write-Step "Clonando whisper.cpp en $whisperRoot"
    git clone https://github.com/ggml-org/whisper.cpp.git $whisperRoot
  } else {
    Write-Step "whisper.cpp ya existe, actualizando"
    git -C $whisperRoot pull --ff-only
  }
}

if (-not $SkipBuild) {
  Write-Step "Compilando whisper.cpp con Vulkan"
  if (-not (Test-Path $buildDir)) {
    New-Item -ItemType Directory -Path $buildDir | Out-Null
  }

  cmake -S $whisperRoot -B $buildDir -DGGML_VULKAN=1
  cmake --build $buildDir --config Release
}

$exeCandidates = @(
  (Join-Path $buildDir "bin\Release\whisper-cli.exe"),
  (Join-Path $buildDir "bin\Release\main.exe"),
  (Join-Path $whisperRoot "whisper-cli.exe"),
  (Join-Path $whisperRoot "main.exe")
)

$whisperExe = $exeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $whisperExe) {
  throw "No se encontró whisper-cli.exe/main.exe. Revisa la compilación de whisper.cpp."
}

if (-not (Test-Path $modelDir)) {
  New-Item -ItemType Directory -Path $modelDir | Out-Null
}

if (-not $SkipDownload) {
  if (-not (Test-Path $modelPath)) {
    Write-Step "Descargando modelo $modelFileName"
    Invoke-WebRequest -Uri $modelUrl -OutFile $modelPath
  } else {
    Write-Step "Modelo ya existente: $modelPath"
  }
}

if (-not $SkipEnv) {
  Write-Step "Registrando variables de entorno"
  setx WHISPERCPP_EXE "$whisperExe" | Out-Null
  setx WHISPERCPP_MODEL_DIR "$modelDir" | Out-Null

  $env:WHISPERCPP_EXE = $whisperExe
  $env:WHISPERCPP_MODEL_DIR = $modelDir
}

if (-not $SkipValidation) {
  Write-Step "Validando detección desde audio_engine.py"
  Push-Location $repoRoot
  try {
    python -c "import sys; sys.path.insert(0, 'python'); import audio_engine as ae; print(ae.get_whispercpp_status('$Model')); print('resolved_auto=', ae.resolve_backend('$Model', True, 'auto'))"
  }
  finally {
    Pop-Location
  }
}

if ($StartApp) {
  Write-Step "Iniciando app en modo desarrollo"
  Push-Location $repoRoot
  try {
    bun run tauri dev
  }
  finally {
    Pop-Location
  }
}

Write-Step "Listo"
Write-Host "WHISPERCPP_EXE = $whisperExe" -ForegroundColor Green
Write-Host "WHISPERCPP_MODEL_DIR = $modelDir" -ForegroundColor Green
Write-Host "Modelo esperado = $modelPath" -ForegroundColor Green
Write-Host "Abre una terminal nueva para que las variables setx queden disponibles globalmente." -ForegroundColor Yellow
