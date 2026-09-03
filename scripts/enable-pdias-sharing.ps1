$ErrorActionPreference = 'Stop'

try {
  $httpPort = 3000
  $httpsPort = 3443
  $adminCommand = "netsh advfirewall firewall delete rule name=`"WAIS Local Network`" | Out-Null; netsh advfirewall firewall add rule name=`"WAIS Local Network`" dir=in action=allow protocol=TCP localport=$httpPort,$httpsPort profile=private"
  $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList '-NoProfile', '-Command', $adminCommand -PassThru -Wait
  if ($process.ExitCode -ne 0) { throw 'Windows did not add the WAIS sharing rule.' }
  Write-Host 'WAIS sharing is enabled for devices on this private Wi-Fi network.' -ForegroundColor Green
} catch {
  Write-Host "`nCould not enable sharing: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
