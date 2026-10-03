# Force-restart a hung Host Compute Service (vmcompute stuck in STOP_PENDING). ASCII only.
$log = 'E:\Swypik\ops\fix-wsl.log'
function Log($m) { $line = "$(Get-Date -Format 'HH:mm:ss')  [vmcompute] $m"; Add-Content -Path $log -Value $line; Write-Host $line }
try {
  Log "before: $((Get-Service vmcompute).Status)"
  Get-Process vmcompute -ErrorAction SilentlyContinue | ForEach-Object { Log "kill vmcompute $($_.Id)"; Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 4
  Start-Service vmcompute -ErrorAction Stop
  Start-Sleep -Seconds 3
  Log "after: vmcompute=$((Get-Service vmcompute).Status) WslService=$((Get-Service WslService).Status)"
  Start-Service WslService -ErrorAction SilentlyContinue
  Start-Process -WindowStyle Hidden -FilePath 'wsl.exe' -ArgumentList '-d','swypik','--exec','sleep','infinity'
  Start-Sleep -Seconds 30
  $probe = ((wsl.exe -d swypik -u root --exec sh -c 'uptime; systemctl is-active docker cloudflared' 2>&1) -join ' | ') -replace "`0", ''
  Log "probe: $probe"
} catch {
  Log "ERROR: $($_.Exception.Message)"
}
Log 'VM-DONE'
