param(
    [Parameter(Position = 0)]
    [string]$Path = ".env.social"
)

$resolvedPath = Resolve-Path -LiteralPath $Path -ErrorAction Stop
$loaded = 0

foreach ($rawLine in Get-Content -LiteralPath $resolvedPath) {
    $line = $rawLine.Trim()

    if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith("#")) {
        continue
    }

    if ($line.StartsWith("export ")) {
        $line = $line.Substring(7).Trim()
    }

    $separator = $line.IndexOf("=")
    if ($separator -lt 1) {
        continue
    }

    $name = $line.Substring(0, $separator).Trim()
    $value = $line.Substring($separator + 1)

    if (
        ($value.Length -ge 2) -and
        (
            ($value.StartsWith('"') -and $value.EndsWith('"')) -or
            ($value.StartsWith("'") -and $value.EndsWith("'"))
        )
    ) {
        $value = $value.Substring(1, $value.Length - 2)
    }

    Set-Item -Path "Env:$name" -Value $value
    $loaded += 1
}

Write-Host "Loaded $loaded environment variables from $resolvedPath"
