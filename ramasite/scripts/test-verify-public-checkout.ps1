#Requires -Version 7.0
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$taskScripts = $PSScriptRoot
. (Join-Path $taskScripts 'verify-public-checkout.ps1') -LibraryOnly
$testBase = Join-Path ([IO.Path]::GetTempPath()) ('nexus-checkout-tests-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($testBase)
$script:passed = 0
$script:failed = 0
$ambientGowork = $env:GOWORK
$env:GOWORK = 'off'

function Write-Fixture([string]$RootPath, [string]$Relative, [string]$Contents) {
    $target = Join-Path $RootPath $Relative
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
    [IO.File]::WriteAllText($target, $Contents, [Text.UTF8Encoding]::new($false))
}
function New-Fixture {
    $fixtureRoot = Join-Path $testBase ('public space [fixture] ' + [guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($fixtureRoot)
    $manifest = [ordered]@{ version = 1; gowork = 'off'; workflow = '.github/workflows/ci.yml'; workflowScripts = @('scripts/gate.ps1'); required = @('generated/contracts/types_gen.go') }
    $workflow = "env:`n  GOWORK: 'off'`njobs:`n  test:`n    steps:`n      - run: pwsh -File ./scripts/gate.ps1`n"
    $fixture = [pscustomobject]@{ Root = $fixtureRoot; Manifest = $manifest; Workflow = $workflow; Tracked = @('scripts/public-checkout.inputs.json', '.github/workflows/ci.yml', 'scripts/gate.ps1', 'generated/contracts/types_gen.go') }
    Write-Fixture $fixtureRoot 'scripts/public-checkout.inputs.json' ($manifest | ConvertTo-Json -Depth 6)
    Write-Fixture $fixtureRoot '.github/workflows/ci.yml' $workflow
    Write-Fixture $fixtureRoot 'scripts/gate.ps1' '# public synthetic script; never executed'
    Write-Fixture $fixtureRoot 'generated/contracts/types_gen.go' '// public synthetic generated contract; never compiled'
    return $fixture
}
function Save-Manifest($Fixture) { Write-Fixture $Fixture.Root 'scripts/public-checkout.inputs.json' ($Fixture.Manifest | ConvertTo-Json -Depth 6) }
function Fixture-Git($Fixture, [string]$Fault = '') {
    $state = $Fixture
    $selectedFault = $Fault
    return {
        param([string[]]$Arguments)
        $joined = $Arguments -join ' '
        if ($selectedFault -eq $joined) { return @{ ExitCode = 128; Output = ''; Error = 'synthetic Git failure' } }
        switch ($joined) {
            'rev-parse --show-toplevel' { return @{ ExitCode = 0; Output = $(if ($selectedFault -eq 'wrong-root') { Join-Path $state.Root 'nested' } else { $state.Root }); Error = '' } }
            'rev-parse --verify HEAD' { return @{ ExitCode = 0; Output = $(if ($selectedFault -eq 'bad-head') { 'invalid' } else { 'a' * 40 }); Error = '' } }
            'ls-files --stage -z' {
                $entries = foreach ($path in $state.Tracked) {
                    $stage = if ($selectedFault -eq 'conflict') { '1' } else { '0' }
                    $mode = if ($selectedFault -eq 'index-symlink' -and $path -eq 'scripts/gate.ps1') { '120000' } else { '100644' }
                    "$mode $('b' * 40) $stage`t$path`0"
                }
                return @{ ExitCode = 0; Output = ($entries -join ''); Error = '' }
            }
            default { throw ('Unexpected Git command in fixture: ' + $joined) }
        }
    }.GetNewClosure()
}
function Check($Fixture, [string]$Fault = '') { Test-PublicCheckout -RootPath $Fixture.Root -InputPath 'scripts/public-checkout.inputs.json' -GitAdapter (Fixture-Git $Fixture $Fault) }
function Assert-True([bool]$Value, [string]$Message) { if (-not $Value) { throw $Message } }
function Assert-Issue($Result, [string]$Code, [string]$Path = '') {
    Assert-True (-not $Result.success) 'A refused fixture reported success'
    Assert-True (@($Result.issues | Where-Object { $_.code -eq $Code -and (-not $Path -or $_.path -eq $Path) }).Count -gt 0) ('Missing expected issue: ' + $Code + ' ' + $Path)
}
function Assert-PreflightReason($Result, [string]$Prefix) {
    Assert-Issue $Result 'preflight_error'
    Assert-True (@($Result.issues | Where-Object { $_.code -eq 'preflight_error' -and $_.message.StartsWith($Prefix, [StringComparison]::Ordinal) }).Count -gt 0) ('Wrong rejection reason; expected ' + $Prefix)
}
function Case([string]$Name, [scriptblock]$Body) {
    try { & $Body; $script:passed++; Write-Output ('PASS ' + $Name) }
    catch { $script:failed++; Write-Output ('FAIL ' + $Name + ': ' + $_.Exception.Message) }
}
try {
    Case 'complete public fixture, including a root with spaces and literal brackets' {
        $f = New-Fixture; $r = Check $f
        Assert-True $r.success ($r.issues | ConvertTo-Json -Compress)
        Assert-True ($r.head -eq ('a' * 40)) 'No Git HEAD proof'
        Assert-True ($r.workflowReferences -contains 'scripts/gate.ps1') 'Workflow dependency omitted'
        Assert-True (@($r.dependencies | Where-Object { -not $_.tracked -or -not $_.exists }).Count -eq 0) 'Incomplete metadata accepted'
    }
    Case 'untracked script that exists is refused' {
        $f = New-Fixture; $f.Tracked = @($f.Tracked | Where-Object { $_ -ne 'scripts/gate.ps1' })
        Assert-Issue (Check $f) 'untracked' 'scripts/gate.ps1'
    }
    Case 'tracked workflow script missing on disk is refused' {
        $f = New-Fixture; Remove-Item -LiteralPath (Join-Path $f.Root 'scripts/gate.ps1')
        Assert-Issue (Check $f) 'missing' 'scripts/gate.ps1'
    }
    Case 'missing generated contract is refused' {
        $f = New-Fixture; Remove-Item -LiteralPath (Join-Path $f.Root 'generated/contracts/types_gen.go')
        Assert-Issue (Check $f) 'missing' 'generated/contracts/types_gen.go'
    }
    Case 'untracked input manifest is refused' {
        $f = New-Fixture; $f.Tracked = @($f.Tracked | Where-Object { $_ -ne 'scripts/public-checkout.inputs.json' })
        Assert-Issue (Check $f) 'untracked' 'scripts/public-checkout.inputs.json'
    }
    foreach ($fault in @('rev-parse --show-toplevel', 'rev-parse --verify HEAD', 'ls-files --stage -z', 'wrong-root', 'bad-head', 'conflict')) {
        Case ('Git failure or invalid authoritative metadata: ' + $fault) { $f = New-Fixture; Assert-Issue (Check $f $fault) 'preflight_error' }
    }
    Case 'index symlink cannot establish regular public input tracking' {
        $f = New-Fixture; Assert-Issue (Check $f 'index-symlink') 'untracked' 'scripts/gate.ps1'
    }
    Case 'unsafe path forms and noncanonical aliases are refused' {
        foreach ($path in @('../outside.txt', '/outside.txt', 'C:\outside.txt', 'generated/../outside.txt', 'generated//types.go', 'generated/./types.go', 'generated/*.go', 'generated/?.go')) {
            $f = New-Fixture; $f.Manifest.required = @($path); Save-Manifest $f
            Assert-Issue (Check $f) 'preflight_error'
        }
    }
    Case 'duplicate canonical input paths are refused' {
        $f = New-Fixture; $f.Manifest.required = @('generated/contracts/types_gen.go', './generated/contracts/types_gen.go'); Save-Manifest $f
        Assert-Issue (Check $f) 'preflight_error'
    }
    Case 'duplicate JSON keys are refused' {
        $f = New-Fixture; $raw = [IO.File]::ReadAllText((Join-Path $f.Root 'scripts/public-checkout.inputs.json'))
        Write-Fixture $f.Root 'scripts/public-checkout.inputs.json' ($raw.Replace('"version": 1,', '"version": 1, "version": 1,'))
        Assert-Issue (Check $f) 'preflight_error'
    }
    Case 'manifest casing aliases, unknown fields and scalar/array types fail closed' {
        foreach ($change in @('case', 'unknown', 'version', 'null-array', 'empty-array')) {
            $f = New-Fixture
            switch ($change) {
                'case' {
                    $raw = [IO.File]::ReadAllText((Join-Path $f.Root 'scripts/public-checkout.inputs.json'))
                    Write-Fixture $f.Root 'scripts/public-checkout.inputs.json' ($raw.Replace('"version":', '"Version":'))
                }
                'unknown' { $f.Manifest.extra = 'unsupported'; Save-Manifest $f }
                'version' { $f.Manifest.version = '1'; Save-Manifest $f }
                'null-array' { $f.Manifest.required = $null; Save-Manifest $f }
                'empty-array' { $f.Manifest.workflowScripts = @(); Save-Manifest $f }
            }
            Assert-PreflightReason (Check $f) 'Input manifest'
        }
    }
    Case 'PowerShell call operator and a literal quoted path with spaces are supported' {
        $f = New-Fixture; $path = 'scripts/gate [space].ps1'
        Write-Fixture $f.Root $path '# public synthetic; never executed'
        $f.Tracked += $path; $f.Manifest.workflowScripts = @($path); Save-Manifest $f
        Write-Fixture $f.Root '.github/workflows/ci.yml' ($f.Workflow.Replace('pwsh -File ./scripts/gate.ps1', "& './$path'"))
        $r = Check $f; Assert-True $r.success ($r.issues | ConvertTo-Json -Compress)
    }
    Case 'literal multiline Bash and nested delegated static Go commands are supported' {
        $f = New-Fixture
        $run = "bash ./scripts/gate.ps1 bash -lc 'cd product && go test -count=1 ./...'"
        Write-Fixture $f.Root '.github/workflows/ci.yml' ($f.Workflow.Replace('run: pwsh -File ./scripts/gate.ps1', "run: |`n          $run"))
        $r = Check $f; Assert-True $r.success ($r.issues | ConvertTo-Json -Compress)
    }
    foreach ($unsupported in @('> ./scripts/gate.ps1', '*shared_run', '!tag ./scripts/gate.ps1', 'pwsh -File "$env:SCRIPT"', 'pwsh -File ./scripts/gate.ps1; echo extra', 'pwsh -File "./scripts/gate.ps1', 'bash ./scripts/gate.ps1 \')) {
        Case ('unsupported run syntax fails closed: ' + $unsupported) {
            $f = New-Fixture; Write-Fixture $f.Root '.github/workflows/ci.yml' ($f.Workflow.Replace('pwsh -File ./scripts/gate.ps1', $unsupported))
            Assert-PreflightReason (Check $f) 'Workflow'
        }
    }
    Case 'flow-mapped run cannot hide an additional workflow dependency' {
        $f = New-Fixture; Write-Fixture $f.Root '.github/workflows/ci.yml' ($f.Workflow + "      - {run: ./scripts/hidden.ps1}`n")
        Assert-PreflightReason (Check $f) 'Workflow'
    }
    Case 'local action dependency unsupported rather than silently certified' {
        $f = New-Fixture; Write-Fixture $f.Root '.github/workflows/ci.yml' ($f.Workflow + "      - uses: ./local-action`n")
        Assert-PreflightReason (Check $f) 'Workflow'
    }
    Case 'GOWORK top-level off is mandatory and overrides are refused' {
        $template = (New-Fixture).Workflow
        $invalid = @($template.Replace("GOWORK: 'off'", "GOWORK: 'on'"), $template.Replace('env:', 'not_env:'), ($template + "    env:`n      GOWORK: 'on'`n"))
        foreach ($workflow in $invalid) {
            $f = New-Fixture; Write-Fixture $f.Root '.github/workflows/ci.yml' $workflow
            Assert-Issue (Check $f) 'preflight_error'
        }
    }
    Case 'ambient GOWORK override is refused' {
        $f = New-Fixture; $env:GOWORK = 'on'
        try { Assert-Issue (Check $f) 'preflight_error' } finally { $env:GOWORK = 'off' }
    }
    Case 'expected workflow gate cannot disappear while a different script remains' {
        $f = New-Fixture; Write-Fixture $f.Root '.github/workflows/ci.yml' ($f.Workflow.Replace('scripts/gate.ps1', 'scripts/other.ps1'))
        Assert-Issue (Check $f) 'workflow_reference_missing' 'scripts/gate.ps1'
    }
    Case 'no workflow script references cannot yield vacuous success' {
        $f = New-Fixture; Write-Fixture $f.Root '.github/workflows/ci.yml' ($f.Workflow.Replace('pwsh -File ./scripts/gate.ps1', 'go test ./...'))
        Assert-Issue (Check $f) 'preflight_error'
    }
    Case 'Python script outside scripts is discovered even when absent from the manifest' {
        $f = New-Fixture
        Write-Fixture $f.Root 'tools/public_probe.py' '# public synthetic; never executed'
        Write-Fixture $f.Root '.github/workflows/ci.yml' ($f.Workflow + "      - run: python ./tools/public_probe.py`n")
        Assert-Issue (Check $f) 'untracked' 'tools/public_probe.py'
    }
    Case 'reparse ancestor cannot redirect an input outside the selected checkout' {
        $f = New-Fixture; $outside = New-Fixture
        Write-Fixture $outside.Root 'types_gen.go' '// public synthetic target outside selected checkout'
        $link = Join-Path $f.Root 'linked'
        if ($IsWindows) { New-Item -ItemType Junction -Path $link -Target $outside.Root | Out-Null }
        else { [void][IO.Directory]::CreateSymbolicLink($link, $outside.Root) }
        $f.Manifest.required = @('linked/types_gen.go'); Save-Manifest $f
        $f.Tracked += 'linked/types_gen.go'
        Assert-PreflightReason (Check $f) 'Reparse'
    }
    Case 'quoted mapping keys cannot hide an additional run dependency' {
        $f = New-Fixture; Write-Fixture $f.Root '.github/workflows/ci.yml' ($f.Workflow + "      - 'run': ./scripts/hidden.ps1`n")
        Assert-PreflightReason (Check $f) 'Workflow'
    }
    Case 'explicit complex mapping keys cannot hide an additional run dependency' {
        $f = New-Fixture; Write-Fixture $f.Root '.github/workflows/ci.yml' ($f.Workflow + "      - ? run`n        : ./scripts/hidden.ps1`n")
        Assert-PreflightReason (Check $f) 'Workflow'
    }
    foreach ($interpreter in @('source', 'bash')) {
        Case ('extensionless local dependency discovered for ' + $interpreter) {
            $f = New-Fixture; Write-Fixture $f.Root 'helpers/public' '# public synthetic; never executed'
            Write-Fixture $f.Root '.github/workflows/ci.yml' ($f.Workflow + "      - run: $interpreter ./helpers/public`n")
            Assert-Issue (Check $f) 'untracked' 'helpers/public'
        }
    }
    Case 'library-only interface cannot silently succeed as a production CLI' {
        $psi = [Diagnostics.ProcessStartInfo]::new()
        $psi.FileName = (Get-Process -Id $PID).Path
        foreach ($arg in @('-NoProfile', '-File', (Join-Path $taskScripts 'verify-public-checkout.ps1'), '-LibraryOnly')) { $psi.ArgumentList.Add($arg) }
        $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
        $child = [Diagnostics.Process]::new(); $child.StartInfo = $psi
        try {
            Assert-True ($child.Start()) 'CLI child failed to start'
            $stdout = $child.StandardOutput.ReadToEndAsync(); $stderr = $child.StandardError.ReadToEndAsync()
            Assert-True ($child.WaitForExit(15000)) 'CLI child timed out'
            Assert-True ($child.ExitCode -ne 0) 'LibraryOnly bypass falsely yielded CLI success'
            Assert-True ($stderr.Result.Contains('dot-source test interface')) 'CLI rejected for the wrong reason'
            Assert-True (-not $stdout.Result.Contains('success=True')) 'CLI emitted a success proof'
        } finally { if (-not $child.HasExited) { $child.Kill($true) }; $child.Dispose() }
    }
    foreach ($invocation in @(@{command='bash';path='helpers/public'}, @{command='node';path='tools/public.js'})) {
        Case ('review bare interpreter input absent: ' + $invocation.command) {
            $f = New-Fixture; $relative = $invocation.path
            Write-Fixture $f.Root '.github/workflows/ci.yml' ($f.Workflow + "      - run: $($invocation.command) $relative`n")
            $r = Check $f; Assert-Issue $r 'missing' $relative; Assert-Issue $r 'untracked' $relative
        }
        Case ('review bare interpreter input exists but is untracked: ' + $invocation.command) {
            $f = New-Fixture; $relative = $invocation.path
            Write-Fixture $f.Root $relative '# public fixture; never executed'
            Write-Fixture $f.Root '.github/workflows/ci.yml' ($f.Workflow + "      - run: $($invocation.command) $relative`n")
            Assert-Issue (Check $f) 'untracked' $relative
        }
        Case ('review valid tracked bare interpreter input is actually inventoried: ' + $invocation.command) {
            $f = New-Fixture; $relative = $invocation.path
            Write-Fixture $f.Root $relative '# public fixture; never executed'; $f.Tracked += $relative
            Write-Fixture $f.Root '.github/workflows/ci.yml' ($f.Workflow + "      - run: $($invocation.command) $relative`n")
            $r = Check $f; Assert-True $r.success ($r.issues | ConvertTo-Json -Compress)
            Assert-True (@($r.dependencies | Where-Object path -eq $relative).Count -eq 1) 'Required literal input was omitted from dependency inventory'
        }
    }
    Case 'review bare quoted interpreter paths retain spaces and literal brackets' {
        foreach ($command in @('bash', 'node')) {
            $f = New-Fixture; $relative = 'tools/public [space].js'
            Write-Fixture $f.Root $relative '# public fixture; never executed'; $f.Tracked += $relative
            Write-Fixture $f.Root '.github/workflows/ci.yml' ($f.Workflow + "      - run: $command '$relative'`n")
            $r = Check $f; Assert-True $r.success ($r.issues | ConvertTo-Json -Compress)
            Assert-True (@($r.dependencies | Where-Object path -eq $relative).Count -eq 1) 'Quoted source path was omitted'
        }
    }
    Case 'review explicit dot slash interpreter paths remain supported' {
        foreach ($command in @('bash', 'node')) {
            $f = New-Fixture; $relative = 'tools/public.js'
            Write-Fixture $f.Root $relative '# public fixture; never executed'; $f.Tracked += $relative
            Write-Fixture $f.Root '.github/workflows/ci.yml' ($f.Workflow + "      - run: $command ./$relative`n")
            $r = Check $f; Assert-True $r.success ($r.issues | ConvertTo-Json -Compress)
            Assert-True (@($r.dependencies | Where-Object path -eq $relative).Count -eq 1) 'Explicit source path was omitted'
        }
    }
    foreach ($unsupported in @('python -m localmodule', 'node --eval "console.log(1)"', 'node --require tools/helper.js tools/public.js', 'bash -O extglob helpers/public', 'env node tools/public.js', 'python -m pip install -r requirements.txt')) {
        Case ('review opaque interpreter form fails closed: ' + $unsupported) {
            $f = New-Fixture; Write-Fixture $f.Root '.github/workflows/ci.yml' ($f.Workflow + "      - run: $unsupported`n")
            Assert-PreflightReason (Check $f) 'Workflow'
        }
    }
    Case 'review existing literal pip and pytest CI tooling remain explicitly recognized' {
        $f = New-Fixture
        Write-Fixture $f.Root '.github/workflows/ci.yml' ($f.Workflow + "      - run: python -m pip install --upgrade pip`n      - run: python -m pytest -q forge`n")
        $r = Check $f; Assert-True $r.success ($r.issues | ConvertTo-Json -Compress)
    }
    Case 'review non-root working directory cannot validate a different root-relative script' {
        $f = New-Fixture; Write-Fixture $f.Root 'helpers/public' '# root copy must not validate an absent product copy'; $f.Tracked += 'helpers/public'
        Write-Fixture $f.Root '.github/workflows/ci.yml' ($f.Workflow + "      - run: bash helpers/public`n        working-directory: product`n")
        Assert-PreflightReason (Check $f) 'Workflow'
    }
    Case 'review repeated bare script references cannot bypass non-root directory refusal' {
        $f = New-Fixture; Write-Fixture $f.Root 'gate.ps1' '# public fixture; never executed'; $f.Tracked += 'gate.ps1'
        Write-Fixture $f.Root '.github/workflows/ci.yml' ($f.Workflow + "      - run: gate.ps1`n      - run: gate.ps1`n        working-directory: product`n")
        Assert-PreflightReason (Check $f) 'Workflow'
    }
    Case 'real Git on a non-repository fixture fails without creating .git' {
        $f = New-Fixture; $r = Test-PublicCheckout -RootPath $f.Root -InputPath 'scripts/public-checkout.inputs.json'
        Assert-Issue $r 'preflight_error'
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $f.Root '.git'))) 'Git mutated the fixture'
    }
} finally {
    $env:GOWORK = $ambientGowork
    $resolvedTestBase = [IO.Path]::GetFullPath($testBase)
    $tempBoundary = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $resolvedTestBase.StartsWith($tempBoundary, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $resolvedTestBase) -notmatch '^nexus-checkout-tests-[0-9a-f]{32}$') { throw 'Unsafe fixture cleanup target' }
    Remove-Item -LiteralPath $resolvedTestBase -Recurse -Force
}
Write-Output "Public checkout regressions: passed=$script:passed failed=$script:failed"
if ($script:failed) { exit 1 }
exit 0
