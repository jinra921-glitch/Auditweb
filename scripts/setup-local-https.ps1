param(
  [string]$LanIp,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$certificateDirectory = Join-Path (Split-Path $PSScriptRoot -Parent) 'backend\certificates'
$pfxPath = Join-Path $certificateDirectory 'pdias-local.pfx'
$certificatePath = Join-Path $certificateDirectory 'pdias-local.cer'
$passphrasePath = Join-Path $certificateDirectory 'pdias-local.passphrase'
$networkInfoPath = Join-Path $certificateDirectory 'wais-local-network.json'

if (-not $LanIp) {
  $LanIp = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
    Where-Object { $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)' -and $_.IPAddress -ne '127.0.0.1' } |
    Select-Object -First 1 -ExpandProperty IPAddress
}
if (-not $LanIp) { throw 'Could not detect a private LAN IPv4 address. Run this script with -LanIp <server-ip>.' }
$parsedLanIp = $null
if (-not [System.Net.IPAddress]::TryParse($LanIp, [ref]$parsedLanIp)) { throw 'LanIp must be a valid IP address.' }

if (Test-Path -LiteralPath $pfxPath) {
  if (-not $Force) {
    Write-Host "WAIS HTTPS certificate already exists at $pfxPath. Run again with -Force to replace it for $LanIp."
    exit 0
  }
  Remove-Item -LiteralPath $pfxPath, $certificatePath, $passphrasePath, $networkInfoPath -Force -ErrorAction SilentlyContinue
}

New-Item -ItemType Directory -Path $certificateDirectory -Force | Out-Null
$randomBytes = New-Object byte[] 32
$randomGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $randomGenerator.GetBytes($randomBytes)
} finally {
  $randomGenerator.Dispose()
}
$passphrase = [Convert]::ToBase64String($randomBytes)
$securePassphrase = ConvertTo-SecureString -String $passphrase -AsPlainText -Force
$san = "2.5.29.17={text}DNS=localhost&DNS=$env:COMPUTERNAME&IPAddress=127.0.0.1&IPAddress=$LanIp"

$certificate = New-SelfSignedCertificate `
  -Subject 'CN=WAIS Local HTTPS' `
  -FriendlyName 'WAIS Local HTTPS' `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -KeyAlgorithm RSA `
  -KeyLength 2048 `
  -HashAlgorithm SHA256 `
  -KeyExportPolicy Exportable `
  -KeyUsage DigitalSignature, KeyEncipherment `
  -NotAfter (Get-Date).AddYears(3) `
  -TextExtension @('2.5.29.19={critical}{text}ca=false', $san)

Export-PfxCertificate -Cert $certificate -FilePath $pfxPath -Password $securePassphrase | Out-Null
Export-Certificate -Cert $certificate -FilePath $certificatePath | Out-Null
Import-Certificate -FilePath $certificatePath -CertStoreLocation 'Cert:\CurrentUser\Root' | Out-Null
[IO.File]::WriteAllText($passphrasePath, $passphrase, [Text.UTF8Encoding]::new($false))
[PSCustomObject]@{ lanIp = $LanIp; updatedAt = (Get-Date).ToUniversalTime().ToString('o') } |
  ConvertTo-Json -Compress | Set-Content -LiteralPath $networkInfoPath -Encoding UTF8

Write-Host "WAIS HTTPS is ready for localhost and $LanIp."
Write-Host 'Restart WAIS, then use HTTPS port 3443.'
