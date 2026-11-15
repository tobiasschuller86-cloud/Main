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
$testDirectory = Join-Path ([IO.Path]::GetTempPath()) "tt-turnier-partial-packaging-test-$([guid]::NewGuid())"
$previousLocation = Get-Location
$originalWindowsCertificateBase64 = $env:WINDOWS_CERTIFICATE_BASE64
$originalWindowsCertificatePassword = $env:WINDOWS_CERTIFICATE_PASSWORD
$originalLastExitCode = $global:LASTEXITCODE
$global:PackagingScenario = ""
$global:PackagingCommandCount = 0
$global:PublicationMoveCount = 0
$global:StagingDirectories = [System.Collections.Generic.List[string]]::new()
$global:SigningMaterialWasPresent = $false
$global:SigningMaterialPath = $null
$testCertificate = $null
$testPrivateKey = $null
$testCertificateBytes = $null
$testCertificateBase64 = $null
$testCertificatePassword = $null
$rootStore = $null
$publisherStore = $null
$rootCertificateInstalled = $false
$publisherCertificateInstalled = $false

function pnpm {
  $global:PackagingCommandCount++
  $argumentsText = $args -join " "
  if ($global:PackagingScenario -eq "signed-verification-fails") {
    $global:SigningMaterialPath = $env:CSC_LINK
    $global:SigningMaterialWasPresent = (
      -not [string]::IsNullOrWhiteSpace($env:CSC_LINK) -and
      (Test-Path -LiteralPath $env:CSC_LINK) -and
      -not [string]::IsNullOrWhiteSpace($env:CSC_KEY_PASSWORD)
    )
  }
  $stagingArgument = $args | Where-Object { $_ -like "--config.directories.output=*" } | Select-Object -First 1
  if (-not $stagingArgument) {
    throw "The packaging command did not provide a staging output directory."
  }
  $stagingDirectory = $stagingArgument.Substring("--config.directories.output=".Length)
  $global:StagingDirectories.Add($stagingDirectory)
  New-Item -ItemType Directory -Path $stagingDirectory -Force | Out-Null

  if ($argumentsText -match "desktop:windows:installer:package") {
    Set-Content -LiteralPath (Join-Path $stagingDirectory "Tischtennis-Turnier-1.0.0-x64.exe") -Value "partial installer"
    if ($global:PackagingScenario -eq "installer-fails") {
      $global:LASTEXITCODE = 1
      return
    }
    $global:LASTEXITCODE = 0
    return
  }

  if ($argumentsText -match "desktop:windows:zip:package") {
    $zipPath = Join-Path $stagingDirectory "Tischtennis-Turnier-1.0.0-x64.zip"
    if ($global:PackagingScenario -eq "publish-fails") {
      $zipContentsDirectory = Join-Path $stagingDirectory "zip-contents"
      New-Item -ItemType Directory -Path $zipContentsDirectory | Out-Null
      Set-Content -LiteralPath (Join-Path $zipContentsDirectory "Tischtennis-Turnier.exe") -Value "test executable"
      Compress-Archive -Path (Join-Path $zipContentsDirectory "*") -DestinationPath $zipPath
    } else {
      Set-Content -LiteralPath $zipPath -Value "partial ZIP"
    }
    $global:LASTEXITCODE = if ($global:PackagingScenario -in @("zip-verification-fails", "publish-fails")) { 0 } else { 1 }
    return
  }

  throw "Unexpected Windows packaging command: $argumentsText"
}

function Get-AuthenticodeSignature {
  [pscustomobject]@{
    Status = [System.Management.Automation.SignatureStatus]::NotSigned
    StatusMessage = "Not signed"
    SignerCertificate = $null
  }
}

function Move-Item {
  param(
    [Parameter(Mandatory = $true)]
    [string]$LiteralPath,
    [Parameter(Mandatory = $true)]
    [string]$Destination
  )

  if ($global:PackagingScenario -eq "publish-fails") {
    $global:PublicationMoveCount++
    if ($global:PublicationMoveCount -eq 2) {
      throw "Simulated failure while publishing Windows build files."
    }
  }

  Microsoft.PowerShell.Management\Move-Item -LiteralPath $LiteralPath -Destination $Destination
}

try {
  New-Item -ItemType Directory -Path $testDirectory | Out-Null
  Set-Location -LiteralPath $testDirectory
  $env:WINDOWS_CERTIFICATE_BASE64 = ""
  $env:WINDOWS_CERTIFICATE_PASSWORD = ""

  foreach ($scenario in @("installer-fails", "zip-fails", "zip-verification-fails", "publish-fails")) {
    $global:PackagingScenario = $scenario
    $global:PackagingCommandCount = 0
    $global:PublicationMoveCount = 0
    $global:StagingDirectories.Clear()
    $global:SigningMaterialWasPresent = $false
    $global:SigningMaterialPath = $null
    $env:WINDOWS_CERTIFICATE_BASE64 = ""
    $env:WINDOWS_CERTIFICATE_PASSWORD = ""
    $outputDirectory = Join-Path $testDirectory "generated-artifacts/tt-turnier-windows"
    New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
    Get-ChildItem -LiteralPath $outputDirectory -File |
      Where-Object { $_.Name -match '^Tischtennis-Turnier-.+-x64(?:-(?:signed|unsigned))?\.(?:exe|zip)(?:\.sha256)?$' } |
      Remove-Item -Force
    $previousAssets = @{
      "Tischtennis-Turnier-0.9.0-x64-signed.exe" = "previous installer"
      "Tischtennis-Turnier-0.9.0-x64-signed.exe.sha256" = "previous installer checksum"
      "Tischtennis-Turnier-0.9.0-x64-signed.zip" = "previous ZIP"
      "Tischtennis-Turnier-0.9.0-x64-signed.zip.sha256" = "previous ZIP checksum"
    }
    foreach ($previousAsset in $previousAssets.GetEnumerator()) {
      Set-Content -LiteralPath (Join-Path $outputDirectory $previousAsset.Key) -Value $previousAsset.Value
    }
    $unrelatedFile = Join-Path $outputDirectory "keep-this-local-note.txt"
    Set-Content -LiteralPath $unrelatedFile -Value "unrelated local file"

    $packageInvocationError = $null
    try {
      & $packageScript
    } catch {
      $packageInvocationError = $_
    }

    Assert-True ($null -ne $packageInvocationError) "$scenario unexpectedly succeeded."
    Assert-True ($global:PackagingCommandCount -eq $(if ($scenario -eq "installer-fails") { 1 } else { 2 })) "$scenario ran an unexpected number of packaging steps."
    if ($scenario -eq "publish-fails") {
      Assert-True ($global:PublicationMoveCount -eq 2) "$scenario did not fail after a partial output commit."
    }
    Assert-True (Test-Path -LiteralPath $unrelatedFile) "$scenario removed an unrelated file from the output directory."
    Assert-True ((Get-Content -LiteralPath $unrelatedFile -Raw).Trim() -eq "unrelated local file") "$scenario changed an unrelated output file."

    $releaseFiles = @(
      Get-ChildItem -LiteralPath $outputDirectory -File |
        Where-Object { $_.Name -match "^Tischtennis-Turnier-.*\.(exe|zip)(\.sha256)?$" }
    )
    Assert-True ($releaseFiles.Count -eq $previousAssets.Count) "$scenario changed the number of previously published Windows release files."
    foreach ($previousAsset in $previousAssets.GetEnumerator()) {
      $previousAssetPath = Join-Path $outputDirectory $previousAsset.Key
      Assert-True (Test-Path -LiteralPath $previousAssetPath) "$scenario removed the previous Windows release asset $($previousAsset.Key)."
      Assert-True (
        (Get-Content -LiteralPath $previousAssetPath -Raw).Trim() -eq $previousAsset.Value
      ) "$scenario changed the previous Windows release asset $($previousAsset.Key)."
    }
    Assert-True ($global:StagingDirectories.Count -gt 0) "$scenario did not record its temporary build directory."
    foreach ($stagingDirectory in $global:StagingDirectories) {
      Assert-True (-not (Test-Path -LiteralPath $stagingDirectory)) "$scenario left its temporary build directory behind."
    }
    Assert-True ([string]::IsNullOrEmpty($env:WINDOWS_CERTIFICATE_BASE64)) "$scenario left the certificate environment value behind."
    Assert-True ([string]::IsNullOrEmpty($env:WINDOWS_CERTIFICATE_PASSWORD)) "$scenario left the password environment value behind."
    Assert-True ([string]::IsNullOrEmpty($env:CSC_LINK)) "$scenario left CSC_LINK behind."
    Assert-True ([string]::IsNullOrEmpty($env:CSC_KEY_PASSWORD)) "$scenario left CSC_KEY_PASSWORD behind."
  }

  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    Write-Host "The signed PFX cleanup scenario requires Windows; unsigned partial-build cleanup checks passed."
    return
  }

  $randomPasswordBytes = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
  $testCertificatePassword = [Convert]::ToBase64String($randomPasswordBytes)
  $testPrivateKey = [System.Security.Cryptography.RSA]::Create(2048)
  $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
    "CN=TT Turnier Packaging Cleanup Test",
    $testPrivateKey,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256,
    [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
  )
  $request.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true)
  )
  $request.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
      [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature,
      $true
    )
  )
  $codeSigningOids = [System.Security.Cryptography.OidCollection]::new()
  [void]$codeSigningOids.Add([System.Security.Cryptography.Oid]::new("1.3.6.1.5.5.7.3.3"))
  $request.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($codeSigningOids, $true)
  )
  $testCertificate = $request.CreateSelfSigned(
    [datetimeoffset]::UtcNow.AddMinutes(-5),
    [datetimeoffset]::UtcNow.AddDays(60)
  )
  $testCertificateBytes = $testCertificate.Export(
    [System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx,
    $testCertificatePassword
  )
  $testCertificateBase64 = [Convert]::ToBase64String($testCertificateBytes)

  $rootStore = [System.Security.Cryptography.X509Certificates.X509Store]::new("Root", "CurrentUser")
  $rootStore.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
  $rootStore.Add($testCertificate)
  $rootCertificateInstalled = $true
  $publisherStore = [System.Security.Cryptography.X509Certificates.X509Store]::new("TrustedPublisher", "CurrentUser")
  $publisherStore.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
  $publisherStore.Add($testCertificate)
  $publisherCertificateInstalled = $true

  $global:PackagingScenario = "signed-verification-fails"
  $global:PackagingCommandCount = 0
  $global:StagingDirectories.Clear()
  $global:SigningMaterialWasPresent = $false
  $global:SigningMaterialPath = $null
  $env:WINDOWS_CERTIFICATE_BASE64 = $testCertificateBase64
  $env:WINDOWS_CERTIFICATE_PASSWORD = $testCertificatePassword
  $outputDirectory = Join-Path $testDirectory "generated-artifacts/tt-turnier-windows"
  $signedPackageOutput = @()
  $signedPackageError = $null
  try {
    $signedPackageOutput = @(& $packageScript *>&1)
  } catch {
    $signedPackageError = $_
  }
  $signedPackageOutputText = ($signedPackageOutput | ForEach-Object { "$_" }) -join "`n"
  if ($signedPackageError) {
    $signedPackageOutputText += "`n$signedPackageError"
  }
  Assert-True (
    -not $signedPackageOutputText.Contains($testCertificateBase64) -and
    -not $signedPackageOutputText.Contains($testCertificatePassword)
  ) "The signed packaging failure printed temporary certificate material."
  Write-Host $signedPackageOutputText
  Assert-True ($null -ne $signedPackageError) "The signed verification failure scenario unexpectedly succeeded."
  Assert-True ($global:SigningMaterialWasPresent) "The signed failure did not reach packaging with a prepared PFX and signing environment."
  Assert-True (
    -not $signedPackageOutputText.Contains($testCertificateBase64) -and
    -not $signedPackageOutputText.Contains($testCertificatePassword)
  ) "The signed packaging failure printed temporary certificate material."
  Assert-True ($global:PackagingCommandCount -eq 2) "The signed failure did not run both Windows packaging commands."
  Assert-True ([string]::IsNullOrEmpty($env:WINDOWS_CERTIFICATE_BASE64)) "The signed failure left the certificate environment value behind."
  Assert-True ([string]::IsNullOrEmpty($env:WINDOWS_CERTIFICATE_PASSWORD)) "The signed failure left the password environment value behind."
  Assert-True ([string]::IsNullOrEmpty($env:CSC_LINK)) "The signed failure left CSC_LINK behind."
  Assert-True ([string]::IsNullOrEmpty($env:CSC_KEY_PASSWORD)) "The signed failure left CSC_KEY_PASSWORD behind."
  Assert-True (
    $global:SigningMaterialPath -and -not (Test-Path -LiteralPath $global:SigningMaterialPath)
  ) "The signed failure left its temporary PFX file behind."
  $signedReleaseFiles = @(
    Get-ChildItem -LiteralPath $outputDirectory -File |
      Where-Object { $_.Name -match "^Tischtennis-Turnier-.*\.(exe|zip)(\.sha256)?$" }
  )
  Assert-True ($signedReleaseFiles.Count -eq $previousAssets.Count) "The signed failure changed the number of previous Windows release files."
  foreach ($previousAsset in $previousAssets.GetEnumerator()) {
    $previousAssetPath = Join-Path $outputDirectory $previousAsset.Key
    Assert-True (Test-Path -LiteralPath $previousAssetPath) "The signed failure removed the previous Windows release asset $($previousAsset.Key)."
    Assert-True (
      (Get-Content -LiteralPath $previousAssetPath -Raw).Trim() -eq $previousAsset.Value
    ) "The signed failure changed the previous Windows release asset $($previousAsset.Key)."
  }
  foreach ($stagingDirectory in $global:StagingDirectories) {
    Assert-True (-not (Test-Path -LiteralPath $stagingDirectory)) "The signed failure left its temporary build directory behind."
  }

  Write-Host "Passed partial Windows packaging cleanup checks, including failure after signing material was prepared."
} finally {
  if ($publisherStore) {
    try {
      if ($publisherCertificateInstalled -and $testCertificate) {
        $publisherStore.Remove($testCertificate)
      }
    } finally {
      $publisherStore.Close()
    }
  }
  if ($rootStore) {
    try {
      if ($rootCertificateInstalled -and $testCertificate) {
        $rootStore.Remove($testCertificate)
      }
    } finally {
      $rootStore.Close()
    }
  }
  $env:WINDOWS_CERTIFICATE_BASE64 = $originalWindowsCertificateBase64
  $env:WINDOWS_CERTIFICATE_PASSWORD = $originalWindowsCertificatePassword
  $global:LASTEXITCODE = $originalLastExitCode
  Remove-Item function:pnpm -ErrorAction SilentlyContinue
  Remove-Item function:Get-AuthenticodeSignature -ErrorAction SilentlyContinue
  Remove-Item function:Move-Item -ErrorAction SilentlyContinue
  Remove-Variable PackagingScenario -Scope Global -ErrorAction SilentlyContinue
  Remove-Variable PackagingCommandCount -Scope Global -ErrorAction SilentlyContinue
  Remove-Variable PublicationMoveCount -Scope Global -ErrorAction SilentlyContinue
  Remove-Variable StagingDirectories -Scope Global -ErrorAction SilentlyContinue
  Remove-Variable SigningMaterialWasPresent -Scope Global -ErrorAction SilentlyContinue
  Remove-Variable SigningMaterialPath -Scope Global -ErrorAction SilentlyContinue
  if ($testCertificateBytes) {
    [Array]::Clear($testCertificateBytes, 0, $testCertificateBytes.Length)
  }
  if ($randomPasswordBytes) {
    [Array]::Clear($randomPasswordBytes, 0, $randomPasswordBytes.Length)
  }
  if ($testCertificate) {
    $testCertificate.Dispose()
  }
  if ($testPrivateKey) {
    $testPrivateKey.Dispose()
  }
  Set-Location -LiteralPath $previousLocation
  if (Test-Path -LiteralPath $testDirectory) {
    Remove-Item -LiteralPath $testDirectory -Recurse -Force
  }
}
