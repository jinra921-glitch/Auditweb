[CmdletBinding()]
param([switch]$Elevated)

$ErrorActionPreference = 'Stop'

if (-not $Elevated) {
  $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Elevated"
  try {
    $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $arguments -PassThru -Wait -ErrorAction Stop
    exit $process.ExitCode
  } catch {
    Write-Host 'Windows administrator approval is required to enable automatic WAIS startup.' -ForegroundColor Red
    exit 1
  }
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$serviceScript = Join-Path $PSScriptRoot 'run-wais-service.ps1'
$taskName = 'WAIS Server'

if (-not (Test-Path -LiteralPath $serviceScript)) { throw 'The WAIS background-service script was not found.' }

$taskArguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $serviceScript + '"'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $taskArguments -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
  -Description 'Starts and supervises WAIS and its local MySQL database.' -Force | Out-Null
& netsh advfirewall firewall delete rule 'name=WAIS Local Network' | Out-Null
& netsh advfirewall firewall add rule 'name=WAIS Local Network' dir=in action=allow protocol=TCP localport=3000,3443 profile=private | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Windows did not add the WAIS local-network sharing rule.' }
Start-ScheduledTask -TaskName $taskName
Write-Host 'WAIS will now start automatically with Windows and is available to devices on this private Wi-Fi network.' -ForegroundColor Green
