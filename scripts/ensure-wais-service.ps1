$ErrorActionPreference = 'Stop'

# This runs the one-time administrator installer only when automatic startup
# has not yet been enabled. Later launches return immediately without a prompt.
if (Get-ScheduledTask -TaskName 'WAIS Server' -ErrorAction SilentlyContinue) { exit 0 }

$installer = Join-Path $PSScriptRoot 'install-wais-service.ps1'
$arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $installer + '"'
$process = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -PassThru -Wait
exit $process.ExitCode
