param(
  [string]$HostName = "dev-hermess",
  [string]$RemoteRoot = "hermes-workspace-test",
  [string]$PnpmVersion = "10",
  [string]$Command = "test"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Quote-Sh {
  param([string]$Value)
  return "'" + $Value.Replace("'", "'\''") + "'"
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$runId = [Guid]::NewGuid().ToString("N")
$archive = Join-Path ([IO.Path]::GetTempPath()) "hermes-workspace-$runId.tar"
$remoteArchive = "/tmp/hermes-workspace-$runId.tar"
$remoteScript = "/tmp/hermes-workspace-test-$runId.sh"
$localRemoteScript = Join-Path ([IO.Path]::GetTempPath()) "hermes-workspace-test-$runId.sh"

$excludeArgs = @(
  "--exclude", ".git",
  "--exclude", "node_modules",
  "--exclude", ".pnpm-store",
  "--exclude", ".corepack",
  "--exclude", "dist",
  "--exclude", ".output",
  "--exclude", "coverage",
  "--exclude", "playwright-report",
  "--exclude", "test-results",
  "--exclude", ".tanstack",
  "--exclude", ".runtime",
  "--exclude", ".vite",
  "--exclude", "*.log"
)

try {
  Write-Host "Packing $repoRoot"
  & tar.exe @excludeArgs -cf $archive -C $repoRoot .
  if ($LASTEXITCODE -ne 0) {
    throw "tar failed with exit code $LASTEXITCODE"
  }

  $quotedRemoteRoot = Quote-Sh $RemoteRoot
  $quotedRemoteArchive = Quote-Sh $remoteArchive
  $quotedPnpmVersion = Quote-Sh $PnpmVersion
  $remoteCommand = "corepack pnpm@$PnpmVersion $Command"

  $scriptContent = @"
set -euo pipefail
remote_root=$quotedRemoteRoot
archive=$quotedRemoteArchive
pnpm_version=$quotedPnpmVersion

mkdir -p "`$remote_root"
remote_root="`$(cd "`$remote_root" && pwd)"
cd "`$remote_root"
find . -mindepth 1 -maxdepth 1 ! -name node_modules ! -name .pnpm-store ! -name .corepack -exec rm -rf {} +
tar -xf "`$archive" -C "`$remote_root"
rm -f "`$archive"

export CI=1
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export COREPACK_HOME="`$remote_root/.corepack"

corepack pnpm@"`$pnpm_version" install --no-frozen-lockfile --store-dir .pnpm-store
$remoteCommand
"@

  Set-Content -LiteralPath $localRemoteScript -Value $scriptContent -NoNewline -Encoding ASCII

  Write-Host "Uploading archive to ${HostName}:$remoteArchive"
  & scp.exe $archive "${HostName}:$remoteArchive"
  if ($LASTEXITCODE -ne 0) {
    throw "scp archive failed with exit code $LASTEXITCODE"
  }

  Write-Host "Uploading runner to ${HostName}:$remoteScript"
  & scp.exe $localRemoteScript "${HostName}:$remoteScript"
  if ($LASTEXITCODE -ne 0) {
    throw "scp runner failed with exit code $LASTEXITCODE"
  }

  Write-Host "Running remote tests on $HostName in $RemoteRoot"
  & ssh.exe $HostName "bash $(Quote-Sh $remoteScript)"
  if ($LASTEXITCODE -ne 0) {
    throw "remote test command failed with exit code $LASTEXITCODE"
  }
} finally {
  Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $localRemoteScript -Force -ErrorAction SilentlyContinue
  & ssh.exe $HostName "rm -f $(Quote-Sh $remoteScript)" 2>$null | Out-Null
}
