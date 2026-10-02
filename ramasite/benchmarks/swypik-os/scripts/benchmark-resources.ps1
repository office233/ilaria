[CmdletBinding()]
param(
    [string]$Executable = '',
    [string]$OutputDirectory = '',
    [string]$ProductRoot = '',
    [ValidateSet('phone', 'balanced', 'performance')][string[]]$Profiles = @('balanced', 'phone'),
    [ValidateRange(1, 20)][int]$RunsPerProfile = 3,
    [ValidateRange(1, 60)][int]$StartupSeconds = 4,
    [ValidateRange(1, 60)][int]$IdleSeconds = 5,
    [ValidateRange(0, 10)][int]$QuiesceSeconds = 3,
    [ValidateRange(20, 1000)][int]$SampleIntervalMs = 100,
    [ValidateRange(5, 60)][int]$WindowTimeoutSeconds = 25
)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'The native resource benchmark requires Windows.' }

if (-not $ProductRoot) {
    $workspaceRoot = $PSScriptRoot
    for ($i = 0; $i -lt 4; $i++) { $workspaceRoot = Split-Path -Parent $workspaceRoot }
    $ProductRoot = Join-Path $workspaceRoot 'swypik-os'
}
$root = [IO.Path]::GetFullPath($ProductRoot)
if (-not (Test-Path -LiteralPath (Join-Path $root 'go.mod'))) {
    throw "SwypikOS product root must contain go.mod: $root"
}
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $root ('out\resource-bench-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 6))
}
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $OutputDirectory) {
    $existing = @(Get-ChildItem -LiteralPath $OutputDirectory -Force -ErrorAction Stop)
    if ($existing.Count -ne 0) {
        throw "Output directory must be empty for an isolated benchmark: $OutputDirectory"
    }
}
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

function Get-Median([double[]]$Values) {
    if (-not $Values -or $Values.Count -eq 0) { return 0.0 }
    $sorted = @($Values | Sort-Object)
    $middle = [int][math]::Floor($sorted.Count / 2)
    if (($sorted.Count % 2) -eq 1) { return [double]$sorted[$middle] }
    return ([double]$sorted[$middle - 1] + [double]$sorted[$middle]) / 2.0
}

function Get-Average([double[]]$Values) {
    if (-not $Values -or $Values.Count -eq 0) { return 0.0 }
    return [double](($Values | Measure-Object -Average).Average)
}

function Round-Metric([double]$Value, [int]$Digits = 3) {
    return [math]::Round($Value, $Digits)
}

function Get-Sample([Diagnostics.Process]$Process, [Diagnostics.Stopwatch]$Clock) {
    $Process.Refresh()
    if ($Process.HasExited) { throw "Desktop exited during benchmark (exit $($Process.ExitCode))." }
    return [pscustomobject][ordered]@{
        elapsed_ms = [int64]$Clock.ElapsedMilliseconds
        working_set_mb = Round-Metric ($Process.WorkingSet64 / 1MB) 3
        private_mb = Round-Metric ($Process.PrivateMemorySize64 / 1MB) 3
        cpu_seconds = Round-Metric $Process.TotalProcessorTime.TotalSeconds 6
        threads = [int]$Process.Threads.Count
        handles = [int]$Process.HandleCount
    }
}

function Test-LifecycleMarker([string]$DataDirectory, [string]$Marker) {
    $logDirectory = Join-Path $DataDirectory 'logs'
    if (-not (Test-Path -LiteralPath $logDirectory)) { return $false }
    $log = Get-ChildItem -LiteralPath $logDirectory -Filter 'desktop-*.log' -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
    if (-not $log) { return $false }
    return [bool](Select-String -LiteralPath $log.FullName -SimpleMatch $Marker -Quiet -ErrorAction Stop)
}

function Build-BenchmarkExecutable([string]$Destination) {
    if (-not (Get-Command go -ErrorAction SilentlyContinue)) { throw 'Go is required to build the benchmark executable.' }
    $previousGOOS = $env:GOOS
    $previousGOARCH = $env:GOARCH
    $previousCGO = $env:CGO_ENABLED
    Push-Location -LiteralPath $root
    try {
        $hostArch = (& go env GOHOSTARCH).Trim()
        if ($LASTEXITCODE -ne 0 -or $hostArch -notin @('amd64', 'arm64')) { throw 'A supported 64-bit Go toolchain is required.' }
        $env:GOOS = 'windows'
        $env:GOARCH = $hostArch
        $env:CGO_ENABLED = '0'
        & go build -trimpath -ldflags "-H=windowsgui -s -w -X main.desktopGUI=true -X main.buildVersion=resource-bench" -o $Destination ./cmd/swypik-os
        if ($LASTEXITCODE -ne 0) { throw 'Benchmark GUI compilation failed.' }
    } finally {
        $env:GOOS = $previousGOOS
        $env:GOARCH = $previousGOARCH
        $env:CGO_ENABLED = $previousCGO
        Pop-Location
    }
}

$builtForBenchmark = $false
if ($Executable) {
    $Executable = (Resolve-Path -LiteralPath $Executable).ProviderPath
} else {
    $Executable = Join-Path $OutputDirectory 'SwypikOS-resource.exe'
    Build-BenchmarkExecutable $Executable
    $builtForBenchmark = $true
}

$executableHash = (Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash
$revision = $null
$dirty = $null
if (Get-Command git -ErrorAction SilentlyContinue) {
    Push-Location -LiteralPath $root
    try {
        # Run Git through cmd so line-ending warnings on a dirty Windows checkout
        # cannot become terminating PowerShell NativeCommandError records.
        $revisionText = (& cmd.exe /d /c "git rev-parse --short HEAD 2>nul" | Out-String).Trim()
        if ($LASTEXITCODE -eq 0 -and $revisionText) { $revision = $revisionText }
        $statusText = (& cmd.exe /d /c "git status --porcelain --untracked-files=all 2>nul" | Out-String)
        $dirty = ($LASTEXITCODE -ne 0 -or -not [string]::IsNullOrWhiteSpace($statusText))
    } finally { Pop-Location }
}

$logicalProcessors = [Environment]::ProcessorCount
$runs = New-Object System.Collections.Generic.List[object]
$runNumber = 0
$oldProfile = $env:SWYPIK_RESOURCE_PROFILE

try {
    foreach ($profile in $Profiles) {
        for ($profileRun = 1; $profileRun -le $RunsPerProfile; $profileRun++) {
            $runNumber++
            $runDirectory = Join-Path $OutputDirectory ("run-{0:D2}-{1}" -f $runNumber, $profile)
            New-Item -ItemType Directory -Force -Path $runDirectory | Out-Null
            $data = Join-Path $runDirectory 'data'
            $workspace = Join-Path $runDirectory 'workspace'
            $arguments = '-data-dir "' + $data + '" -workspace "' + $workspace + '"'
            $process = $null
            $clock = [Diagnostics.Stopwatch]::StartNew()
            $startupSamples = New-Object System.Collections.Generic.List[object]
            $idleSamples = New-Object System.Collections.Generic.List[object]
            $windowReadyMs = $null
            $fontsWarmedMs = $null
            $cleanShutdown = $false

            try {
                $env:SWYPIK_RESOURCE_PROFILE = $profile
                $clock.Restart()
                $process = Start-Process -FilePath $Executable -ArgumentList $arguments -WorkingDirectory $env:TEMP -PassThru
                $null = $process.Handle

                $startupDeadline = [TimeSpan]::FromSeconds($StartupSeconds)
                $windowDeadline = [TimeSpan]::FromSeconds($WindowTimeoutSeconds)
                do {
                    $sample = Get-Sample $process $clock
                    $startupSamples.Add($sample)
                    $process.Refresh()
                    if ($null -eq $windowReadyMs -and $process.MainWindowHandle -ne [IntPtr]::Zero) {
                        $windowReadyMs = [int64]$clock.ElapsedMilliseconds
                    }
                    if ($null -eq $fontsWarmedMs -and (Test-LifecycleMarker $data 'Fonts warmed in')) {
                        $fontsWarmedMs = [int64]$clock.ElapsedMilliseconds
                    }
                    $quiesced = $null -ne $fontsWarmedMs -and $clock.ElapsedMilliseconds -ge ($fontsWarmedMs + ($QuiesceSeconds * 1000))
                    if ($clock.Elapsed -ge $startupDeadline -and $null -ne $windowReadyMs -and $quiesced) { break }
                    Start-Sleep -Milliseconds $SampleIntervalMs
                } while ($clock.Elapsed -lt $windowDeadline)

                if ($null -eq $windowReadyMs) { throw 'Native window did not appear before the benchmark deadline.' }
                if ($null -eq $fontsWarmedMs) { throw 'Font warm-up did not complete before the benchmark deadline.' }
                if ($clock.ElapsedMilliseconds -lt ($fontsWarmedMs + ($QuiesceSeconds * 1000))) { throw 'Desktop did not reach the post-warm quiescence window before the benchmark deadline.' }

                $process.Refresh()
                $idleStartWall = $clock.Elapsed.TotalSeconds
                $idleStartCPU = $process.TotalProcessorTime.TotalSeconds
                $idleDeadline = $clock.Elapsed + [TimeSpan]::FromSeconds($IdleSeconds)
                do {
                    $idleSamples.Add((Get-Sample $process $clock))
                    Start-Sleep -Milliseconds $SampleIntervalMs
                } while ($clock.Elapsed -lt $idleDeadline)
                $idleSamples.Add((Get-Sample $process $clock))
                $idleEndWall = $clock.Elapsed.TotalSeconds
                $idleEndCPU = $process.TotalProcessorTime.TotalSeconds

                $startupWS = [double[]]@($startupSamples | ForEach-Object { $_.working_set_mb })
                $startupPrivate = [double[]]@($startupSamples | ForEach-Object { $_.private_mb })
                $startupThreads = [double[]]@($startupSamples | ForEach-Object { $_.threads })
                $startupHandles = [double[]]@($startupSamples | ForEach-Object { $_.handles })
                $idleWS = [double[]]@($idleSamples | ForEach-Object { $_.working_set_mb })
                $idlePrivate = [double[]]@($idleSamples | ForEach-Object { $_.private_mb })
                $idleThreads = [double[]]@($idleSamples | ForEach-Object { $_.threads })
                $idleHandles = [double[]]@($idleSamples | ForEach-Object { $_.handles })
                $wallDelta = [math]::Max(0.001, $idleEndWall - $idleStartWall)
                $cpuDelta = [math]::Max(0.0, $idleEndCPU - $idleStartCPU)
                $idleCPUPercent = 100.0 * $cpuDelta / ($wallDelta * [math]::Max(1, $logicalProcessors))

                $samplesPath = Join-Path $runDirectory 'samples.json'
                $sampleJSON = [ordered]@{
                    profile = $profile
                    run = $profileRun
                    startup = $startupSamples.ToArray()
                    idle = $idleSamples.ToArray()
                } | ConvertTo-Json -Depth 6
                [IO.File]::WriteAllText($samplesPath, $sampleJSON + [Environment]::NewLine, (New-Object Text.UTF8Encoding $false))

                $runResult = [pscustomobject][ordered]@{
                    run = $profileRun
                    sequence = $runNumber
                    profile = $profile
                    window_ready_ms = $windowReadyMs
                    fonts_warmed_ms = $fontsWarmedMs
                    steady_start_ms = [int64]($idleStartWall * 1000)
                    startup_peak_working_set_mb = Round-Metric (($startupWS | Measure-Object -Maximum).Maximum) 3
                    startup_peak_private_mb = Round-Metric (($startupPrivate | Measure-Object -Maximum).Maximum) 3
                    startup_peak_threads = [int](($startupThreads | Measure-Object -Maximum).Maximum)
                    startup_peak_handles = [int](($startupHandles | Measure-Object -Maximum).Maximum)
                    steady_avg_working_set_mb = Round-Metric (Get-Average $idleWS) 3
                    steady_peak_working_set_mb = Round-Metric (($idleWS | Measure-Object -Maximum).Maximum) 3
                    steady_avg_private_mb = Round-Metric (Get-Average $idlePrivate) 3
                    steady_peak_private_mb = Round-Metric (($idlePrivate | Measure-Object -Maximum).Maximum) 3
                    steady_idle_cpu_percent = Round-Metric $idleCPUPercent 4
                    steady_avg_threads = Round-Metric (Get-Average $idleThreads) 2
                    steady_avg_handles = Round-Metric (Get-Average $idleHandles) 2
                    samples = $samplesPath
                }
                $runs.Add($runResult)

                $process.Refresh()
                if (-not $process.CloseMainWindow()) { throw 'Native close message could not be sent.' }
                if (-not $process.WaitForExit(10000)) { throw 'Desktop did not shut down cleanly.' }
                if ($process.ExitCode -ne 0) { throw "Desktop exited with code $($process.ExitCode)." }
                $cleanShutdown = $true
            } finally {
                if ($process) {
                    $process.Refresh()
                    if (-not $process.HasExited) {
                        [void]$process.CloseMainWindow()
                        if (-not $process.WaitForExit(2000)) { Stop-Process -Id $process.Id -Force }
                    }
                    $process.Dispose()
                }
                if (-not $cleanShutdown) {
                    Write-Warning "Run $runNumber ($profile) did not complete a clean shutdown."
                }
            }
        }
    }
} finally {
    $env:SWYPIK_RESOURCE_PROFILE = $oldProfile
}

$summary = foreach ($profile in $Profiles) {
    $profileRuns = @($runs.ToArray() | Where-Object { $_.profile -eq $profile })
    [pscustomobject][ordered]@{
        profile = $profile
        runs = $profileRuns.Count
        median_startup_peak_working_set_mb = Round-Metric (Get-Median ([double[]]@($profileRuns | ForEach-Object { $_.startup_peak_working_set_mb }))) 3
        max_startup_peak_working_set_mb = Round-Metric (($profileRuns.startup_peak_working_set_mb | Measure-Object -Maximum).Maximum) 3
        median_startup_peak_private_mb = Round-Metric (Get-Median ([double[]]@($profileRuns | ForEach-Object { $_.startup_peak_private_mb }))) 3
        median_window_ready_ms = [int64](Get-Median ([double[]]@($profileRuns | ForEach-Object { $_.window_ready_ms })))
        median_steady_working_set_mb = Round-Metric (Get-Median ([double[]]@($profileRuns | ForEach-Object { $_.steady_avg_working_set_mb }))) 3
        median_steady_private_mb = Round-Metric (Get-Median ([double[]]@($profileRuns | ForEach-Object { $_.steady_avg_private_mb }))) 3
        median_idle_cpu_percent = Round-Metric (Get-Median ([double[]]@($profileRuns | ForEach-Object { $_.steady_idle_cpu_percent }))) 4
        median_threads = Round-Metric (Get-Median ([double[]]@($profileRuns | ForEach-Object { $_.steady_avg_threads }))) 2
        median_handles = Round-Metric (Get-Median ([double[]]@($profileRuns | ForEach-Object { $_.steady_avg_handles }))) 2
    }
}

$report = [ordered]@{
    schema_version = 1
    measured_utc = [DateTime]::UtcNow.ToString('o')
    executable = $Executable
    product_root = $root
    executable_sha256 = $executableHash
    built_for_benchmark = $builtForBenchmark
    git_revision = $revision
    git_dirty = $dirty
    logical_processors = $logicalProcessors
    cpu_percent_denominator = 'all_logical_processors'
    energy_measured = $false
    startup_seconds = $StartupSeconds
    idle_seconds = $IdleSeconds
    sample_interval_ms = $SampleIntervalMs
    quiesce_seconds = $QuiesceSeconds
    profiles = @($Profiles)
    runs_per_profile = $RunsPerProfile
    summary = @($summary)
    runs = $runs.ToArray()
}
$reportPath = Join-Path $OutputDirectory 'resource-results.json'
[IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 7) + [Environment]::NewLine, (New-Object Text.UTF8Encoding $false))
$report | ConvertTo-Json -Depth 7
Write-Host "Resource benchmark report: $reportPath"
