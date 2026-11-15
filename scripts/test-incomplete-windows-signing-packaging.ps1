$ErrorActionPreference = "Stop"

function Assert-True {
  param(
    [bool]$Condition,
    [string]$Message
  )

  if (-not $Condition) {
    throw $Message
  }
}

$packageScript = Join-Path $PSScriptRoot "package-windows-builds.ps1"
$testDirectory = Join-Path ([IO.Path]::GetTempPath()) "tt-turnier-incomplete-signing-test-$([guid]::NewGuid())"
$previousLocation = Get-Location

try {
  New-Item -ItemType Directory -Path $testDirectory | Out-Null
  Set-Location -LiteralPath $testDirectory

  $env:WINDOWS_CERTIFICATE_BASE64 = "test-certificate-without-a-password"
  $env:WINDOWS_CERTIFICATE_PASSWORD = ""
  $global:PackagingCommandInvoked = $false
  function pnpm {
    $global:PackagingCommandInvoked = $true
    throw "The packaging command must not run when signing secrets are incomplete."
  }

  $packageOutput = @()
  $packageInvocationError = $null
  try {
    $packageOutput = @(& $packageScript *>&1)
  } catch {
    $packageInvocationError = $_
  }

  $packageOutputText = ($packageOutput | ForEach-Object { "$_" }) -join "`n"
  if ($packageInvocationError) {
    $packageOutputText += "`n$packageInvocationError"
  }

  Assert-True ($null -ne $packageInvocationError) "Packaging unexpectedly succeeded with only one signing secret."
  Assert-True (
    $packageOutputText -match "Set both WINDOWS_CERTIFICATE_BASE64 and WINDOWS_CERTIFICATE_PASSWORD"
  ) "Packaging did not fail with the expected incomplete-signing-secrets error."
  Assert-True (
    $packageOutputText -notmatch "(?i)unsigned"
  ) "Packaging labeled a build unsigned after rejecting incomplete signing secrets."
  Assert-True (-not $global:PackagingCommandInvoked) "The installer or ZIP packaging command ran before the preflight failure."

  $outputDirectory = Join-Path $testDirectory "generated-artifacts/tt-turnier-windows"
  $createdBuilds = @()
  if (Test-Path -LiteralPath $outputDirectory) {
    $createdBuilds = @(
      Get-ChildItem -LiteralPath $outputDirectory -File -Recurse |
        Where-Object { $_.Name -match "\.(exe|zip)$" }
    )
  }
  Assert-True ($createdBuilds.Count -eq 0) "Packaging created an installer or ZIP despite incomplete signing secrets."

  Write-Host "Verified incomplete signing secrets fail before Windows packaging or unsigned labeling."
} finally {
  Remove-Item Env:WINDOWS_CERTIFICATE_BASE64 -ErrorAction SilentlyContinue
  Remove-Item Env:WINDOWS_CERTIFICATE_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item function:pnpm -ErrorAction SilentlyContinue
  Remove-Variable PackagingCommandInvoked -Scope Global -ErrorAction SilentlyContinue
  Set-Location -LiteralPath $previousLocation
  if (Test-Path -LiteralPath $testDirectory) {
    Remove-Item -LiteralPath $testDirectory -Recurse -Force
  }
}
