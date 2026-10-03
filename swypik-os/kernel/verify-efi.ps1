param(
    [Parameter(Mandatory = $true)]
    [string]$Path
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Resolved = (Resolve-Path -LiteralPath $Path).Path
$Bytes = [IO.File]::ReadAllBytes($Resolved)

function Require([bool]$Condition, [string]$Message) {
    if (-not $Condition) {
        throw "EFI verification failed: $Message"
    }
}

function U16([int]$Offset) {
    Require ($Offset -ge 0 -and $Offset + 2 -le $Bytes.Length) ("u16 out of range at 0x{0:x}" -f $Offset)
    return [BitConverter]::ToUInt16($Bytes, $Offset)
}

function U32([int]$Offset) {
    Require ($Offset -ge 0 -and $Offset + 4 -le $Bytes.Length) ("u32 out of range at 0x{0:x}" -f $Offset)
    return [BitConverter]::ToUInt32($Bytes, $Offset)
}

function U64([int]$Offset) {
    Require ($Offset -ge 0 -and $Offset + 8 -le $Bytes.Length) ("u64 out of range at 0x{0:x}" -f $Offset)
    return [BitConverter]::ToUInt64($Bytes, $Offset)
}

Require ($Bytes.Length -ge 512) "image is too small"
Require ((U16 0) -eq 0x5a4d) "DOS MZ magic missing"

$Pe = [int](U32 0x3c)
Require ($Pe -ge 0x40 -and $Pe + 24 -le $Bytes.Length) "PE header offset is invalid"
Require ((U32 $Pe) -eq 0x00004550) "PE signature missing"

$Machine = U16 ($Pe + 4)
$SectionCount = U16 ($Pe + 6)
$Timestamp = U32 ($Pe + 8)
$OptionalSize = U16 ($Pe + 20)
$Optional = $Pe + 24

Require ($Machine -eq 0x8664) ("machine 0x{0:x4} is not AMD64" -f $Machine)
Require ($SectionCount -gt 0 -and $SectionCount -le 96) "section count is invalid"
Require ($OptionalSize -ge 0xf0) "PE32+ optional header is truncated"
Require ($Optional + $OptionalSize -le $Bytes.Length) "optional header exceeds file"
Require ((U16 $Optional) -eq 0x020b) "optional header is not PE32+"

$EntryRva = U32 ($Optional + 16)
$ImageBase = U64 ($Optional + 24)
$SectionAlignment = U32 ($Optional + 32)
$FileAlignment = U32 ($Optional + 36)
$SizeOfImage = U32 ($Optional + 56)
$SizeOfHeaders = U32 ($Optional + 60)
$Subsystem = U16 ($Optional + 68)
$DllCharacteristics = U16 ($Optional + 70)
$DirectoryCount = U32 ($Optional + 108)

Require ($EntryRva -ne 0) "entrypoint RVA is zero"
Require (($ImageBase -band [uint64]0xffff) -eq 0) "preferred image base is not 64 KiB aligned"
Require ($SectionAlignment -ge 4096 -and (($SectionAlignment -band ($SectionAlignment - 1)) -eq 0)) "section alignment is invalid"
Require ($FileAlignment -ge 512 -and $FileAlignment -le 65536 -and (($FileAlignment -band ($FileAlignment - 1)) -eq 0)) "file alignment is invalid"
Require ($SizeOfImage -gt 0 -and $SizeOfHeaders -gt 0 -and $SizeOfHeaders -le $SizeOfImage) "image/header sizes are invalid"
Require ($Subsystem -eq 10) ("subsystem $Subsystem is not EFI Application (10)")
Require (($DllCharacteristics -band 0x0100) -ne 0) "NX_COMPAT is not set"
Require (($DllCharacteristics -band 0x0040) -ne 0) "DYNAMIC_BASE is not set"
Require ($DirectoryCount -ge 6) "PE data directories are incomplete"

$ImportRva = U32 ($Optional + 120)
$ImportSize = U32 ($Optional + 124)
$RelocRva = U32 ($Optional + 152)
$RelocSize = U32 ($Optional + 156)

Require ($ImportRva -eq 0 -and $ImportSize -eq 0) "EFI image unexpectedly has an import table"
Require ($RelocRva -ne 0 -and $RelocSize -ne 0) "EFI image has no base relocations"

$SectionTable = $Optional + $OptionalSize
Require ($SectionTable + 40 * $SectionCount -le $Bytes.Length) "section table exceeds file"

$EntryInExecutable = $false
$RelocSectionPresent = $false
$Sections = @()

for ($Index = 0; $Index -lt $SectionCount; $Index++) {
    $Offset = $SectionTable + 40 * $Index
    $Name = [Text.Encoding]::ASCII.GetString($Bytes, $Offset, 8).TrimEnd([char]0)
    $VirtualSize = U32 ($Offset + 8)
    $VirtualAddress = U32 ($Offset + 12)
    $RawSize = U32 ($Offset + 16)
    $RawPointer = U32 ($Offset + 20)
    $Characteristics = U32 ($Offset + 36)
    $Writable = (([uint64]$Characteristics -band [uint64]2147483648) -ne 0)
    $Executable = (([uint64]$Characteristics -band [uint64]536870912) -ne 0)

    Require (-not ($Writable -and $Executable)) ("section '$Name' is writable and executable")
    if ($RawSize -ne 0) {
        Require ($RawPointer -le $Bytes.Length -and $RawSize -le $Bytes.Length - $RawPointer) ("section '$Name' raw data exceeds file")
    }

    $MappedSize = [Math]::Max([uint64]$VirtualSize, [uint64]$RawSize)
    Require ([uint64]$VirtualAddress + $MappedSize -le [uint64]$SizeOfImage) ("section '$Name' exceeds SizeOfImage")

    if ($Executable -and [uint64]$EntryRva -ge [uint64]$VirtualAddress -and
        [uint64]$EntryRva -lt [uint64]$VirtualAddress + $MappedSize) {
        $EntryInExecutable = $true
    }
    if ($Name -eq ".reloc") {
        $RelocSectionPresent = $true
    }

    $Sections += [PSCustomObject]@{
        Name = $Name
        RVA = ("0x{0:x}" -f $VirtualAddress)
        VirtualSize = ("0x{0:x}" -f $VirtualSize)
        RawSize = ("0x{0:x}" -f $RawSize)
        Characteristics = ("0x{0:x8}" -f $Characteristics)
        Writable = $Writable
        Executable = $Executable
    }
}

Require $EntryInExecutable "entrypoint is not inside an executable section"
Require $RelocSectionPresent ".reloc section is missing"

$Hash = (Get-FileHash -Algorithm SHA256 $Resolved).Hash.ToLowerInvariant()

Write-Output ("EFI_VERIFY=PASS")
Write-Output ("FILE={0}" -f $Resolved)
Write-Output ("SHA256={0}" -f $Hash)
Write-Output ("MACHINE=0x{0:x4}" -f $Machine)
Write-Output ("PE_MAGIC=0x020b")
Write-Output ("SUBSYSTEM={0}" -f $Subsystem)
Write-Output ("ENTRY_RVA=0x{0:x}" -f $EntryRva)
Write-Output ("COFF_TIMESTAMP_OR_REPRO_HASH=0x{0:x8}" -f $Timestamp)
Write-Output ("IMPORT_DIRECTORY=0")
Write-Output ("RELOC_DIRECTORY=0x{0:x}/0x{1:x}" -f $RelocRva, $RelocSize)
$Sections | Format-Table -AutoSize
