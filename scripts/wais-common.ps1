function Test-WaisListeningPort {
  param([int]$Port)
  return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1)
}

function Get-WaisConfigurationSetting {
  param(
    [string]$Name,
    [string]$DefaultValue,
    [string]$EnvironmentFile
  )

  $processValue = [Environment]::GetEnvironmentVariable($Name)
  if (-not [string]::IsNullOrWhiteSpace($processValue)) { return $processValue.Trim() }
  if (Test-Path -LiteralPath $EnvironmentFile) {
    $pattern = '^\s*' + [regex]::Escape($Name) + '\s*=\s*(.*?)\s*$'
    foreach ($line in Get-Content -LiteralPath $EnvironmentFile) {
      if ($line -match $pattern) {
        $value = $Matches[1].Trim()
        if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
          $value = $value.Substring(1, $value.Length - 2)
        }
        if (-not [string]::IsNullOrWhiteSpace($value)) { return $value }
      }
    }
  }
  return $DefaultValue
}
