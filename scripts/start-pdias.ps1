[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$serverRunner = Join-Path $PSScriptRoot 'run-wais-server.ps1'
$certificateDirectory = Join-Path $projectRoot 'backend\certificates'
$networkInfoPath = Join-Path $certificateDirectory 'wais-local-network.json'
$httpPort = 3000
$httpsPort = 3443
$serverScript = (Resolve-Path -LiteralPath (Join-Path $projectRoot 'backend\server.js')).Path
$environmentFile = Join-Path $projectRoot 'backend\.env'

. (Join-Path $PSScriptRoot 'wais-common.ps1')

function Wait-ForPort {
  param([int]$Port, [int]$TimeoutSeconds = 30)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    if (Test-WaisListeningPort $Port) { return $true }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Test-WaisHealth {
  param([int]$Port, [bool]$UseHttps)

  $client = $null
  $networkStream = $null
  $sslStream = $null
  $reader = $null
  try {
    $client = [System.Net.Sockets.TcpClient]::new()
    $connect = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $connect.AsyncWaitHandle.WaitOne(2000)) { return $false }
    $client.EndConnect($connect)
    $client.ReceiveTimeout = 2000
    $client.SendTimeout = 2000
    $networkStream = $client.GetStream()
    $networkStream.ReadTimeout = 2000
    $networkStream.WriteTimeout = 2000
    $requestStream = $networkStream
    if ($UseHttps) {
      $certificateValidator = [System.Net.Security.RemoteCertificateValidationCallback]{
        param($sender, $certificate, $chain, $sslPolicyErrors)
        return $true
      }
      $sslStream = [System.Net.Security.SslStream]::new($networkStream, $false, $certificateValidator)
      $sslStream.ReadTimeout = 2000
      $sslStream.WriteTimeout = 2000
      $sslStream.AuthenticateAsClient('localhost')
      $requestStream = $sslStream
    }
    $requestBytes = [Text.Encoding]::ASCII.GetBytes("GET /health HTTP/1.1`r`nHost: localhost`r`nConnection: close`r`n`r`n")
    $requestStream.Write($requestBytes, 0, $requestBytes.Length)
    $requestStream.Flush()
    $reader = [IO.StreamReader]::new($requestStream, [Text.Encoding]::UTF8, $false, 1024, $true)
    $response = $reader.ReadToEnd()
    return $response -match '(?s)^HTTP/1\.[01] 200\b.*\r?\n\r?\n.*"status"\s*:\s*"ok"'
  } catch {
    return $false
  } finally {
    if ($reader) { $reader.Dispose() }
    if ($sslStream) { $sslStream.Dispose() }
    if ($networkStream) { $networkStream.Dispose() }
    if ($client) { $client.Dispose() }
  }
}

function Test-WaisServer {
  param([int]$Port, [bool]$UseHttps)

  if (-not (Test-WaisListeningPort $Port)) { return $false }
  return Test-WaisHealth -Port $Port -UseHttps $UseHttps
}

function Wait-ForWaisServer {
  param([int]$Port, [bool]$UseHttps, [int]$TimeoutSeconds = 30)

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    if (Test-WaisServer -Port $Port -UseHttps $UseHttps) { return $true }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Get-PrivateLanIp {
  return Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)' -and $_.IPAddress -ne '127.0.0.1' -and $_.AddressState -eq 'Preferred' } |
    Select-Object -First 1 -ExpandProperty IPAddress
}

function Stop-WaisServer {
  $processIds = Get-NetTCPConnection -LocalPort $httpPort,$httpsPort -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($processId in $processIds) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
    $commandLine = [string]$process.CommandLine
    $isThisWaisServer = $process -and $process.Name -match '^node(?:\.exe)?$' -and
      $commandLine.IndexOf($serverScript, [StringComparison]::OrdinalIgnoreCase) -ge 0
    if ($isThisWaisServer) { Stop-Process -Id $processId -Force -ErrorAction Stop }
  }
}

try {
  # When the computer joins a different Wi-Fi network, its private address
  # changes. Refresh the local HTTPS certificate automatically for that new
  # address so other devices can use the displayed HTTPS link.
  $currentLanIp = Get-PrivateLanIp
  $savedLanIp = $null
  if (Test-Path -LiteralPath $networkInfoPath) {
    try { $savedLanIp = (Get-Content -LiteralPath $networkInfoPath -Raw | ConvertFrom-Json).lanIp } catch {}
  }
  $certificateUpdated = $false
  if ($currentLanIp -and $currentLanIp -ne $savedLanIp) {
    Write-Host "Preparing WAIS for this Wi-Fi network ($currentLanIp)..."
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'setup-local-https.ps1') -LanIp $currentLanIp -Force
    if ($LASTEXITCODE -ne 0) { throw 'WAIS could not update its local HTTPS certificate for this Wi-Fi network.' }
    $certificateUpdated = $true
  }
  $hasHttps = (Test-Path -LiteralPath (Join-Path $certificateDirectory 'pdias-local.pfx')) -and
    (Test-Path -LiteralPath (Join-Path $certificateDirectory 'pdias-local.passphrase'))
  $webUrl = if ($hasHttps) { "https://localhost:$httpsPort" } else { "http://localhost:$httpPort" }
  if ($certificateUpdated) { Stop-WaisServer }

  # Start XAMPP only for a local MySQL configuration. Remote databases and
  # local installations on another port must already be available.
  $dbHost = (Get-WaisConfigurationSetting -Name 'DB_HOST' -DefaultValue '127.0.0.1' -EnvironmentFile $environmentFile).Trim().ToLowerInvariant()
  $configuredDbPort = Get-WaisConfigurationSetting -Name 'DB_PORT' -DefaultValue '3306' -EnvironmentFile $environmentFile
  $dbPort = 3306
  if (-not [int]::TryParse($configuredDbPort, [ref]$dbPort) -or $dbPort -lt 1 -or $dbPort -gt 65535) {
    throw 'DB_PORT in backend/.env must be a valid TCP port number.'
  }
  $isLocalDatabase = @('127.0.0.1', 'localhost', '::1', '[::1]') -contains $dbHost
  if ($isLocalDatabase -and -not (Test-WaisListeningPort $dbPort)) {
    $mysqlExe = 'C:\xampp\mysql\bin\mysqld.exe'
    $mysqlConfig = 'C:\xampp\mysql\bin\my.ini'
    if (-not (Test-Path -LiteralPath $mysqlExe) -or -not (Test-Path -LiteralPath $mysqlConfig)) {
      throw 'MySQL is not running and the local XAMPP MySQL installation was not found. Open XAMPP and start MySQL, then try again.'
    }
    Write-Host 'Starting the local database...'
    Start-Process -FilePath $mysqlExe -ArgumentList "--defaults-file=$mysqlConfig" -WindowStyle Hidden
    if (-not (Wait-ForPort $dbPort)) { throw 'The local database did not start. Open XAMPP and start MySQL, then try again.' }
  }

  # Leave an already-running copy alone, so opening this file again is safe.
  $serverPort = if ($hasHttps) { $httpsPort } else { $httpPort }
  if (-not (Test-WaisListeningPort $serverPort)) {
    $logsDirectory = Join-Path $projectRoot 'logs'
    New-Item -ItemType Directory -Path $logsDirectory -Force | Out-Null
    Write-Host 'Starting WAIS...'
    $runnerArguments = "-NoProfile -ExecutionPolicy Bypass -File `"$serverRunner`" -HttpPort $httpPort -HttpsPort $httpsPort"
    Start-Process -FilePath 'powershell.exe' -ArgumentList $runnerArguments -WorkingDirectory $projectRoot -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $logsDirectory 'pdias.out.log') `
      -RedirectStandardError (Join-Path $logsDirectory 'pdias.err.log')
    if (-not (Wait-ForPort $serverPort)) {
      throw "WAIS did not start. See $(Join-Path $logsDirectory 'pdias.err.log') for the reason."
    }
  }

  Write-Host "Opening WAIS at $webUrl"
  if ($currentLanIp -and $hasHttps) {
    $sharingUrl = "https://${currentLanIp}:$httpsPort"
    Write-Host "Other devices on this Wi-Fi can use $sharingUrl"
    $shell = New-Object -ComObject WScript.Shell
    [void]$shell.Popup("WAIS is ready.`n`nOn another device connected to this Wi-Fi, open:`n$sharingUrl", 15, 'WAIS sharing link', 64)
  } elseif ($currentLanIp) {
    Write-Host 'HTTPS is not configured, so WAIS is available only on this computer. Run npm run setup:https before sharing it on the LAN.' -ForegroundColor Yellow
  }
  Start-Process $webUrl
} catch {
  Write-Host "`nCould not open WAIS: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
