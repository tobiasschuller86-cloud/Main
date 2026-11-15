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

function Assert-NoCertificateMaterialInOutput {
  param(
    [string]$Output,
    [string]$CertificateBase64,
    [string]$Password
  )

  if ($Output.Contains($CertificateBase64) -or $Output.Contains($Password)) {
    throw "The signed Windows packaging test attempted to print temporary certificate material."
  }
}

function Assert-TrustedSignedOutput {
  param(
    [string]$Path,
    [string]$ExpectedThumbprint,
    [string]$Description
  )

  $signature = Get-AuthenticodeSignature -FilePath $Path
  Assert-True (
    $signature.Status -eq [System.Management.Automation.SignatureStatus]::Valid
  ) "$Description does not have a valid signature."
  Assert-True (
    $signature.SignerCertificate -and
    $signature.SignerCertificate.Thumbprint -eq $ExpectedThumbprint
  ) "$Description signature does not match the temporary test publisher."
  Assert-True (
    $signature.TimeStamperCertificate
  ) "$Description does not have a trusted timestamp."
}

$passwordBytes = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
$certificatePassword = [Convert]::ToBase64String($passwordBytes)
$certificateBase64 = $null
$certificateBytes = $null
$privateKey = $null
$certificate = $null
$rootStore = $null
$publisherStore = $null
$rootCertificateInstalled = $false
$publisherCertificateInstalled = $false
$zipCheckDirectory = Join-Path ([IO.Path]::GetTempPath()) "tt-turnier-signed-package-check-$([guid]::NewGuid())"
$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$previousLocation = Get-Location

try {
  $privateKey = [System.Security.Cryptography.RSA]::Create(2048)
  $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
    "CN=TT Turnier CI Signing Test",
    $privateKey,
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

  $certificate = $request.CreateSelfSigned(
    [datetimeoffset]::UtcNow.AddMinutes(-5),
    [datetimeoffset]::UtcNow.AddDays(60)
  )
  $certificateBytes = $certificate.Export(
    [System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx,
    $certificatePassword
  )
  $certificateBase64 = [Convert]::ToBase64String($certificateBytes)

  $rootStore = [System.Security.Cryptography.X509Certificates.X509Store]::new("Root", "CurrentUser")
  $rootStore.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
  $rootStore.Add($certificate)
  $rootCertificateInstalled = $true

  $publisherStore = [System.Security.Cryptography.X509Certificates.X509Store]::new("TrustedPublisher", "CurrentUser")
  $publisherStore.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
  $publisherStore.Add($certificate)
  $publisherCertificateInstalled = $true

  $env:WINDOWS_CERTIFICATE_BASE64 = $certificateBase64
  $env:WINDOWS_CERTIFICATE_PASSWORD = $certificatePassword

  Set-Location -LiteralPath $workspaceRoot
  $packageOutput = @()
  $packageInvocationError = $null
  try {
    $packageOutput = @(& (Join-Path $PSScriptRoot "package-windows-builds.ps1") *>&1)
  } catch {
    $packageInvocationError = $_
  }
  $packageOutputText = ($packageOutput | ForEach-Object { "$_" }) -join "`n"
  if ($packageInvocationError) {
    $packageOutputText += "`n$packageInvocationError"
  }
  Assert-NoCertificateMaterialInOutput `
    -Output $packageOutputText `
    -CertificateBase64 $certificateBase64 `
    -Password $certificatePassword
  $packageOutput | ForEach-Object { Write-Host "$_" }
  if ($packageInvocationError) {
    throw "The shared Windows packaging script failed during signed packaging."
  }
  Assert-True ([string]::IsNullOrEmpty($env:WINDOWS_CERTIFICATE_BASE64)) "Signed packaging left the certificate environment value behind."
  Assert-True ([string]::IsNullOrEmpty($env:WINDOWS_CERTIFICATE_PASSWORD)) "Signed packaging left the password environment value behind."
  Assert-True ([string]::IsNullOrEmpty($env:CSC_LINK)) "Signed packaging left CSC_LINK behind."
  Assert-True ([string]::IsNullOrEmpty($env:CSC_KEY_PASSWORD)) "Signed packaging left CSC_KEY_PASSWORD behind."

  $outputDirectory = Join-Path $workspaceRoot "generated-artifacts/tt-turnier-windows"
  $installers = @(Get-ChildItem -LiteralPath $outputDirectory -Filter "Tischtennis-Turnier-*-x64-signed.exe" -File)
  $zipBuilds = @(Get-ChildItem -LiteralPath $outputDirectory -Filter "Tischtennis-Turnier-*-x64-signed.zip" -File)
  Assert-True ($installers.Count -eq 1) "Expected exactly one signed Windows installer."
  Assert-True ($zipBuilds.Count -eq 1) "Expected exactly one signed Windows ZIP build."

  Assert-TrustedSignedOutput `
    -Path $installers[0].FullName `
    -ExpectedThumbprint $certificate.Thumbprint `
    -Description "The signed Windows installer"

  New-Item -ItemType Directory -Path $zipCheckDirectory | Out-Null
  [System.IO.Compression.ZipFile]::ExtractToDirectory($zipBuilds[0].FullName, $zipCheckDirectory)
  $zipExecutables = @(
    Get-ChildItem -LiteralPath $zipCheckDirectory -File -Recurse |
      Where-Object { $_.Extension -ieq ".exe" }
  )
  $appExecutables = @($zipExecutables | Where-Object { $_.Name -ieq "Tischtennis-Turnier.exe" })
  Assert-True ($appExecutables.Count -eq 1) "Expected exactly one app executable inside the signed Windows ZIP."
  Assert-True ($zipExecutables.Count -gt 0) "Expected at least one executable inside the signed Windows ZIP."

  foreach ($zipExecutable in $zipExecutables) {
    Assert-TrustedSignedOutput `
      -Path $zipExecutable.FullName `
      -ExpectedThumbprint $certificate.Thumbprint `
      -Description "The signed ZIP executable '$($zipExecutable.Name)'"
  }

  $packageVersion = (
    Get-Content -LiteralPath (Join-Path $workspaceRoot "artifacts/tt-turnier/package.json") -Raw |
      ConvertFrom-Json
  ).version
  $staleFiles = @(
    "Tischtennis-Turnier-$packageVersion-x64-unsigned.exe",
    "Tischtennis-Turnier-$packageVersion-x64-unsigned.exe.sha256",
    "Tischtennis-Turnier-$packageVersion-x64-unsigned.zip",
    "Tischtennis-Turnier-$packageVersion-x64-unsigned.zip.sha256",
    "Tischtennis-Turnier-stale-x64-signed.exe",
    "Tischtennis-Turnier-stale-x64-signed.zip"
  )
  foreach ($staleFile in $staleFiles) {
    Set-Content -LiteralPath (Join-Path $outputDirectory $staleFile) -Value "stale release output"
  }
  $unrelatedFile = Join-Path $outputDirectory "keep-this-local-note.txt"
  Set-Content -LiteralPath $unrelatedFile -Value "unrelated local file"

  $env:WINDOWS_CERTIFICATE_BASE64 = $certificateBase64
  $env:WINDOWS_CERTIFICATE_PASSWORD = $certificatePassword
  $rebuildOutput = @()
  $rebuildInvocationError = $null
  try {
    $rebuildOutput = @(& (Join-Path $PSScriptRoot "package-windows-builds.ps1") *>&1)
  } catch {
    $rebuildInvocationError = $_
  }
  $rebuildOutputText = ($rebuildOutput | ForEach-Object { "$_" }) -join "`n"
  if ($rebuildInvocationError) {
    $rebuildOutputText += "`n$rebuildInvocationError"
  }
  Assert-NoCertificateMaterialInOutput `
    -Output $rebuildOutputText `
    -CertificateBase64 $certificateBase64 `
    -Password $certificatePassword
  if ($rebuildInvocationError) {
    throw "The shared Windows packaging script failed during the same-version rebuild."
  }
  Assert-True ([string]::IsNullOrEmpty($env:WINDOWS_CERTIFICATE_BASE64)) "The signed rebuild left the certificate environment value behind."
  Assert-True ([string]::IsNullOrEmpty($env:WINDOWS_CERTIFICATE_PASSWORD)) "The signed rebuild left the password environment value behind."
  Assert-True ([string]::IsNullOrEmpty($env:CSC_LINK)) "The signed rebuild left CSC_LINK behind."
  Assert-True ([string]::IsNullOrEmpty($env:CSC_KEY_PASSWORD)) "The signed rebuild left CSC_KEY_PASSWORD behind."

  $currentReleaseFiles = @(
    Get-ChildItem -LiteralPath $outputDirectory -File |
      Where-Object {
        $_.Name -match '^Tischtennis-Turnier-.*-x64-(?:signed|unsigned)\.(?:exe|zip)(?:\.sha256)?$'
      }
  )
  Assert-True (
    ($currentReleaseFiles | Where-Object { $_.Name -match '-unsigned\.' }).Count -eq 0
  ) "The signed rebuild retained stale unsigned release files."
  Assert-True (
    ($currentReleaseFiles | Where-Object { $_.Name -match '-signed\.exe$' }).Count -eq 1 -and
    ($currentReleaseFiles | Where-Object { $_.Name -match '-signed\.zip$' }).Count -eq 1 -and
    ($currentReleaseFiles | Where-Object { $_.Name -match '-signed\.exe\.sha256$' }).Count -eq 1 -and
    ($currentReleaseFiles | Where-Object { $_.Name -match '-signed\.zip\.sha256$' }).Count -eq 1
  ) "The signed rebuild did not leave exactly one correctly labeled installer, ZIP, and checksum pair."
  Assert-True (Test-Path -LiteralPath $unrelatedFile) "The signed rebuild removed an unrelated output file."

  $installers = @(Get-ChildItem -LiteralPath $outputDirectory -Filter "Tischtennis-Turnier-*-x64-signed.exe" -File)
  $zipBuilds = @(Get-ChildItem -LiteralPath $outputDirectory -Filter "Tischtennis-Turnier-*-x64-signed.zip" -File)
  Assert-TrustedSignedOutput `
    -Path $installers[0].FullName `
    -ExpectedThumbprint $certificate.Thumbprint `
    -Description "The rebuilt signed Windows installer"
  Remove-Item -LiteralPath $zipCheckDirectory -Recurse -Force
  New-Item -ItemType Directory -Path $zipCheckDirectory | Out-Null
  [System.IO.Compression.ZipFile]::ExtractToDirectory($zipBuilds[0].FullName, $zipCheckDirectory)
  $rebuiltZipExecutables = @(
    Get-ChildItem -LiteralPath $zipCheckDirectory -File -Recurse |
      Where-Object { $_.Extension -ieq ".exe" }
  )
  Assert-True ($rebuiltZipExecutables.Count -gt 0) "The rebuilt signed ZIP contains no executables."
  foreach ($zipExecutable in $rebuiltZipExecutables) {
    Assert-TrustedSignedOutput `
      -Path $zipExecutable.FullName `
      -ExpectedThumbprint $certificate.Thumbprint `
      -Description "The rebuilt signed ZIP executable '$($zipExecutable.Name)'"
  }

  Write-Host "Verified signed publisher identity, trusted timestamps, ZIP executables, and same-version rebuild cleanup."
} finally {
  Remove-Item Env:WINDOWS_CERTIFICATE_BASE64 -ErrorAction SilentlyContinue
  Remove-Item Env:WINDOWS_CERTIFICATE_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:CSC_LINK -ErrorAction SilentlyContinue
  Remove-Item Env:CSC_KEY_PASSWORD -ErrorAction SilentlyContinue

  $cleanupFailed = $false
  try {
    if ($publisherStore) {
      try {
        if ($publisherCertificateInstalled -and $certificate) {
          $publisherStore.Remove($certificate)
        }
      } catch {
        $cleanupFailed = $true
      } finally {
        $publisherStore.Close()
      }
    }
    if ($rootStore) {
      try {
        if ($rootCertificateInstalled -and $certificate) {
          $rootStore.Remove($certificate)
        }
      } catch {
        $cleanupFailed = $true
      } finally {
        $rootStore.Close()
      }
    }
  } finally {
    if (Test-Path -LiteralPath $zipCheckDirectory) {
      Remove-Item -LiteralPath $zipCheckDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
    Set-Location -LiteralPath $previousLocation

    if ($certificateBytes) {
      [Array]::Clear($certificateBytes, 0, $certificateBytes.Length)
    }
    if ($passwordBytes) {
      [Array]::Clear($passwordBytes, 0, $passwordBytes.Length)
    }
    if ($certificate) {
      $certificate.Dispose()
    }
    if ($privateKey) {
      $privateKey.Dispose()
    }
    $certificateBase64 = $null
    $certificatePassword = $null
    $certificateBytes = $null
    $passwordBytes = $null
  }
  if ($cleanupFailed) {
    throw "The signed Windows packaging test could not remove its temporary certificate from a trust store."
  }
}
