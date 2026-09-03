# Runs continuously under Windows Task Scheduler. It starts the local database
# when needed and restarts WAIS after an unexpected server exit.
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$logsDirectory = Join-Path $projectRoot 'logs'
$serviceLog = Join-Path $logsDirectory 'wais-service.log'
$serverOutLog = Join-Path $logsDirectory 'wais-server.out.log'
$serverErrorLog = Join-Path $logsDirectory 'wais-server.err.log'
$nodeExe = 'C:\Program Files\nodejs\node.exe'
$serverRunner = Join-Path $PSScriptRoot 'run-wais-server.ps1'
$environmentFile = Join-Path $projectRoot 'backend\.env'
$certificateDirectory = Join-Path $projectRoot 'backend\certificates'
$mysqlExe = 'C:\xampp\mysql\bin\mysqld.exe'
$mysqlConfig = 'C:\xampp\mysql\bin\my.ini'
$httpPort = 3000
$httpsPort = 3443

. (Join-Path $PSScriptRoot 'wais-common.ps1')

New-Item -ItemType Directory -Path $logsDirectory -Force | Out-Null

function Write-ServiceLog {
  param([string]$Message)
  Add-Content -LiteralPath $serviceLog -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $Message"
}

$dbHost = (Get-WaisConfigurationSetting -Name 'DB_HOST' -DefaultValue '127.0.0.1' -EnvironmentFile $environmentFile).Trim().ToLowerInvariant()
$configuredDbPort = Get-WaisConfigurationSetting -Name 'DB_PORT' -DefaultValue '3306' -EnvironmentFile $environmentFile
$dbPort = 3306
if (-not [int]::TryParse($configuredDbPort, [ref]$dbPort) -or $dbPort -lt 1 -or $dbPort -gt 65535) {
  throw 'DB_PORT in backend/.env must be a valid TCP port number.'
}
$isLocalDatabase = @('127.0.0.1', 'localhost', '::1', '[::1]') -contains $dbHost

function Start-LocalDatabase {
  if (-not $isLocalDatabase -or (Test-WaisListeningPort $dbPort)) { return }
  if (-not (Test-Path -LiteralPath $mysqlExe) -or -not (Test-Path -LiteralPath $mysqlConfig)) {
    throw 'XAMPP MySQL was not found.'
  }
  Write-ServiceLog 'Starting local MySQL.'
  Start-Process -FilePath $mysqlExe -ArgumentList "--defaults-file=$mysqlConfig" -WindowStyle Hidden
  $deadline = (Get-Date).AddSeconds(60)
  do {
    if (Test-WaisListeningPort $dbPort) { return }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)
  throw 'MySQL did not start within 60 seconds.'
}

if (-not (Test-Path -LiteralPath $nodeExe)) {
  Write-ServiceLog "Cannot start WAIS: Node.js was not found at $nodeExe."
  exit 1
}

Write-ServiceLog 'WAIS background service started.'
while ($true) {
  try {
    Start-LocalDatabase

    # A manual copy may still be running while this service is first enabled.
    # Leave it alone; the background service takes over if it stops.
    $hasHttps = (Test-Path -LiteralPath (Join-Path $certificateDirectory 'pdias-local.pfx')) -and
      (Test-Path -LiteralPath (Join-Path $certificateDirectory 'pdias-local.passphrase'))
    $serverPort = if ($hasHttps) { $httpsPort } else { $httpPort }
    if (Test-WaisListeningPort $serverPort) {
      Start-Sleep -Seconds 10
      continue
    }

    Write-ServiceLog 'Starting WAIS server.'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $serverRunner -HttpPort $httpPort -HttpsPort $httpsPort -NodeExe $nodeExe 1>> $serverOutLog 2>> $serverErrorLog
    Write-ServiceLog "WAIS server exited with code $LASTEXITCODE; retrying in 5 seconds."
  } catch {
    Write-ServiceLog "WAIS service error: $($_.Exception.Message). Retrying in 10 seconds."
    Start-Sleep -Seconds 10
    continue
  }
  Start-Sleep -Seconds 5
}
