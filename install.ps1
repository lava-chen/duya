param(
  [switch] $Uninstall
)

$ErrorActionPreference = 'Stop'
if (-not $env:LOCALAPPDATA) {
  throw 'LOCALAPPDATA is unavailable. Run this installer from a Windows user account.'
}

$installDir = Join-Path $env:LOCALAPPDATA 'DUYA\CLI'
$binDir = Join-Path $installDir 'bin'
$releasesDir = Join-Path $installDir 'releases'

if ($Uninstall) {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPath) {
    $updatedPath = (($userPath -split ';' | Where-Object { $_.TrimEnd('\') -ine $binDir.TrimEnd('\') }) -join ';')
    [Environment]::SetEnvironmentVariable('Path', $updatedPath, 'User')
  }
  if (Test-Path -LiteralPath $installDir) {
    Remove-Item -LiteralPath $installDir -Recurse -Force
  }
  Write-Host 'DUYA CLI removed. Open a new terminal to refresh PATH.'
  exit 0
}

if (-not [Environment]::Is64BitOperatingSystem) {
  throw 'The DUYA CLI release currently supports Windows x64 only.'
}
if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) {
  throw 'Windows tar.exe is required to extract the CLI package.'
}

$headers = @{ 'User-Agent' = 'DUYA-CLI-Installer'; 'Accept' = 'application/vnd.github+json' }
$apiUrl = 'https://api.github.com/repos/lava-chen/duya/releases?per_page=100'
Write-Host 'Looking for the latest stable DUYA CLI release...'
$releases = Invoke-RestMethod -Uri $apiUrl -Headers $headers
$release = $releases | Where-Object { $_.tag_name -match '^cli/v(\d+\.\d+\.\d+)$' } | Select-Object -First 1
if (-not $release) {
  throw 'No stable CLI release is published yet. Windows installation will be available after the first Windows CLI release. See https://github.com/lava-chen/duya/releases.'
}

$version = $release.tag_name -replace '^cli/v', ''
$assetName = "duya-cli-$version-win-x64.tar.gz"
$archiveAsset = $release.assets | Where-Object { $_.name -eq $assetName } | Select-Object -First 1
$checksumAsset = $release.assets | Where-Object { $_.name -eq 'SHA256SUMS' } | Select-Object -First 1
if (-not $archiveAsset -or -not $checksumAsset) {
  throw "CLI release $($release.tag_name) does not include a Windows x64 package yet. Windows installation will be available after a release publishes '$assetName'."
}

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
$tempArchive = Join-Path $tempRoot $assetName
$tempChecksums = Join-Path $tempRoot 'SHA256SUMS'
$extractDir = Join-Path $tempRoot 'extracted'
try {
  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
  New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
  Invoke-WebRequest -Uri $archiveAsset.browser_download_url -Headers @{ 'User-Agent' = 'DUYA-CLI-Installer' } -OutFile $tempArchive
  Invoke-WebRequest -Uri $checksumAsset.browser_download_url -Headers @{ 'User-Agent' = 'DUYA-CLI-Installer' } -OutFile $tempChecksums

  $checksumLine = Get-Content -LiteralPath $tempChecksums | Where-Object { $_ -match "^([0-9a-fA-F]{64})\s+\*?$([regex]::Escape($assetName))$" } | Select-Object -First 1
  if (-not $checksumLine -or $checksumLine -notmatch '^([0-9a-fA-F]{64})') {
    throw "SHA256SUMS has no checksum for '$assetName'."
  }
  $expectedHash = $Matches[1].ToLowerInvariant()
  $actualHash = (Get-FileHash -LiteralPath $tempArchive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $expectedHash) {
    throw "SHA-256 verification failed for '$assetName'."
  }

  & tar.exe -xzf $tempArchive -C $extractDir
  if ($LASTEXITCODE -ne 0) {
    throw "Could not extract '$assetName'."
  }
  $packageDir = Join-Path $extractDir 'duya-cli'
  if ((Get-Content -LiteralPath (Join-Path $packageDir 'VERSION') -Raw).Trim() -ne $version) {
    throw 'The CLI package version does not match its release tag.'
  }
  $runtime = Join-Path $packageDir 'runtime/node.exe'
  $cli = Join-Path $packageDir 'app/cli.cjs'
  if (-not (Test-Path -LiteralPath $runtime -PathType Leaf) -or -not (Test-Path -LiteralPath $cli -PathType Leaf)) {
    throw 'The Windows CLI package is missing runtime/node.exe or app/cli.cjs.'
  }

  New-Item -ItemType Directory -Path $releasesDir, $binDir -Force | Out-Null
  $versionDir = Join-Path $releasesDir $version
  if (Test-Path -LiteralPath $versionDir) {
    $existingRuntime = Join-Path $versionDir 'runtime/node.exe'
    $existingCli = Join-Path $versionDir 'app/cli.cjs'
    if (-not (Test-Path -LiteralPath $existingRuntime -PathType Leaf) -or -not (Test-Path -LiteralPath $existingCli -PathType Leaf)) {
      Remove-Item -LiteralPath $versionDir -Recurse -Force
    }
  }
  if (-not (Test-Path -LiteralPath $versionDir)) {
    Move-Item -LiteralPath $packageDir -Destination $versionDir
  }
  $cmd = "@echo off`r`nset DUYA_CLI_VERSION=$version`r`n`"%~dp0..\releases\$version\runtime\node.exe`" `"%~dp0..\releases\$version\app\cli.cjs`" %*`r`n"
  Set-Content -LiteralPath (Join-Path $binDir 'duya.cmd') -Value $cmd -Encoding Ascii

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $pathEntries = @($userPath -split ';' | Where-Object { $_ })
  if (-not ($pathEntries | Where-Object { $_.TrimEnd('\') -ieq $binDir.TrimEnd('\') })) {
    [Environment]::SetEnvironmentVariable('Path', ((@($pathEntries) + $binDir) -join ';'), 'User')
  }
  $currentPathHasBin = @($env:Path -split ';' | Where-Object { $_.TrimEnd('\') -ieq $binDir.TrimEnd('\') }).Count -gt 0
  if (-not $currentPathHasBin) {
    $env:Path = "$binDir;$env:Path"
  }

  Write-Host "DUYA CLI $version installed and verified."
  Write-Host 'Open a new terminal if the duya command is not found.'
  Write-Host 'To upgrade, rerun this installer. To uninstall, rerun it with -Uninstall.'
}
finally {
  if (Test-Path -LiteralPath $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
