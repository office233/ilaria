# Repair a hung WSL service (STOP_PENDING / HCS_E_CONNECTION_TIMEOUT) WITHOUT rebooting.
# Needs an elevated PowerShell. Log: E:\Swypik\ops\fix-wsl.log  (ASCII only: PS 5.1 reads BOM-less files as ANSI)
$log = 'E:\Swypik\ops\fix-wsl.log'
function Log($m) { $line = "$(Get-Date -Format 'HH:mm:ss')  $m"; Add-Content -Path $log -Value $line; Write-Host $line }
Set-Content -Path $log -Value "=== fix-wsl $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ==="

try {
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  Log "admin: $isAdmin"
  if (-not $isAdmin) { Log 'NOT elevated - stopping'; exit 1 }

  Log "before: WslService=$((Get-Service WslService).Status) vmcompute=$((Get-Service vmcompute).Status)"

  Get-Process wsl, wslhost -ErrorAction SilentlyContinue | ForEach-Object {
    Log "kill $($_.Name) $($_.Id)"; Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  }
  Get-Process wslservice -ErrorAction SilentlyContinue | ForEach-Object {
    Log "kill wslservice $($_.Id)"; Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 3

  try {
    Log 'restart vmcompute (HCS)'
    Restart-Service vmcompute -Force -ErrorAction Stop
  } catch {
    Log "vmcompute restart failed: $($_.Exception.Message) - killing process"
    Get-Process vmcompute -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
    Start-Service vmcompute -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 3

  Start-Service WslService -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 5
  Log "after: WslService=$((Get-Service WslService).Status) vmcompute=$((Get-Service vmcompute).Status)"

  $list = ((wsl.exe -l -v 2>&1) -join ' | ') -replace "`0", ''
  Log "wsl -l -v: $list"
  Start-Process -WindowStyle Hidden -FilePath 'wsl.exe' -ArgumentList '-d','swypik','--exec','sleep','infinity'
  Start-Sleep -Seconds 25
  $probe = ((wsl.exe -d swypik -u root --exec sh -c 'uptime; systemctl is-active docker cloudflared' 2>&1) -join ' | ') -replace "`0", ''
  Log "probe: $probe"
} catch {
  Log "ERROR: $($_.Exception.Message)"
}
Log 'DONE'
