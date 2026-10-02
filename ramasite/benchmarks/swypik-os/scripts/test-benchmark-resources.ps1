$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'benchmark-resources.ps1'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'Resource benchmark script has syntax errors.' }
$helper = $ast.Find({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-LifecycleMarker'
}, $true)
if (-not $helper) { throw 'Test-LifecycleMarker is missing.' }
. ([scriptblock]::Create($helper.Extent.Text))

$temporary = Join-Path ([IO.Path]::GetTempPath()) ('swypik-resource-marker-' + [Guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $temporary | Out-Null
    if (Test-LifecycleMarker $temporary 'Fonts warmed in') { throw 'Missing log directory reported ready.' }
    $logs = Join-Path $temporary 'logs'
    New-Item -ItemType Directory -Path $logs | Out-Null
    if (Test-LifecycleMarker $temporary 'Fonts warmed in') { throw 'Empty log directory reported ready.' }
    $log = Join-Path $logs 'desktop-test.log'
    [IO.File]::WriteAllText($log, "Win32 window ready`n")
    if (Test-LifecycleMarker $temporary 'Fonts warmed in') { throw 'A nonmatching file reported font warm-up complete.' }
    [IO.File]::AppendAllText($log, "Fonts warmed in 1.83s`n")
    if (-not (Test-LifecycleMarker $temporary 'Fonts warmed in')) { throw 'Actual completion marker was missed.' }
    Write-Output 'PASS resource readiness: missing directory, empty directory, absent marker, present marker'
} finally {
    if (Test-Path -LiteralPath $temporary) {
        if (Test-Path -LiteralPath (Join-Path $temporary 'logs\desktop-test.log')) {
            Remove-Item -LiteralPath (Join-Path $temporary 'logs\desktop-test.log')
        }
        if (Test-Path -LiteralPath (Join-Path $temporary 'logs')) {
            Remove-Item -LiteralPath (Join-Path $temporary 'logs')
        }
        Remove-Item -LiteralPath $temporary
    }
}
