[CmdletBinding()]
param(
    [string]$GoCommand = 'go'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$temporaryBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$temporary = Join-Path $temporaryBase ('nexus-contracts-' + [Guid]::NewGuid().ToString('N'))
$previousWork = $env:GOWORK

function Invoke-Go([string[]]$Arguments) {
    & $GoCommand @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Contract command failed ($LASTEXITCODE): go $($Arguments -join ' ')"
    }
}

function Assert-EqualText([string]$Expected, [string]$Actual) {
    # Compare canonical text independently of checkout line-ending settings.
    $expectedText = [IO.File]::ReadAllText($Expected).Replace("`r`n", "`n")
    $actualText = [IO.File]::ReadAllText($Actual).Replace("`r`n", "`n")
    if ($expectedText -cne $actualText) {
        throw "Generated contract drift: $Expected. Regenerate from the .swyp source and review the change."
    }
}

# This is the workspace's protocol inventory. The .swyp files own semantics;
# their manifests and Go DTOs must always be generated from the same source.
$contracts = @(
    @{ Product = 'ilaria'; Name = 'myriad'; Package = 'myriad'; Outputs = @('ilaria/generated/myriad/types_gen.go') },
    @{ Product = 'swypik-os'; Name = 'compute-fabric'; Package = 'computefabric'; Outputs = @('swypik-os/generated/computefabric/types_gen.go') },
    @{ Product = 'swypik-os'; Name = 'control-kernel'; Package = 'controlkernel'; Outputs = @('swypik-os/generated/controlkernel/types_gen.go') },
    @{ Product = 'swyp'; Name = 'effects'; Package = 'effects'; Outputs = @(
        'swyp/protocol/effects/types_gen.go',
        'swypik-os/generated/swypeffects/types_gen.go',
        'ilaria/generated/swypeffects/types_gen.go'
    ) }
)

New-Item -ItemType Directory -Path $temporary | Out-Null
Push-Location -LiteralPath (Join-Path $root 'swyp')
try {
    $env:GOWORK = 'off'
    $compiler = Join-Path $temporary 'swyp'
    if ([IO.Path]::DirectorySeparatorChar -eq '\') { $compiler += '.exe' }
    Invoke-Go @('build', '-buildvcs=false', '-trimpath', '-o', $compiler, './cmd/swyp')
    foreach ($contract in $contracts) {
        $productRoot = Join-Path $root $contract.Product
        $source = Join-Path $productRoot "specs/$($contract.Name).swyp"
        $manifest = Join-Path $temporary "$($contract.Name).manifest.json"
        $types = Join-Path $temporary "$($contract.Package)_types_gen.go"
        & $compiler component check $source
        if ($LASTEXITCODE -ne 0) { throw "Invalid contract: $source" }
        & $compiler component compile -o $manifest $source
        if ($LASTEXITCODE -ne 0) { throw "Manifest generation failed: $source" }
        & $compiler component go -package $contract.Package -o $types $source
        if ($LASTEXITCODE -ne 0) { throw "Go DTO generation failed: $source" }
        Assert-EqualText (Join-Path $productRoot "specs/$($contract.Name).manifest.json") $manifest
        foreach ($output in $contract.Outputs) {
            Assert-EqualText (Join-Path $root $output) $types
        }
        Write-Host "PASS contract: $($contract.Product)/$($contract.Name)"
    }
    foreach ($helper in @('protocol.go', 'plan.go')) {
        $canonical = Join-Path $root "swyp/protocol/effects/$helper"
        foreach ($product in @('ilaria', 'swypik-os')) {
            Assert-EqualText $canonical (Join-Path $root "$product/generated/swypeffects/$helper")
        }
    }
    Write-Host 'PASS effects wire helpers: canonical Swyp rules mirrored without drift'
    Assert-EqualText (Join-Path $root 'swyp/protocol/continuation/protocol.go') (Join-Path $root 'swypik-os/generated/swypcontinuation/protocol.go')
    Assert-EqualText (Join-Path $root 'swyp/specs/continuation-v1.schema.json') (Join-Path $root 'swypik-os/generated/swypcontinuation/continuation-v1.schema.json')
    Write-Host 'PASS continuation wire helpers: canonical Swyp v1 rules/schema mirrored without drift'
} finally {
    $env:GOWORK = $previousWork
    Pop-Location
    $resolvedTemporary = [IO.Path]::GetFullPath($temporary)
    if (([IO.Path]::GetDirectoryName($resolvedTemporary) -eq $temporaryBase.TrimEnd('\', '/')) -and
        ([IO.Path]::GetFileName($resolvedTemporary) -match '^nexus-contracts-[0-9a-f]{32}$')) {
        Remove-Item -LiteralPath $resolvedTemporary -Recurse -Force
    } else {
        throw "Refusing to remove unexpected temporary path: $resolvedTemporary"
    }
}
