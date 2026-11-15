$ErrorActionPreference = "Stop"
. "$PSScriptRoot/windows-zip-checksum.ps1"

function Assert-True {
  param(
    [bool]$Condition,
    [string]$Message
  )

  if (-not $Condition) {
    throw $Message
  }
}

$testDirectory = Join-Path ([IO.Path]::GetTempPath()) "windows-zip-checksum-test-$([guid]::NewGuid().ToString('N'))"
$sourceDirectory = Join-Path $testDirectory "source"
$zipPath = Join-Path $testDirectory "Tischtennis-Turnier-test-x64-unsigned.zip"
$checksumPath = "$zipPath.sha256"

try {
  New-Item -ItemType Directory -Path $sourceDirectory -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $sourceDirectory "readme.txt") -Value "Windows ZIP checksum test"
  Compress-Archive -Path (Join-Path $sourceDirectory "*") -DestinationPath $zipPath

  $hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText($checksumPath, "$hash  $(Split-Path -Leaf $zipPath)`n")
  Test-WindowsZipChecksum -ZipPath $zipPath

  Remove-Item -LiteralPath $checksumPath
  $missingChecksumError = $null
  try {
    Test-WindowsZipChecksum -ZipPath $zipPath
  } catch {
    $missingChecksumError = $_.Exception.Message
  }
  Assert-True `
    ($missingChecksumError -eq "The downloaded Windows ZIP checksum is missing.") `
    "A missing Windows ZIP checksum was not rejected with the expected error."

  $invalidChecksums = @(
    @{ Contents = "not-a-checksum`n"; Message = "The downloaded Windows ZIP checksum has an invalid format." },
    @{ Contents = "$hash $(Split-Path -Leaf $zipPath)`n"; Message = "The downloaded Windows ZIP checksum has an invalid format." },
    @{ Contents = "$hash  another-windows-build.zip`n"; Message = "The downloaded Windows ZIP checksum names a different file." },
    @{ Contents = "$hash  $(Split-Path -Leaf $zipPath)`nextra-line`n"; Message = "The downloaded Windows ZIP checksum has an invalid format." }
  )
  foreach ($invalidChecksum in $invalidChecksums) {
    [IO.File]::WriteAllText($checksumPath, $invalidChecksum.Contents)
    $checksumError = $null
    try {
      Test-WindowsZipChecksum -ZipPath $zipPath
    } catch {
      $checksumError = $_.Exception.Message
    }
    Assert-True `
      ($checksumError -eq $invalidChecksum.Message) `
      "An invalid Windows ZIP checksum was not rejected with the expected error."
  }

  [IO.File]::WriteAllText($checksumPath, "$hash  $(Split-Path -Leaf $zipPath)`n")
  [IO.File]::AppendAllText($zipPath, "modified")
  $mismatchError = $null
  try {
    Test-WindowsZipChecksum -ZipPath $zipPath
  } catch {
    $mismatchError = $_.Exception.Message
  }

  Assert-True `
    ($mismatchError -eq "The downloaded Windows ZIP does not match its SHA-256 checksum.") `
    "A modified ZIP was not rejected with the expected checksum mismatch error."
  Write-Host "Passed Windows ZIP checksum format, filename, and modified-file checks."
} finally {
  Remove-Item -LiteralPath $testDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
