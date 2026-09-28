[CmdletBinding()]
param(
    [string]$Executable = '',
    [string]$OutputDirectory = '',
    [switch]$CaptureScreenshot
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This smoke test requires an interactive Windows session.' }
$root = Split-Path -Parent $PSScriptRoot
if (-not $Executable) { $Executable = Join-Path $root 'bin\swypik-os.exe' }
$Executable = (Resolve-Path -LiteralPath $Executable).ProviderPath
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $root ('out\windows-smoke-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,6))
}
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
if (-not ('Swypik.NativeSmoke' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
namespace Swypik {
    public static class NativeSmoke {
        [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
        [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
        [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, UIntPtr wparam, IntPtr lparam, uint flags, uint timeout, out UIntPtr result);
        [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr hwnd, uint msg, UIntPtr wparam, IntPtr lparam);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    }
}
'@
}
$process = $null
$report = [ordered]@{
    status = 'running'
    executable = $Executable
    sha256 = (Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash
    process_id = $null
    window_class = $null
    window_title = $null
    responds_to_messages = $false
    visible = $false
    browser_children = @()
    listening_tcp_ports = @()
    screenshot = $null
    exit_code = $null
}
try {
    $data = Join-Path $OutputDirectory '_state'
    $workspace = Join-Path $OutputDirectory '_workspace'
    # Start from an unrelated working directory and an isolated fresh state.
    $arguments = '-data-dir "' + $data + '" -workspace "' + $workspace + '"'
    $process = Start-Process -FilePath $Executable -ArgumentList $arguments -WorkingDirectory $env:TEMP -PassThru
    $null = $process.Handle
    $report.process_id = $process.Id
    $deadline = [DateTime]::UtcNow.AddSeconds(25)
    $browserNames = @('electron.exe', 'chrome.exe', 'msedge.exe', 'msedgewebview2.exe', 'node.exe')
    $seenBrowsers = @()
    do {
        $process.Refresh()
        if ($process.HasExited) { throw "Desktop exited before creating a window (exit $($process.ExitCode))." }
        $seenBrowsers += @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($process.Id)" | Where-Object { $_.Name -in $browserNames } | Select-Object -ExpandProperty Name)
        if ($process.MainWindowHandle -ne [IntPtr]::Zero) { break }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    $hwnd = $process.MainWindowHandle
    if ($hwnd -eq [IntPtr]::Zero) { throw 'Native window did not appear before the deadline.' }
    $owner = [uint32]0
    [void][Swypik.NativeSmoke]::GetWindowThreadProcessId($hwnd, [ref]$owner)
    if ($owner -ne $process.Id) { throw 'Window does not belong to the launched executable.' }
    $className = New-Object Text.StringBuilder 256
    [void][Swypik.NativeSmoke]::GetClassName($hwnd, $className, $className.Capacity)
    $report.window_class = $className.ToString()
    $report.window_title = $process.MainWindowTitle
    $report.visible = [Swypik.NativeSmoke]::IsWindowVisible($hwnd)
    if ($report.window_class -ne 'SwypikOS_Native_Class' -or -not $report.visible) { throw 'Expected visible SwypikOS Win32 window was not created.' }
    $reply = [UIntPtr]::Zero
    if ([Swypik.NativeSmoke]::SendMessageTimeout($hwnd, 0, [UIntPtr]::Zero, [IntPtr]::Zero, 2, 2000, [ref]$reply) -eq [IntPtr]::Zero) { throw 'Window is not responding to messages.' }
    # Post a harmless local command (help) with non-ASCII text using real UTF-16
    # input messages; the window forwards them to its input field.
    $text = '/help swypik ' + [char]0x0219 + [char]0x021B + [char]::ConvertFromUtf32(0x1F680)
    foreach ($character in $text.ToCharArray()) {
        if (-not [Swypik.NativeSmoke]::PostMessage($hwnd, 0x0102, [UIntPtr][uint32]$character, [IntPtr]::Zero)) { throw 'Could not post native text input.' }
    }
    if (-not [Swypik.NativeSmoke]::PostMessage($hwnd, 0x0102, [UIntPtr][uint32]13, [IntPtr]::Zero)) { throw 'Could not post native Enter input.' }
    Start-Sleep -Milliseconds 1400
    $process.Refresh()
    if ($process.HasExited) { throw 'Desktop exited after native keyboard input.' }
    if ([Swypik.NativeSmoke]::SendMessageTimeout($hwnd, 0, [UIntPtr]::Zero, [IntPtr]::Zero, 2, 2000, [ref]$reply) -eq [IntPtr]::Zero) { throw 'Window stopped responding after the help command.' }
    $report.responds_to_messages = $true
    $seenBrowsers += @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($process.Id)" | Where-Object { $_.Name -in $browserNames } | Select-Object -ExpandProperty Name)
    $report.browser_children = @($seenBrowsers | Sort-Object -Unique)
    $report.listening_tcp_ports = @(Get-NetTCPConnection -OwningProcess $process.Id -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort)
    if ($report.browser_children.Count -or $report.listening_tcp_ports.Count) { throw 'Unexpected browser child process or TCP listener in native mode.' }
    $report['working_set_mb'] = [math]::Round($process.WorkingSet64 / 1MB, 2)
    if ($CaptureScreenshot) {
        [void][Swypik.NativeSmoke]::SetForegroundWindow($hwnd)
        Start-Sleep -Milliseconds 200
        if ([Swypik.NativeSmoke]::GetForegroundWindow() -eq $hwnd) {
            Add-Type -AssemblyName System.Drawing
            Add-Type -AssemblyName System.Windows.Forms
            $rect = New-Object Swypik.NativeSmoke+Rect
            if (-not [Swypik.NativeSmoke]::GetWindowRect($hwnd, [ref]$rect)) { throw 'Cannot inspect native window bounds.' }
            $screen = [Windows.Forms.SystemInformation]::VirtualScreen
            $left = [math]::Max($rect.Left, $screen.Left)
            $top = [math]::Max($rect.Top, $screen.Top)
            $width = [math]::Min($rect.Right, $screen.Right) - $left
            $height = [math]::Min($rect.Bottom, $screen.Bottom) - $top
            $bitmap = New-Object Drawing.Bitmap $width, $height
            $graphics = [Drawing.Graphics]::FromImage($bitmap)
            try {
                $graphics.CopyFromScreen($left, $top, 0, 0, $bitmap.Size)
                $imagePath = Join-Path $OutputDirectory 'native-window.png'
                $bitmap.Save($imagePath, [Drawing.Imaging.ImageFormat]::Png)
                $report.screenshot = $imagePath
            } finally { $graphics.Dispose(); $bitmap.Dispose() }
        } else {
            $report['screenshot_note'] = 'Foreground permission unavailable; no unrelated desktop was captured.'
        }
    }
    if (-not $process.CloseMainWindow()) { throw 'Native close message could not be sent.' }
    if (-not $process.WaitForExit(10000)) { throw 'Desktop did not shut down cleanly.' }
    $report.exit_code = $process.ExitCode
    if ($process.ExitCode -ne 0) { throw "Desktop exited with code $($process.ExitCode)." }
    $logs = @(Get-ChildItem -LiteralPath (Join-Path $data 'logs') -Filter '*.log')
    if (-not $logs.Count -or -not (Select-String -Path $logs.FullName -SimpleMatch 'Native desktop closed cleanly')) { throw 'Missing persisted clean-shutdown evidence.' }
    $report.status = 'passed'
} catch {
    $report.status = 'failed'
    $report['error'] = $_.Exception.Message
    throw
} finally {
    # Only terminate the process created by this test, never other Swypik sessions.
    if ($process) {
        $process.Refresh()
        if (-not $process.HasExited) {
            [void]$process.CloseMainWindow()
            if (-not $process.WaitForExit(2000)) { Stop-Process -Id $process.Id -Force }
        }
        $process.Dispose()
    }
    $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'report.json') -Encoding UTF8
}
$report | ConvertTo-Json -Depth 5
