[CmdletBinding()]
param(
  [int]$HttpPort = 3000,
  [int]$HttpsPort = 3443,
  [string]$NodeExe
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$serverScript = Join-Path $projectRoot 'backend\server.js'
if ($NodeExe) {
  if (-not (Test-Path -LiteralPath $NodeExe)) { throw "Node.js was not found at $NodeExe." }
  $nodeExe = (Resolve-Path -LiteralPath $NodeExe).Path
} else {
  $nodeExe = (Get-Command node -ErrorAction Stop).Source
}

$env:PORT = [string]$HttpPort
$env:HTTPS_PORT = [string]$HttpsPort
& $nodeExe $serverScript
exit $LASTEXITCODE
