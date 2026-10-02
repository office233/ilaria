#Requires -Version 7.0
[CmdletBinding()]
param(
    [string]$Root = (Split-Path -Parent $PSScriptRoot),
    [string]$Inputs = 'scripts/public-checkout.inputs.json',
    [ValidateSet('Text', 'Json')][string]$Format = 'Text',
    [switch]$LibraryOnly
)

if ($LibraryOnly -and $MyInvocation.InvocationName -ne '.') { throw 'LibraryOnly is a dot-source test interface, not a successful CLI preflight.' }

# Public dependency text is data; neither workflow nor dependency scripts execute.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-PublicRootPath([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    if ($full -ne [IO.Path]::GetPathRoot($full)) { $full = $full.TrimEnd('\', '/') }
    return $full
}
function Resolve-PublicInputPath([string]$RootPath, [string]$Relative) {
    if ([string]::IsNullOrWhiteSpace($Relative) -or [Text.Encoding]::UTF8.GetByteCount($Relative) -gt 4096 -or $Relative -match '(^[/\\]|:|[\x00-\x1f\x7f]|[*?])') { throw 'Unsafe relative input path' }
    $relativePath = $Relative.Replace('\', '/')
    if ($relativePath.StartsWith('./', [StringComparison]::Ordinal)) { $relativePath = $relativePath.Substring(2) }
    if (@($relativePath.Split('/') | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' }).Count) { throw 'Unsafe relative input path components' }
    $full = [IO.Path]::GetFullPath((Join-Path $RootPath $relativePath))
    $boundary = $RootPath.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    $comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
    if (-not $full.StartsWith($boundary, $comparison)) { throw 'Input path escapes checkout root' }
    $walk = $full
    while ($walk.Length -ge $RootPath.Length) {
        $item = Get-Item -LiteralPath $walk -Force -ErrorAction SilentlyContinue
        if ($null -ne $item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Reparse input path refused' }
        if ([string]::Equals($walk, $RootPath, $comparison)) { break }
        $walk = [IO.Path]::GetDirectoryName($walk)
        if ($null -eq $walk) { throw 'Input ancestor traversal failed' }
    }
    return @{ Path = $relativePath; Full = $full }
}
function Read-PublicText([string]$Path) {
    if ((Get-Item -LiteralPath $Path -Force).Length -gt 1MB) { throw 'Public metadata text exceeds 1 MiB bound' }
    return [IO.File]::ReadAllText($Path, [Text.UTF8Encoding]::new($false, $true))
}
function Invoke-PublicCheckoutGit([string]$RootPath, [string[]]$Arguments) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = 'git'
    foreach ($argument in @('-C', $RootPath) + $Arguments) { $info.ArgumentList.Add($argument) }
    $info.UseShellExecute = $false
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.UTF8Encoding]::new($false, $true)
    $info.CreateNoWindow = $true
    $info.Environment['GIT_OPTIONAL_LOCKS'] = '0'
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    try {
        if (-not $process.Start()) { throw 'Git failed to start' }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(15000)) { $process.Kill($true); throw 'Read-only Git command timed out' }
        if ($stdoutTask.Result.Length -gt 32MB) { throw 'Git metadata exceeds 32 MiB bound' }
        return @{ ExitCode = $process.ExitCode; Output = $stdoutTask.Result; Error = $stderrTask.Result }
    } finally { $process.Dispose() }
}
function Read-PublicInputManifest([string]$Text, [string]$RootPath) {
    $doc = [System.Text.Json.JsonDocument]::Parse($Text)
    try {
        if ($doc.RootElement.ValueKind -ne [System.Text.Json.JsonValueKind]::Object) { throw 'Input manifest must be an object' }
        $properties = [Collections.Generic.Dictionary[string, System.Text.Json.JsonElement]]::new([StringComparer]::Ordinal)
        foreach ($property in $doc.RootElement.EnumerateObject()) {
            if ($properties.ContainsKey($property.Name)) { throw 'Input manifest duplicate JSON key' }
            if ($property.Name -cnotin @('version', 'gowork', 'workflow', 'required', 'workflowScripts')) { throw 'Input manifest unknown or aliased field' }
            $properties.Add($property.Name, $property.Value)
        }
        foreach ($name in @('version', 'gowork', 'workflow', 'required', 'workflowScripts')) { if (-not $properties.ContainsKey($name)) { throw 'Input manifest required field missing' } }
        if ($properties['version'].ValueKind -ne [System.Text.Json.JsonValueKind]::Number -or $properties['version'].GetInt32() -ne 1) { throw 'Input manifest version must be 1' }
        if ($properties['gowork'].ValueKind -ne [System.Text.Json.JsonValueKind]::String -or $properties['gowork'].GetString() -cne 'off') { throw 'Input manifest GOWORK must be off' }
        if ($properties['workflow'].ValueKind -ne [System.Text.Json.JsonValueKind]::String) { throw 'Input manifest workflow must be a string' }
        $workflow = (Resolve-PublicInputPath $RootPath $properties['workflow'].GetString()).Path
        $lists = @{}
        foreach ($name in @('required', 'workflowScripts')) {
            if ($properties[$name].ValueKind -ne [System.Text.Json.JsonValueKind]::Array) { throw 'Input manifest paths must be arrays' }
            $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
            $values = [Collections.Generic.List[string]]::new()
            foreach ($value in $properties[$name].EnumerateArray()) {
                if ($value.ValueKind -ne [System.Text.Json.JsonValueKind]::String) { throw 'Input manifest path must be a string' }
                $safe = Resolve-PublicInputPath $RootPath $value.GetString()
                if (-not $seen.Add($safe.Path)) { throw 'Input manifest duplicate canonical path' }
                $values.Add($safe.Path)
            }
            if (-not $values.Count) { throw 'Input manifest path array must be nonempty' }
            $lists[$name] = $values.ToArray()
        }
        return @{ version = 1; gowork = 'off'; workflow = $workflow; required = $lists.required; workflowScripts = $lists.workflowScripts }
    } finally { $doc.Dispose() }
}
function Split-PublicRunTokens([string]$Command) {
    if ($Command -match '\$(?:[A-Za-z_{(]|[0-9?!@])|`|%[^%]+%|\\$') { throw 'Workflow unsupported dynamic command or continuation' }
    $tokens = [Collections.Generic.List[string]]::new()
    $i = 0
    while ($i -lt $Command.Length) {
        if ([char]::IsWhiteSpace($Command[$i])) { $i++; continue }
        if ($Command[$i] -eq '#') { break }
        if ($Command[$i] -eq '&' -and $tokens.Count -eq 0 -and ($i + 1 -lt $Command.Length) -and [char]::IsWhiteSpace($Command[$i + 1])) { $tokens.Add('&'); $i++; continue }
        $value = [Text.StringBuilder]::new()
        $quote = [char]0
        while ($i -lt $Command.Length) {
            $c = $Command[$i]
            if ($quote -ne [char]0) {
                if ($c -eq $quote) { $quote = [char]0 } else { [void]$value.Append($c) }
            } elseif ($c -eq '"' -or $c -eq "'") { $quote = $c
            } elseif ([char]::IsWhiteSpace($c)) { break
            } elseif (';&|<>'.Contains($c)) { throw 'Workflow unsupported shell operator'
            } else { [void]$value.Append($c) }
            $i++
        }
        if ($quote -ne [char]0) { throw 'Workflow unmatched command quote' }
        $tokens.Add($value.ToString())
    }
    $tokens.ToArray()
}
function Get-PublicInterpreterInputs {
    param([string[]]$Tokens, [int]$Depth = 0)
    if (-not $Tokens.Count) { return }
    if ($Depth -gt 4) { throw 'Workflow interpreter nesting exceeds supported grammar' }
    $start = if ($Tokens[0] -eq '&') { 1 } else { 0 }
    if ($start -ge $Tokens.Count) { throw 'Workflow call operator lacks a literal command' }
    $command = $Tokens[$start]
    $interpreters = @('bash', 'sh', 'pwsh', 'powershell', 'python', 'python3', 'node', 'source', '.')
    if ($command -notin $interpreters) {
        if (@($Tokens | Select-Object -Skip ($start + 1) | Where-Object { $_ -in $interpreters }).Count) { throw 'Workflow unsupported interpreter composition' }
        if ($command -match '[/\\]|\.(?:ps1|sh|py|js|mjs|cjs)$') { $command }
        return
    }
    $position = $start + 1
    while ($position -lt $Tokens.Count -and $Tokens[$position].StartsWith('-')) {
        $option = $Tokens[$position].ToLowerInvariant()
        if ($option -eq '--') { $position++; break }
        if ($command -in @('bash', 'sh') -and $option -in @('-lc', '-c')) {
            if ($position + 1 -ne $Tokens.Count - 1 -or $Tokens[$position + 1] -notmatch '^cd [A-Za-z0-9_-]+ && go (?:test|vet|build) [A-Za-z0-9 ./^"''=$-]+$' -or $Tokens[$position + 1] -match '(?i)scripts[/\\]|\.(ps1|sh|py)|\$(?:[A-Za-z_{(]|[0-9?!@])') { throw 'Workflow unsupported nested interpreter body' }
            return
        }
        if ($command -in @('python', 'python3') -and $option -eq '-m') {
            if ($position + 1 -ge $Tokens.Count -or $Tokens[$position + 1] -cnotin @('pip', 'pytest')) { throw 'Workflow unsupported Python module entrypoint' }
            # Existing CI tooling modules are recognized explicitly, not treated as
            # repository script files or proof of their runtime/module closure.
            if ($Tokens[$position + 1] -ceq 'pip') {
                if ($position + 2 -ge $Tokens.Count -or $Tokens[$position + 2] -cne 'install' -or @($Tokens | Select-Object -Skip ($position + 3) | Where-Object { $_ -match '^-([rc])|^--(requirement|constraint)(=|$)|^\.{1,2}[/\\]|^file:' }).Count) { throw 'Workflow unsupported pip input or subcommand' }
            }
            return
        }
        if ($command -in @('pwsh', 'powershell') -and $option -eq '-file') { $position++; break }
        $supported = ($command -in @('pwsh', 'powershell') -and $option -in @('-noprofile', '-noninteractive')) -or
            ($command -in @('python', 'python3') -and $option -in @('-b', '-u')) -or
            ($command -in @('bash', 'sh') -and $option -in @('-l', '--noprofile', '--norc'))
        if (-not $supported) { throw 'Workflow unsupported interpreter option or inline evaluation' }
        $position++
    }
    if ($position -ge $Tokens.Count -or -not $Tokens[$position] -or $Tokens[$position].StartsWith('-')) { throw 'Workflow interpreter requires a literal source input' }
    $Tokens[$position]
    if ($position + 1 -lt $Tokens.Count) {
        $tail = @($Tokens[($position + 1)..($Tokens.Count - 1)])
        if ($command -in @('bash', 'sh') -and $tail[0] -in @('bash', 'sh')) { Get-PublicInterpreterInputs -Tokens $tail -Depth ($Depth + 1) }
        elseif (@($tail | Where-Object { $_ -in $interpreters }).Count) { throw 'Workflow unsupported interpreter composition' }
    }
}
function Test-PublicRunRootScope([string[]]$Lines, [int]$Row, [int]$Indent) {
    $stepIndent = if ($Lines[$Row] -match '^ *- +run:') { $Indent } else { $Indent - 2 }
    $start = $Row
    while ($start -ge 0 -and $Lines[$start] -notmatch ('^ {' + $stepIndent + '}- +')) { $start-- }
    if ($start -lt 0) { throw 'Workflow run must belong to a literal step' }
    $directories = [Collections.Generic.List[string]]::new()
    for ($line = $start + 1; $line -lt $Lines.Count; $line++) {
        if ($Lines[$line] -match '^\s*(?:#.*)?$') { continue }
        if ([regex]::Match($Lines[$line], '^ *').Length -le $stepIndent) { break }
        $match = [regex]::Match($Lines[$line], '^ {' + ($stepIndent + 2) + '}working-directory:\s*(.+)$')
        if ($match.Success) { $directories.Add($match.Groups[1].Value.Trim()) }
    }
    if ($directories.Count -gt 1) { throw 'Workflow duplicate working-directory is unsupported' }
    return $directories.Count -eq 0 -or $directories[0] -in @('.', './', "'.'", "'./'", '"."', '"./"')
}
function Get-PublicWorkflowReferences([string]$Text) {
    $lines = $Text -split '\r?\n'
    if ($Text.Contains("`t")) { throw 'Workflow tabs unsupported' }
    $topEnv = @($lines | Where-Object { $_ -match '^env:\s*(?:#.*)?$' })
    if ($topEnv.Count -ne 1) { throw 'Workflow must declare exactly one top-level env mapping' }
    $insideEnv = $false; $envIndent = 0; $offCount = 0
    foreach ($line in $lines) {
        if ($line -match '^\s*(?:#.*)?$') { continue }
        if ($line -match '^env:\s*(?:#.*)?$') { $insideEnv = $true; continue }
        if ($insideEnv) {
            if ($line -notmatch '^ +') { $insideEnv = $false }
            else {
                $indent = [regex]::Match($line, '^ +').Length
                if (-not $envIndent) { $envIndent = $indent }
                if ($line -match "^ +GOWORK:\s*(?:off|'off'|`"off`")\s*(?:#.*)?$") {
                    if ($indent -ne $envIndent) { throw 'Workflow GOWORK must belong directly to top-level env' }
                    $offCount++
                }
            }
        }
        if ($line -match '\bGOWORK\b' -and $line -notmatch "^ +GOWORK:\s*(?:off|'off'|`"off`")\s*(?:#.*)?$") { throw 'Workflow unsupported GOWORK override' }
    }
    if ($offCount -ne 1) { throw 'Workflow top-level GOWORK must be off exactly once' }
    $runs = [Collections.Generic.List[object]]::new()
    for ($i = 0; $i -lt $lines.Length; $i++) {
        $line = $lines[$i]
        if ($line -match '^\s*(?:#.*)?$') { continue }
        if ($line -match '^\s*(?:-\s+)?[?:]\s+|^\s*(?:---|\.\.\.)\s*(?:#.*)?$|^\s*(?:-\s+)?["''][^"'']*["'']\s*:') { throw 'Workflow unsupported complex, quoted or multi-document key syntax' }
        if ($line -match '^\s*(?:-\s+)?uses:\s*[''"'']?\./') { throw 'Workflow local actions require unsupported dependency parsing' }
        $match = [regex]::Match($line, '^( *)(?:- +)?run:\s*(.*)$')
        if (-not $match.Success) {
            if ($line -match '\brun[''"]?\s*:|^\s*<<:|:\s*[&*][A-Za-z]') { throw 'Workflow unsupported inline, merged or anchored syntax' }
            continue
        }
        $indent = $match.Groups[1].Length
        $value = $match.Groups[2].Value.Trim()
        $rootScope = Test-PublicRunRootScope $lines $i $indent
        if ($value -match '^\|[+-]?(?:\s+#.*)?$') {
            $before = $runs.Count
            while ($i + 1 -lt $lines.Length -and ($lines[$i + 1] -match '^\s*$' -or [regex]::Match($lines[$i + 1], '^ *').Length -gt $indent)) {
                $i++; $runs.Add(@{ command = $lines[$i].Trim(); rootScope = $rootScope })
            }
            if ($before -eq $runs.Count) { throw 'Workflow empty run block' }
        } elseif ($value -match '^[|>&*!{\[]' -and -not $value.StartsWith('& ')) { throw 'Workflow unsupported run scalar' }
        elseif (-not $value) { throw 'Workflow empty run scalar' }
        else {
            if ($value.StartsWith("'")) {
                if ($value.Length -lt 2 -or -not $value.EndsWith("'")) { throw 'Workflow unmatched YAML scalar quote' }
                $value = $value.Substring(1, $value.Length - 2).Replace("''", "'")
            } elseif ($value.StartsWith('"')) {
                try { $value = $value | ConvertFrom-Json -ErrorAction Stop } catch { throw 'Workflow unsupported YAML string escape' }
                if ($value -isnot [string]) { throw 'Workflow run scalar must be a string' }
            }
            $runs.Add(@{ command = $value; rootScope = $rootScope })
        }
    }
    if (-not $runs.Count) { throw 'Workflow no run commands parsed' }
    $refs = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($record in $runs) {
        $run = $record.command
        $beforeRefs = $refs.Count
        if (-not $run -or $run.StartsWith('#')) { continue }
        $tokens = @(Split-PublicRunTokens $run)
        foreach ($interpreterInput in @(Get-PublicInterpreterInputs -Tokens $tokens)) {
            $ref = $interpreterInput.Replace('\', '/')
            if ($ref.StartsWith('./')) { $ref = $ref.Substring(2) }
            [void]$refs.Add($ref)
        }
        for ($i = 0; $i -lt $tokens.Count; $i++) {
            if ($tokens[$i] -in @('-lc', '-c', '-Command', '-EncodedCommand')) {
                if ($tokens[$i] -notin @('-lc', '-c') -or $i + 1 -ge $tokens.Count) { throw 'Workflow unsupported nested interpreter command' }
                $body = $tokens[$i + 1]
                if ($body -notmatch '^cd [A-Za-z0-9_-]+ && go (?:test|vet|build) [A-Za-z0-9 ./^"''=$-]+$' -or $body -match '(?i)scripts[/\\]|\.(ps1|sh|py)|\$(?:[A-Za-z_{(]|[0-9?!@])') { throw 'Workflow unsupported nested interpreter body' }
                $i++
                continue
            }
            $token = $tokens[$i]
            $localInterpreterInput = $i -gt 0 -and $token -match '^\.[/\\]' -and ($tokens[0] -in @('bash', 'sh', 'pwsh', 'powershell', 'python', 'python3', 'node', 'source', '.') -or $tokens[$i - 1] -in @('bash', 'sh', 'pwsh', 'powershell', 'python', 'python3', 'node', 'source', '.'))
            if ($localInterpreterInput -or $token -match '(?i)(?:^|/)scripts[/\\]|\.(?:ps1|sh|py)$') {
                if ($token -match '^[-/]|:|[\x00-\x1f]|[*?]' -or $token -match '^--?[^ ]+=') { throw 'Workflow unsupported script reference' }
                $ref = $token.Replace('\', '/')
                if ($ref.StartsWith('./')) { $ref = $ref.Substring(2) }
                [void]$refs.Add($ref)
            }
        }
        if (-not $record.rootScope -and ($refs.Count -gt $beforeRefs -or @(Get-PublicInterpreterInputs -Tokens $tokens).Count)) { throw 'Workflow script input under a non-root working-directory is unsupported' }
    }
    if (-not $refs.Count) { throw 'Workflow no explicit script references; refusing vacuous success' }
    $refs | Sort-Object
}
function Test-PublicCheckout {
    param([string]$RootPath, [string]$InputPath, [scriptblock]$GitAdapter)
    # In-process synthetic-test seam only; production CLI always queries real Git.
    $issues = [Collections.Generic.List[object]]::new()
    $dependencies = [Collections.Generic.List[object]]::new()
    $refs = @(); $head = $null; $configHash = $null; $workflowHash = $null
    try {
        $rootFull = Get-PublicRootPath $RootPath
        if (-not (Test-Path -LiteralPath $rootFull -PathType Container)) { throw 'Root directory does not exist' }
        $gitCall = { param([string[]]$Arguments) Invoke-PublicCheckoutGit $rootFull $Arguments }
        if ($null -ne $GitAdapter) { $gitCall = $GitAdapter }
        $top = & $gitCall -Arguments @('rev-parse', '--show-toplevel')
        if ($top.ExitCode -ne 0) { throw 'Git root failed' }
        $comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
        if (-not [string]::Equals((Get-PublicRootPath $top.Output.Trim()), $rootFull, $comparison)) { throw 'Root must be the Git checkout top-level' }
        $revision = & $gitCall -Arguments @('rev-parse', '--verify', 'HEAD')
        if ($revision.ExitCode -ne 0 -or $revision.Output.Trim() -notmatch '^(?:[0-9a-f]{40}|[0-9a-f]{64})$') { throw 'Git HEAD proof failed' }
        $head = $revision.Output.Trim()
        $index = & $gitCall -Arguments @('ls-files', '--stage', '-z')
        if ($index.ExitCode -ne 0) { throw 'Git index failed' }
        $tracked = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        $indexPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($entry in ($index.Output -split "`0")) {
            if (-not $entry) { continue }
            $record = [regex]::Match($entry, '^(?<mode>100644|100755|120000|160000) [0-9a-f]{40,64} (?<stage>[0-3])\t(?<path>[\s\S]+)$')
            if (-not $record.Success) { throw 'Invalid Git index record' }
            if ($record.Groups['stage'].Value -ne '0') { throw 'Unmerged Git index refused' }
            $path = $record.Groups['path'].Value
            if (-not $indexPaths.Add($path)) { throw 'Duplicate Git index record' }
            if ($record.Groups['mode'].Value -in @('100644', '100755')) { [void]$tracked.Add($path) }
        }
        if ($env:GOWORK -and $env:GOWORK -cne 'off') { throw 'Ambient GOWORK must be off or unset' }
        $configPath = Resolve-PublicInputPath $rootFull $InputPath
        if (-not (Test-Path -LiteralPath $configPath.Full -PathType Leaf)) {
            $issues.Add(@{ code = 'missing'; path = $configPath.Path })
            if (-not $tracked.Contains($configPath.Path)) { $issues.Add(@{ code = 'untracked'; path = $configPath.Path }) }
            throw 'Input manifest missing; dependency closure cannot be evaluated'
        }
        $configHash = (Get-FileHash -LiteralPath $configPath.Full -Algorithm SHA256).Hash.ToLowerInvariant()
        $config = Read-PublicInputManifest (Read-PublicText $configPath.Full) $rootFull
        $workflow = Resolve-PublicInputPath $rootFull $config.workflow
        if (-not (Test-Path -LiteralPath $workflow.Full -PathType Leaf)) { $issues.Add(@{ code = 'missing'; path = $workflow.Path }); throw 'Workflow missing' }
        $workflowHash = (Get-FileHash -LiteralPath $workflow.Full -Algorithm SHA256).Hash.ToLowerInvariant()
        $refs = @(Get-PublicWorkflowReferences (Read-PublicText $workflow.Full))
        foreach ($expected in $config.workflowScripts) {
            if ($refs -cnotcontains $expected) { $issues.Add(@{ code = 'workflow_reference_missing'; path = $expected }) }
        }
        $all = @($configPath.Path, $workflow.Path) + @($config.required) + $refs
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($relative in $all) {
            $safe = Resolve-PublicInputPath $rootFull $relative
            if (-not $seen.Add($safe.Path)) { continue }
            $exists = Test-Path -LiteralPath $safe.Full -PathType Leaf
            $inIndex = $tracked.Contains($safe.Path)
            $dependencies.Add(@{ path = $safe.Path; exists = $exists; tracked = $inIndex })
            if (-not $exists) { $issues.Add(@{ code = 'missing'; path = $safe.Path }) }
            if (-not $inIndex) { $issues.Add(@{ code = 'untracked'; path = $safe.Path }) }
        }
    } catch { $issues.Add(@{ code = 'preflight_error'; message = $_.Exception.Message }) }
    return [pscustomobject]@{
        version = 1; success = ($issues.Count -eq 0); root = $RootPath; head = $head
        configSource = $InputPath; configSha256 = $configHash; workflowSha256 = $workflowHash
        goworkPolicy = 'off'; workflowReferences = @($refs); dependencies = @($dependencies.ToArray()); issues = @($issues.ToArray())
    }
}
if (-not $LibraryOnly) {
    $result = Test-PublicCheckout -RootPath $Root -InputPath $Inputs
    if ($Format -eq 'Json') { $result | ConvertTo-Json -Depth 8 }
    else {
        Write-Output "Public checkout success=$($result.success) HEAD=$($result.head) config=$($result.configSource)"
        foreach ($issue in $result.issues) { Write-Output ($issue | ConvertTo-Json -Compress) }
        Write-Output "Dependencies=$($result.dependencies.Count); workflow references=$($result.workflowReferences.Count); GOWORK policy=off"
    }
    if (-not $result.success) { exit 1 }
    exit 0
}
