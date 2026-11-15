$ErrorActionPreference = "Stop"
. "$PSScriptRoot/windows-signing-certificate.ps1"
. "$PSScriptRoot/windows-test-root-store.ps1"

function Assert-True {
  param(
    [bool]$Condition,
    [string]$Message
  )

  if (-not $Condition) {
    throw $Message
  }
}

function Convert-OutputToText {
  param([object[]]$Output)

  return (($Output | ForEach-Object { "$_" }) -join "`n")
}

function Assert-NoSecretOutput {
  param(
    [string]$Output,
    [string]$CertificateBase64,
    [string]$Password
  )

  Assert-True (-not $Output.Contains($CertificateBase64)) "Certificate contents were printed by the certificate check."
  Assert-True (-not $Output.Contains($Password)) "The certificate password was printed by the certificate check."
}

$emptyConfiguration = Get-WindowsSigningConfigurationStatus -CertificateBase64 "" -Password ""
Assert-True (-not $emptyConfiguration.IsConfigured) "Signing was marked configured when both secrets were missing."
Assert-True (
  ($emptyConfiguration.MissingSecrets -join ",") -eq "WINDOWS_CERTIFICATE_BASE64,WINDOWS_CERTIFICATE_PASSWORD"
) "The missing-secrets status did not name both absent secrets."

$missingPassword = Get-WindowsSigningConfigurationStatus `
  -CertificateBase64 "safe-test-certificate-value" `
  -Password ""
Assert-True (-not $missingPassword.IsConfigured) "Signing was marked configured when the password was missing."
Assert-True (
  ($missingPassword.MissingSecrets -join ",") -eq "WINDOWS_CERTIFICATE_PASSWORD"
) "The missing-password status did not identify the absent secret."

$missingCertificate = Get-WindowsSigningConfigurationStatus `
  -CertificateBase64 "" `
  -Password "safe-test-password-value"
Assert-True (-not $missingCertificate.IsConfigured) "Signing was marked configured when the certificate was missing."
Assert-True (
  ($missingCertificate.MissingSecrets -join ",") -eq "WINDOWS_CERTIFICATE_BASE64"
) "The missing-certificate status did not identify the absent secret."

$completeConfiguration = Get-WindowsSigningConfigurationStatus `
  -CertificateBase64 "safe-test-certificate-value" `
  -Password "safe-test-password-value"
Assert-True $completeConfiguration.IsConfigured "Signing was not marked configured when both secrets were present."
Assert-True ($completeConfiguration.MissingSecrets.Count -eq 0) "A complete signing configuration reported missing secrets."

$testNow = [datetime]::SpecifyKind([datetime]"2035-01-15T12:00:00", [DateTimeKind]::Utc)
$password = "test-only-password-do-not-print"

function New-TestCertificateBase64 {
  param(
    [datetime]$NotAfter,
    [datetime]$Now,
    [int]$NotBeforeOffsetDays = -1,
    [switch]$PublicOnly,
    [string[]]$EnhancedKeyUsageOids,
    [switch]$AddKeyUsageExtension,
    [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]$KeyUsageFlags = [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature,
    [switch]$CertificateAuthority,
    [switch]$MalformedEnhancedKeyUsage,
    [switch]$MalformedKeyUsage
  )

  $key = [System.Security.Cryptography.RSA]::Create(2048)
  $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
    "CN=Certificate Expiry Test",
    $key,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256,
    [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
  )
  if ($CertificateAuthority) {
    $request.CertificateExtensions.Add(
      [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true, $false, 0, $true)
    )
    $request.CertificateExtensions.Add(
      [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
        [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign,
        $true
      )
    )
  }
  if ($MalformedEnhancedKeyUsage) {
    $request.CertificateExtensions.Add(
      [System.Security.Cryptography.X509Certificates.X509Extension]::new(
        [System.Security.Cryptography.Oid]::new("2.5.29.37"),
        [byte[]]@(0x30, 0x01, 0xFF),
        $true
      )
    )
  } elseif ($EnhancedKeyUsageOids.Count -gt 0) {
    $enhancedKeyUsages = [System.Security.Cryptography.OidCollection]::new()
    foreach ($enhancedKeyUsageOid in $EnhancedKeyUsageOids) {
      [void]$enhancedKeyUsages.Add([System.Security.Cryptography.Oid]::new($enhancedKeyUsageOid))
    }
    $request.CertificateExtensions.Add(
      [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($enhancedKeyUsages, $true)
    )
  }
  if ($MalformedKeyUsage) {
    $request.CertificateExtensions.Add(
      [System.Security.Cryptography.X509Certificates.X509Extension]::new(
        [System.Security.Cryptography.Oid]::new("2.5.29.15"),
        [byte[]]@(0x03, 0x01, 0xFF),
        $true
      )
    )
  } elseif ($AddKeyUsageExtension) {
    $request.CertificateExtensions.Add(
      [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($KeyUsageFlags, $true)
    )
  }
  $certificate = $request.CreateSelfSigned($Now.AddDays($NotBeforeOffsetDays), $NotAfter)
  try {
    if ($PublicOnly) {
      return [Convert]::ToBase64String(
        $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)
      )
    }

    return [Convert]::ToBase64String(
      $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $password)
    )
  } finally {
    $certificate.Dispose()
    $key.Dispose()
  }
}

function Invoke-CertificateCheck {
  param(
    [string]$CertificateBase64,
    [string]$Password = $script:password,
    [switch]$AllowExpired,
    [datetime]$NowUtc = $script:testNow,
    [switch]$SkipTrust
  )

  $trustStore = $null
  $trustedCertificate = $null
  $certificateForTrust = $null
  $capturedOutput = @()
  $result = $null
  $errorMessage = $null
  try {
    if (-not $SkipTrust) {
      $certificateForTrust = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
        [Convert]::FromBase64String($CertificateBase64),
        $Password,
        [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
      )
      $trustedCertificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
        $certificateForTrust.RawData
      )
      $trustStore = Open-WindowsTestRootStore
      Write-Host "Installing temporary certificate for certificate validation test."
      $trustStore.Add($trustedCertificate)
      Write-Host "Temporary certificate installed; validating certificate."
    }

    $capturedOutput = @(Get-WindowsSigningCertificateInfo `
      -CertificateBase64 $CertificateBase64 `
      -Password $Password `
      -NowUtc $NowUtc `
      -AllowExpired:$AllowExpired 6>&1)
    $successOutput = @($capturedOutput | Where-Object {
      $_ -isnot [System.Management.Automation.InformationRecord]
    })
    Assert-True (
      $successOutput.Count -eq 1 -and $successOutput[0] -is [pscustomobject]
    ) "Certificate preflight must return exactly one result, without collection indexes or extra success output."
    Assert-True (
      $successOutput[0].CertificateBytes -is [byte[]]
    ) "Certificate preflight must retain a byte array, not an enumerated object array."
    $roundTripCertificate = $null
    try {
      # Use the same property access and constructor as the packaging caller.
      $roundTripCertificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
        $successOutput[0].CertificateBytes,
        $Password,
        [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
      )
      Assert-True $roundTripCertificate.HasPrivateKey "Accepted PFX bytes could not reload their private signing key."
    } finally {
      if ($roundTripCertificate) {
        $roundTripCertificate.Dispose()
      }
    }
    if ($capturedOutput.Count -gt 0 -and $capturedOutput[-1] -is [pscustomobject]) {
      $result = $capturedOutput[-1]
      $capturedOutput = @($capturedOutput | Select-Object -SkipLast 1)
    }
  } catch {
    $errorMessage = $_.Exception.Message
    $capturedOutput += $_
  } finally {
    if ($trustStore) {
      if ($trustedCertificate) {
        $trustStore.Remove($trustedCertificate)
      }
      $trustStore.Close()
    }
    if ($trustedCertificate) {
      $trustedCertificate.Dispose()
    }
    if ($certificateForTrust) {
      $certificateForTrust.Dispose()
    }
  }

  return [pscustomobject]@{
    Output = Convert-OutputToText $capturedOutput
    ErrorMessage = $errorMessage
    Result = $result
  }
}

function Assert-NonUtcBoundaryCheck {
  param(
    [string]$CertificateBase64,
    [string]$Password,
    [datetime]$NowUtc
  )

  $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
    [Convert]::FromBase64String($CertificateBase64),
    $Password,
    [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
  )
  $trustedCertificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($certificate.RawData)
  $trustStore = Open-WindowsTestRootStore
  try {
    Write-Host "Installing temporary certificate for time-zone boundary test."
    $trustStore.Add($trustedCertificate)
    Write-Host "Temporary certificate installed; starting time-zone boundary test."
    $processInfo = [System.Diagnostics.ProcessStartInfo]::new([Environment]::ProcessPath)
    $processInfo.UseShellExecute = $false
    $processInfo.RedirectStandardOutput = $true
    $processInfo.RedirectStandardError = $true
    $processInfo.Environment["TZ"] = "America/Los_Angeles"
    $processInfo.Environment["WINDOWS_SIGNING_TEST_CERTIFICATE"] = $CertificateBase64
    $processInfo.Environment["WINDOWS_SIGNING_TEST_PASSWORD"] = $Password
    $processInfo.Environment["WINDOWS_SIGNING_TEST_NOW"] = $NowUtc.ToString("o")
    $processInfo.Environment["WINDOWS_SIGNING_TEST_SCRIPT"] = "$PSScriptRoot/windows-signing-certificate.ps1"
    $processInfo.ArgumentList.Add("-NoProfile")
    $processInfo.ArgumentList.Add("-NonInteractive")
    $processInfo.ArgumentList.Add("-Command")
    $processInfo.ArgumentList.Add(@'
. $env:WINDOWS_SIGNING_TEST_SCRIPT
$now = [datetime]::Parse($env:WINDOWS_SIGNING_TEST_NOW, [cultureinfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
if ([TimeZoneInfo]::Local.GetUtcOffset($now).TotalHours -ne -8) { exit 4 }
$result = Get-WindowsSigningCertificateInfo -CertificateBase64 $env:WINDOWS_SIGNING_TEST_CERTIFICATE -Password $env:WINDOWS_SIGNING_TEST_PASSWORD -NowUtc $now
if (-not $result.HasCertificate) { exit 5 }
Write-Output "non-UTC exact-start boundary passed"
'@)

    $process = [System.Diagnostics.Process]::Start($processInfo)
    try {
      $stdoutTask = $process.StandardOutput.ReadToEndAsync()
      $stderrTask = $process.StandardError.ReadToEndAsync()
      if (-not $process.WaitForExit(60000)) {
        $process.Kill($true)
        throw "The certificate time-zone boundary test exceeded its 60-second limit."
      }
      $stdout = $stdoutTask.GetAwaiter().GetResult()
      $stderr = $stderrTask.GetAwaiter().GetResult()
      $exitCode = $process.ExitCode
    } finally {
      $process.Dispose()
    }
    Assert-NoSecretOutput -Output "$stdout`n$stderr" -CertificateBase64 $CertificateBase64 -Password $Password
    Assert-True (
      $exitCode -eq 0 -and $stdout -match "non-UTC exact-start boundary passed"
    ) "Certificate validity failed at the exact UTC start time in a non-UTC process."
  } finally {
    $trustStore.Remove($trustedCertificate)
    $trustStore.Close()
    $trustedCertificate.Dispose()
    $certificate.Dispose()
  }
}

$publicOnlyBase64 = New-TestCertificateBase64 `
  -NotAfter $testNow.AddDays(45) `
  -Now $testNow `
  -PublicOnly
$publicOnly = Invoke-CertificateCheck -CertificateBase64 $publicOnlyBase64
Assert-True ($publicOnly.ErrorMessage -match "does not contain its private signing key") "A certificate without a private signing key was not rejected with a safe error."
Assert-NoSecretOutput -Output "$($publicOnly.Output)`n$($publicOnly.ErrorMessage)" -CertificateBase64 $publicOnlyBase64 -Password $password

$wrongPurposeBase64 = New-TestCertificateBase64 `
  -NotAfter $testNow.AddDays(45) `
  -Now $testNow `
  -EnhancedKeyUsageOid "1.3.6.1.5.5.7.3.1"
$wrongPurpose = Invoke-CertificateCheck -CertificateBase64 $wrongPurposeBase64
Assert-True ($wrongPurpose.ErrorMessage -match "not approved for code signing.*Enhanced Key Usage includes Code Signing") "A certificate restricted to a different purpose was not rejected with an actionable error."
Assert-NoSecretOutput -Output "$($wrongPurpose.Output)`n$($wrongPurpose.ErrorMessage)" -CertificateBase64 $wrongPurposeBase64 -Password $password

$codeSigningBase64 = New-TestCertificateBase64 `
  -NotAfter $testNow.AddDays(45) `
  -Now $testNow `
  -EnhancedKeyUsageOid "1.3.6.1.5.5.7.3.3"
$codeSigning = Invoke-CertificateCheck -CertificateBase64 $codeSigningBase64
Assert-True (-not $codeSigning.ErrorMessage) "A certificate explicitly approved for code signing was rejected."
Assert-True ($codeSigning.Result.HasCertificate) "The approved code-signing certificate was not accepted."
Assert-NoSecretOutput -Output $codeSigning.Output -CertificateBase64 $codeSigningBase64 -Password $password

$mixedPurposeBase64 = New-TestCertificateBase64 `
  -NotAfter $testNow.AddDays(45) `
  -Now $testNow `
  -EnhancedKeyUsageOids @("1.3.6.1.5.5.7.3.2", "1.3.6.1.5.5.7.3.3")
$mixedPurpose = Invoke-CertificateCheck -CertificateBase64 $mixedPurposeBase64
Assert-True (-not $mixedPurpose.ErrorMessage) "A certificate approved for code signing and another purpose was rejected."
Assert-True ($mixedPurpose.Result.HasCertificate) "The mixed-purpose code-signing certificate was not accepted."
Assert-NoSecretOutput -Output $mixedPurpose.Output -CertificateBase64 $mixedPurposeBase64 -Password $password

$digitalSignatureBase64 = New-TestCertificateBase64 `
  -NotAfter $testNow.AddDays(45) `
  -Now $testNow `
  -EnhancedKeyUsageOids @("1.3.6.1.5.5.7.3.3") `
  -AddKeyUsageExtension `
  -KeyUsageFlags ([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature)
$digitalSignature = Invoke-CertificateCheck -CertificateBase64 $digitalSignatureBase64
Assert-True (-not $digitalSignature.ErrorMessage) "A code-signing certificate with Digital Signature key usage was rejected."
Assert-True ($digitalSignature.Result.HasCertificate) "The certificate with Digital Signature key usage was not accepted."
Assert-NoSecretOutput -Output $digitalSignature.Output -CertificateBase64 $digitalSignatureBase64 -Password $password

$noDigitalSignatureBase64 = New-TestCertificateBase64 `
  -NotAfter $testNow.AddDays(45) `
  -Now $testNow `
  -EnhancedKeyUsageOids @("1.3.6.1.5.5.7.3.3") `
  -AddKeyUsageExtension `
  -KeyUsageFlags ([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment)
$noDigitalSignature = Invoke-CertificateCheck -CertificateBase64 $noDigitalSignatureBase64
Assert-True (
  $noDigitalSignature.ErrorMessage -match "does not allow digital signatures.*Key Usage includes Digital Signature"
) "A code-signing certificate without Digital Signature key usage was not rejected with an actionable error."
Assert-NoSecretOutput -Output "$($noDigitalSignature.Output)`n$($noDigitalSignature.ErrorMessage)" -CertificateBase64 $noDigitalSignatureBase64 -Password $password

$malformedEkuBase64 = New-TestCertificateBase64 `
  -NotAfter $testNow.AddDays(45) `
  -Now $testNow `
  -MalformedEnhancedKeyUsage
$malformedEku = Invoke-CertificateCheck -CertificateBase64 $malformedEkuBase64
Assert-True (
  $malformedEku.ErrorMessage -match "malformed Enhanced Key Usage extension.*Code Signing"
) "A malformed Enhanced Key Usage extension was not rejected with safe remediation guidance."
Assert-NoSecretOutput -Output "$($malformedEku.Output)`n$($malformedEku.ErrorMessage)" -CertificateBase64 $malformedEkuBase64 -Password $password

$malformedKeyUsageBase64 = New-TestCertificateBase64 `
  -NotAfter $testNow.AddDays(45) `
  -Now $testNow `
  -MalformedKeyUsage
$malformedKeyUsage = Invoke-CertificateCheck -CertificateBase64 $malformedKeyUsageBase64
Assert-True (
  $malformedKeyUsage.ErrorMessage -match "malformed Key Usage extension.*Digital Signature"
) "A malformed Key Usage extension was not rejected with safe remediation guidance."
Assert-NoSecretOutput -Output "$($malformedKeyUsage.Output)`n$($malformedKeyUsage.ErrorMessage)" -CertificateBase64 $malformedKeyUsageBase64 -Password $password

$caCertificateBase64 = New-TestCertificateBase64 `
  -NotAfter $testNow.AddDays(45) `
  -Now $testNow `
  -CertificateAuthority
$caCertificate = Invoke-CertificateCheck -CertificateBase64 $caCertificateBase64
Assert-True (
  $caCertificate.ErrorMessage -match "certificate authority.*end-entity publisher certificate"
) "A certificate authority was not rejected as a publisher certificate."
Assert-NoSecretOutput -Output "$($caCertificate.Output)`n$($caCertificate.ErrorMessage)" -CertificateBase64 $caCertificateBase64 -Password $password

$untrustedBase64 = New-TestCertificateBase64 `
  -NotAfter $testNow.AddDays(45) `
  -Now $testNow
$untrusted = Invoke-CertificateCheck -CertificateBase64 $untrustedBase64 -SkipTrust
Assert-True (
  $untrusted.ErrorMessage -match "certificate chain is not trusted.*trusted code-signing authority"
) "An untrusted certificate chain was not rejected with actionable guidance."
Assert-NoSecretOutput -Output "$($untrusted.Output)`n$($untrusted.ErrorMessage)" -CertificateBase64 $untrustedBase64 -Password $password

$expiredBase64 = New-TestCertificateBase64 -NotAfter $testNow.AddDays(-1) -Now $testNow
$expired = Invoke-CertificateCheck -CertificateBase64 $expiredBase64
Assert-True ($expired.ErrorMessage -match "expired on 2035-01-14 UTC") "An expired certificate was not rejected with its expiration date."
Assert-NoSecretOutput -Output "$($expired.Output)`n$($expired.ErrorMessage)" -CertificateBase64 $expiredBase64 -Password $password
$expiredForScheduledCheck = Invoke-CertificateCheck -CertificateBase64 $expiredBase64 -AllowExpired
Assert-True (-not $expiredForScheduledCheck.ErrorMessage) "The scheduled validity check could not inspect an expired certificate."
Assert-True ($expiredForScheduledCheck.Result.IsExpired) "An expired certificate was not marked expired for the scheduled check."
Assert-True (-not $expiredForScheduledCheck.Result.RenewalNeeded) "An expired certificate was also marked as a pre-expiry renewal reminder."
Assert-True (
  $expiredForScheduledCheck.Result.ExpiresAt.ToUniversalTime().ToString("yyyy-MM-dd") -eq "2035-01-14"
) "The scheduled check did not return the expired certificate date."
Assert-NoSecretOutput -Output $expiredForScheduledCheck.Output -CertificateBase64 $expiredBase64 -Password $password

$expiresAtBoundaryBase64 = New-TestCertificateBase64 -NotAfter $testNow -Now $testNow
$expiresAtBoundary = Invoke-CertificateCheck -CertificateBase64 $expiresAtBoundaryBase64
Assert-True (
  $expiresAtBoundary.ErrorMessage -match "expired on 2035-01-15 UTC"
) "A certificate expiring exactly at the injected UTC time was accepted for packaging."
Assert-NoSecretOutput `
  -Output "$($expiresAtBoundary.Output)`n$($expiresAtBoundary.ErrorMessage)" `
  -CertificateBase64 $expiresAtBoundaryBase64 `
  -Password $password
$expiresAtBoundaryForScheduledCheck = Invoke-CertificateCheck `
  -CertificateBase64 $expiresAtBoundaryBase64 `
  -AllowExpired
Assert-True (-not $expiresAtBoundaryForScheduledCheck.ErrorMessage) "The scheduled check could not inspect a certificate expiring exactly at the injected UTC time."
Assert-True ($expiresAtBoundaryForScheduledCheck.Result.IsExpired) "A certificate expiring exactly at the injected UTC time was not marked expired."
Assert-True (
  $expiresAtBoundaryForScheduledCheck.Result.ExpiresAt.ToUniversalTime() -eq $testNow
) "The boundary certificate did not preserve its exact UTC expiration time."
Assert-NoSecretOutput `
  -Output $expiresAtBoundaryForScheduledCheck.Output `
  -CertificateBase64 $expiresAtBoundaryBase64 `
  -Password $password

$expiresJustAfterBoundaryBase64 = New-TestCertificateBase64 `
  -NotAfter $testNow.AddSeconds(1) `
  -Now $testNow
$expiresJustAfterBoundary = Invoke-CertificateCheck -CertificateBase64 $expiresJustAfterBoundaryBase64
Assert-True (-not $expiresJustAfterBoundary.ErrorMessage) "A certificate expiring just after the injected UTC time was rejected for packaging."
Assert-True (-not $expiresJustAfterBoundary.Result.IsExpired) "A certificate expiring just after the injected UTC time was marked expired."
Assert-True (
  $expiresJustAfterBoundary.Result.ExpiresAt.ToUniversalTime() -eq $testNow.AddSeconds(1)
) "The just-after-boundary certificate did not preserve its exact UTC expiration time."
Assert-NoSecretOutput `
  -Output $expiresJustAfterBoundary.Output `
  -CertificateBase64 $expiresJustAfterBoundaryBase64 `
  -Password $password

$notYetValidBase64 = New-TestCertificateBase64 `
  -NotAfter $testNow.AddDays(45) `
  -Now $testNow `
  -NotBeforeOffsetDays 1
$notYetValid = Invoke-CertificateCheck -CertificateBase64 $notYetValidBase64
Assert-True ($notYetValid.ErrorMessage -match "not valid before 2035-01-16 12:00:00 UTC") "A certificate whose validity period has not started was not rejected with its start time."
Assert-NoSecretOutput -Output "$($notYetValid.Output)`n$($notYetValid.ErrorMessage)" -CertificateBase64 $notYetValidBase64 -Password $password

$validFromBoundaryBase64 = New-TestCertificateBase64 `
  -NotAfter $testNow.AddDays(45) `
  -Now $testNow `
  -NotBeforeOffsetDays 0
$validFromBoundary = Invoke-CertificateCheck -CertificateBase64 $validFromBoundaryBase64
Assert-True (-not $validFromBoundary.ErrorMessage) "A certificate was rejected at its exact UTC start time."
Assert-True ($validFromBoundary.Result.HasCertificate) "A certificate valid at its exact UTC start time was not accepted."
Assert-NoSecretOutput -Output $validFromBoundary.Output -CertificateBase64 $validFromBoundaryBase64 -Password $password
if ($env:OS -ne "Windows_NT") {
  Assert-NonUtcBoundaryCheck `
    -CertificateBase64 $validFromBoundaryBase64 `
    -Password $password `
    -NowUtc $testNow
}

$beforeStart = Invoke-CertificateCheck `
  -CertificateBase64 $validFromBoundaryBase64 `
  -NowUtc $testNow.AddSeconds(-1)
Assert-True (
  $beforeStart.ErrorMessage -match "not valid before 2035-01-15 12:00:00 UTC"
) "A certificate was accepted one second before its UTC start time."
Assert-NoSecretOutput -Output "$($beforeStart.Output)`n$($beforeStart.ErrorMessage)" -CertificateBase64 $validFromBoundaryBase64 -Password $password

$nearExpiryBase64 = New-TestCertificateBase64 -NotAfter $testNow.AddDays(30) -Now $testNow
$nearExpiry = Invoke-CertificateCheck -CertificateBase64 $nearExpiryBase64
Assert-True (-not $nearExpiry.ErrorMessage) "A certificate with 30 days remaining was rejected."
Assert-True ($nearExpiry.Output -match "::warning::") "A certificate expiring within 30 days did not produce a warning."
Assert-NoSecretOutput -Output $nearExpiry.Output -CertificateBase64 $nearExpiryBase64 -Password $password
Assert-True ($nearExpiry.Result.HasCertificate) "The valid near-expiry certificate was not accepted."
Assert-True (-not $nearExpiry.Result.IsExpired) "A valid near-expiry certificate was marked expired."
Assert-True ($nearExpiry.Result.RenewalNeeded) "A certificate expiring within 30 days was not marked for renewal."
Assert-True ($nearExpiry.Result.ExpiresAt.ToUniversalTime().ToString("yyyy-MM-dd") -eq "2035-02-14") "The near-expiry certificate expiration date was not returned."
Assert-True (([Convert]::ToBase64String($nearExpiry.Result.CertificateBytes)) -ceq $nearExpiryBase64) "The accepted certificate contents changed."

$validBase64 = New-TestCertificateBase64 -NotAfter $testNow.AddDays(45) -Now $testNow
$valid = Invoke-CertificateCheck -CertificateBase64 $validBase64
Assert-True (-not $valid.ErrorMessage) "A certificate with more than 30 days remaining was rejected."
Assert-True (-not $valid.Output.Contains("::warning::")) "A certificate with more than 30 days remaining produced an expiry warning."
Assert-NoSecretOutput -Output $valid.Output -CertificateBase64 $validBase64 -Password $password
Assert-True ($valid.Result.HasCertificate) "The certificate with more than 30 days remaining was not accepted."
Assert-True (-not $valid.Result.IsExpired) "A valid certificate was marked expired."
Assert-True (-not $valid.Result.RenewalNeeded) "A certificate with more than 30 days remaining was marked for renewal."
Assert-True ($valid.Result.ExpiresAt.ToUniversalTime().ToString("yyyy-MM-dd") -eq "2035-03-01") "The valid certificate expiration date was not returned."
Assert-True (([Convert]::ToBase64String($valid.Result.CertificateBytes)) -ceq $validBase64) "The accepted certificate contents changed."

$badPassword = "wrong-test-password-do-not-print"
$invalidCertificate = Invoke-CertificateCheck -CertificateBase64 $validBase64 -Password $badPassword -SkipTrust
Assert-True ($invalidCertificate.ErrorMessage -match "Unable to read the Windows signing certificate") "An invalid certificate password was not rejected with a safe error."
Assert-True (-not $invalidCertificate.Result) "An unreadable certificate returned expiry information."
Assert-NoSecretOutput -Output "$($invalidCertificate.Output)`n$($invalidCertificate.ErrorMessage)" -CertificateBase64 $validBase64 -Password $badPassword

$malformedBase64 = "not-a-valid-certificate"
$malformedCertificate = Invoke-CertificateCheck `
  -CertificateBase64 $malformedBase64 `
  -Password $password `
  -SkipTrust
Assert-True ($malformedCertificate.ErrorMessage -match "Unable to read the Windows signing certificate") "Malformed certificate data was not rejected with a safe error."
Assert-True (-not $malformedCertificate.Result) "Malformed certificate data returned expiry information."
Assert-NoSecretOutput `
  -Output "$($malformedCertificate.Output)`n$($malformedCertificate.ErrorMessage)" `
  -CertificateBase64 $malformedBase64 `
  -Password $password

$mismatchOutput = @()
$mismatchError = $null
try {
  $mismatchOutput = @(Get-WindowsSigningCertificateInfo -CertificateBase64 $validBase64 -Password "" 6>&1)
} catch {
  $mismatchError = $_.Exception.Message
  $mismatchOutput += $_
}
Assert-True ($mismatchError -match "Set both WINDOWS_CERTIFICATE_BASE64 and WINDOWS_CERTIFICATE_PASSWORD") "A missing certificate password was not rejected."
Assert-NoSecretOutput -Output "$(Convert-OutputToText $mismatchOutput)`n$mismatchError" -CertificateBase64 $validBase64 -Password $password

Write-Host "Passed Windows signing certificate usage, trust, malformed-extension, time-zone, and validity checks."
