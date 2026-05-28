param(
  [string]$PythonCmd = "python",
  [string]$OutDir = "build/document-parser",
  [string]$WorkDir = "build/document-parser-build",
  [string]$DistDir = "build/document-parser-dist",
  [string]$PopplerDir = "",
  [string]$PopplerVersion = "24.08.0-0"
)

$ErrorActionPreference = "Stop"

function Resolve-PathSafe([string]$PathValue) {
  $item = Get-Item -LiteralPath $PathValue -ErrorAction Stop
  return $item.FullName
}

function Resolve-PopplerPath([string]$RepoRoot, [string]$ExplicitPath, [string]$Version) {
  if ($ExplicitPath) {
    return Resolve-PathSafe $ExplicitPath
  }

  $cacheRoot = Join-Path $RepoRoot ".cache/poppler/windows-$Version"
  $markerPath = Join-Path $cacheRoot ".ready"

  if (-not (Test-Path -LiteralPath $markerPath)) {
    $downloadRoot = Join-Path $RepoRoot ".cache/poppler/downloads"
    $zipPath = Join-Path $downloadRoot "poppler-$Version.zip"
    $extractRoot = Join-Path $cacheRoot "extract"
    $url = "https://github.com/oschwartz10612/poppler-windows/releases/download/v$Version/Release-$Version.zip"

    New-Item -ItemType Directory -Force -Path $downloadRoot | Out-Null
    if (Test-Path -LiteralPath $cacheRoot) {
      Remove-Item -LiteralPath $cacheRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null

    Write-Host "[docparser] Downloading Poppler $Version from $url"
    Invoke-WebRequest -Uri $url -OutFile $zipPath
    Expand-Archive -Path $zipPath -DestinationPath $extractRoot -Force

    $releaseDir = Get-ChildItem -LiteralPath $extractRoot -Directory | Select-Object -First 1
    if (-not $releaseDir) {
      throw "Poppler archive extraction failed: $extractRoot"
    }

    $runtimeDir = Join-Path $cacheRoot "runtime"
    New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
    Copy-Item -LiteralPath (Join-Path $releaseDir.FullName "Library") -Destination (Join-Path $runtimeDir "Library") -Recurse -Force
    Copy-Item -LiteralPath (Join-Path $releaseDir.FullName "share") -Destination (Join-Path $runtimeDir "share") -Recurse -Force
    New-Item -ItemType File -Path $markerPath -Force | Out-Null
  }

  return (Join-Path $cacheRoot "runtime")
}

if (-not $PopplerDir -and $env:DUYA_POPPLER_DIR) {
  $PopplerDir = $env:DUYA_POPPLER_DIR
}

$repoRoot = (Get-Location).Path
$sidecarEntry = Join-Path $repoRoot "electron/services/document-parser/sidecar/main.py"
$requirements = Join-Path $repoRoot "electron/services/document-parser/sidecar/requirements.txt"
$venvDir = Join-Path $repoRoot ".cache/document-parser-venv"
$resolvedOutDir = Join-Path $repoRoot $OutDir
$resolvedWorkDir = Join-Path $repoRoot $WorkDir
$resolvedDistDir = Join-Path $repoRoot $DistDir

if (-not (Test-Path -LiteralPath $sidecarEntry)) {
  throw "Sidecar entry not found: $sidecarEntry"
}
if (-not (Test-Path -LiteralPath $requirements)) {
  throw "Requirements file not found: $requirements"
}

Write-Host "[docparser] Preparing build venv at $venvDir"
if (-not (Test-Path -LiteralPath $venvDir)) {
  & $PythonCmd -m venv $venvDir
}

$venvPython = Join-Path $venvDir "Scripts/python.exe"
if (-not (Test-Path -LiteralPath $venvPython)) {
  throw "Venv python not found: $venvPython"
}

Write-Host "[docparser] Installing Python dependencies"
& $venvPython -m pip install --upgrade pip
& $venvPython -m pip install -r $requirements pyinstaller

if (Test-Path -LiteralPath $resolvedOutDir) {
  Remove-Item -LiteralPath $resolvedOutDir -Recurse -Force
}
if (Test-Path -LiteralPath $resolvedWorkDir) {
  Remove-Item -LiteralPath $resolvedWorkDir -Recurse -Force
}
if (Test-Path -LiteralPath $resolvedDistDir) {
  Remove-Item -LiteralPath $resolvedDistDir -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $resolvedOutDir | Out-Null
New-Item -ItemType Directory -Force -Path $resolvedWorkDir | Out-Null
New-Item -ItemType Directory -Force -Path $resolvedDistDir | Out-Null

Write-Host "[docparser] Building PyInstaller onedir bundle"
& $venvPython -m PyInstaller `
  --noconfirm `
  --clean `
  --onedir `
  --name "document-parser" `
  --distpath $resolvedDistDir `
  --workpath $resolvedWorkDir `
  --specpath $resolvedWorkDir `
  --hidden-import "pptx" `
  --hidden-import "pdfplumber" `
  --hidden-import "docx" `
  $sidecarEntry

$builtDir = Join-Path $resolvedDistDir "document-parser"
if (-not (Test-Path -LiteralPath $builtDir)) {
  throw "PyInstaller output not found: $builtDir"
}

$exePath = Join-Path $builtDir "document-parser.exe"
if (-not (Test-Path -LiteralPath $exePath)) {
  throw "document-parser.exe not found: $exePath"
}

$resolvedPoppler = Resolve-PopplerPath -RepoRoot $repoRoot -ExplicitPath $PopplerDir -Version $PopplerVersion
$targetPoppler = Join-Path $builtDir "poppler"
Write-Host "[docparser] Copying poppler from $resolvedPoppler"
if (Test-Path -LiteralPath $targetPoppler) {
  Remove-Item -LiteralPath $targetPoppler -Recurse -Force
}
Copy-Item -LiteralPath $resolvedPoppler -Destination $targetPoppler -Recurse -Force

Copy-Item -Path (Join-Path $builtDir "*") -Destination $resolvedOutDir -Recurse -Force

Write-Host "[docparser] Build complete: $builtDir"
