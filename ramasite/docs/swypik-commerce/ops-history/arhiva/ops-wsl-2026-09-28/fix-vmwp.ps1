# Kill the zombie WSL VM worker that keeps vmcompute from starting. ASCII only.
$log = 'E:\Swypik\ops\fix-wsl.log'
function Log($m) { $line = "$(Get-Date -Format 'HH:mm:ss')  [vmwp] $m"; Add-Content -Path $log -Value $line; Write-Host $line }
try {
  foreach ($procId in 3508, 24392) {
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($p) { Log "kill $($p.Name) $procId"; Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue }
  }
  $vc = Get-Process vmcompute -ErrorAction SilentlyContinue
  if ((Get-Service vmcompute).Status -ne 'Running' -and $vc) { Log "kill vmcompute $($vc.Id)"; Stop-Process -Id $vc.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 4
  Start-Service vmcompute -ErrorAction SilentlyContinue
  for ($i = 0; $i -lt 30 -and (Get-Service vmcompute).Status -ne 'Running'; $i++) { Start-Sleep -Seconds 2 }
  Log "vmcompute=$((Get-Service vmcompute).Status)"
  Get-Process wsl -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Restart-Service WslService -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
  Log "WslService=$((Get-Service WslService).Status)"
  Start-Process -WindowStyle Hidden -FilePath 'wsl.exe' -ArgumentList '-d','swypik','--exec','sleep','infinity'
  Start-Sleep -Seconds 30
  $probe = ((wsl.exe -d swypik -u root --exec sh -c 'uptime; systemctl is-active docker cloudflared' 2>&1) -join ' | ') -replace "`0", ''
  Log "probe: $probe"
} catch {
  Log "ERROR: $($_.Exception.Message)"
}
Log 'VMWP-DONE'
