param(
    [switch]$E2E,
    [ValidateRange(0,60)][int]$FuzzSeconds = 0
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$reportDir = Join-Path ([IO.Path]::GetTempPath()) ('swypik-verification-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $reportDir | Out-Null
Push-Location -LiteralPath $projectRoot
try {
    $coverage = Join-Path $reportDir 'coverage.out'
    & go test -race "-coverprofile=$coverage" -json ./... | Set-Content -LiteralPath (Join-Path $reportDir 'go-tests.jsonl') -Encoding utf8
    if ($LASTEXITCODE -ne 0) { throw "Go tests failed. See $reportDir\go-tests.jsonl" }
    & go vet ./...
    if ($LASTEXITCODE -ne 0) { throw 'go vet failed' }
    & node --check ui/web/desktop.js
    if ($LASTEXITCODE -ne 0) { throw 'JavaScript syntax check failed' }
    & node --test ui/web/desktop.test.cjs
    if ($LASTEXITCODE -ne 0) { throw 'JavaScript tests failed' }
    if ($FuzzSeconds -gt 0) {
        & go test ./ui/web -run '^$' -fuzz '^FuzzIntegrationURL$' "-fuzztime=${FuzzSeconds}s" -parallel 2
        if ($LASTEXITCODE -ne 0) { throw 'URL fuzzing failed' }
        & go test ./core/coder -run '^$' -fuzz '^FuzzCommandOutput$' "-fuzztime=${FuzzSeconds}s" -parallel 2
        if ($LASTEXITCODE -ne 0) { throw 'Output fuzzing failed' }
    }
    & (Join-Path $PSScriptRoot 'build.ps1')
    if ($E2E) {
        $previousReportDir = $env:SWYPIK_TEST_REPORT_DIR
        try {
            $env:SWYPIK_TEST_REPORT_DIR = Join-Path $reportDir 'browser'
            & node scripts/e2e.cjs
            if ($LASTEXITCODE -ne 0) { throw 'Browser scenarios failed' }
        } finally { $env:SWYPIK_TEST_REPORT_DIR = $previousReportDir }
    }
    $events = Get-Content -LiteralPath (Join-Path $reportDir 'go-tests.jsonl') | ForEach-Object { $_ | ConvertFrom-Json }
    $passed = @($events | Where-Object { $_.Action -eq 'pass' -and $_.Test }).Count
    $skipped = @($events | Where-Object { $_.Action -eq 'skip' -and $_.Test }).Count
    Write-Host "Go test cases passed: $passed; skipped: $skipped"
    & go tool cover "-func=$coverage" | Select-Object -Last 1
    Write-Host "Reports: $reportDir"
} finally { Pop-Location }
