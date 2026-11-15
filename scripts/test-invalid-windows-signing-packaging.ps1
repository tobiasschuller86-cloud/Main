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
$testDirectory = Join-Path ([IO.Path]::GetTempPath()) "tt-turnier-invalid-signing-test-$([guid]::NewGuid())"
$previousLocation = Get-Location
$certificateBytes = $null
$invalidCertificate = $null
$testPassword = "invalid-certificate-test-password"
$global:PackagingCommands = [System.Collections.Generic.List[string]]::new()

function New-InvalidSigningCertificate {
  param([string]$Password)

  $key = [System.Security.Cryptography.RSA]::Create(2048)
  $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
    "CN=TT Turnier Invalid Signing Test",
    $key,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256,
    [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
  )
  $serverAuthenticationOids = [System.Security.Cryptography.OidCollection]::new()
  [void]$serverAuthenticationOids.Add([System.Security.Cryptography.Oid]::new("1.3.6.1.5.5.7.3.1"))
  $request.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($serverAuthenticationOids, $true)
  )

  $generatedCertificate = $request.CreateSelfSigned(
    [datetimeoffset]::UtcNow.AddMinutes(-5),
    [datetimeoffset]::UtcNow.AddDays(60)
  )
  try {
    return $generatedCertificate.Export(
      [System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx,
      $Password
    )
  } finally {
    $generatedCertificate.Dispose()
    $key.Dispose()
  }
}

try {
  $certificateBytes = New-InvalidSigningCertificate -Password $testPassword
  $invalidCertificate = [Convert]::ToBase64String($certificateBytes)
  New-Item -ItemType Directory -Path $testDirectory | Out-Null
  Set-Location -LiteralPath $testDirectory

  $env:WINDOWS_CERTIFICATE_BASE64 = $invalidCertificate
  $env:WINDOWS_CERTIFICATE_PASSWORD = $testPassword
  function pnpm {
    $global:PackagingCommands.Add(($args -join " "))
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

  Assert-True ($null -ne $packageInvocationError) "Packaging unexpectedly succeeded with invalid signing certificate data."
  Assert-True (
    $packageOutputText -match "not approved for code signing.*Enhanced Key Usage includes Code Signing"
  ) "Packaging did not fail with the expected invalid-certificate preflight error."
  Assert-True (
    $packageOutputText -notmatch "(?i)unsigned"
  ) "Packaging labeled a build unsigned after rejecting invalid signing certificate data."
  Assert-True (
    -not $packageOutputText.Contains($invalidCertificate) -and
    -not $packageOutputText.Contains($testPassword)
  ) "Packaging printed invalid signing certificate material."
  Assert-True (
    $global:PackagingCommands.Count -eq 0
  ) "The installer or ZIP packaging command ran before the certificate-validation failure."

  $outputDirectory = Join-Path $testDirectory "generated-artifacts/tt-turnier-windows"
  $createdBuilds = @()
  if (Test-Path -LiteralPath $outputDirectory) {
    $createdBuilds = @(
      Get-ChildItem -LiteralPath $outputDirectory -File -Recurse |
        Where-Object { $_.Name -match "\.(exe|zip)(\.sha256)?$" }
    )
  }
  Assert-True ($createdBuilds.Count -eq 0) "Packaging created an installer or ZIP despite invalid signing certificate data."

  Write-Host "Verified a generated certificate rejected by preflight prevents Windows packaging and artifact creation."
} finally {
  Remove-Item Env:WINDOWS_CERTIFICATE_BASE64 -ErrorAction SilentlyContinue
  Remove-Item Env:WINDOWS_CERTIFICATE_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item function:pnpm -ErrorAction SilentlyContinue
  Remove-Variable PackagingCommands -Scope Global -ErrorAction SilentlyContinue
  Remove-Item function:New-InvalidSigningCertificate -ErrorAction SilentlyContinue
  Set-Location -LiteralPath $previousLocation
  if (Test-Path -LiteralPath $testDirectory) {
    Remove-Item -LiteralPath $testDirectory -Recurse -Force
  }
  if ($certificateBytes) {
    [Array]::Clear($certificateBytes, 0, $certificateBytes.Length)
  }
}
