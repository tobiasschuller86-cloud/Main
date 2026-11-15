function Get-WindowsSigningConfigurationStatus {
  [CmdletBinding()]
  param(
    [AllowNull()]
    [string]$CertificateBase64,

    [AllowNull()]
    [string]$Password
  )

  $missingSecrets = @()
  if ([string]::IsNullOrWhiteSpace($CertificateBase64)) {
    $missingSecrets += "WINDOWS_CERTIFICATE_BASE64"
  }
  if ([string]::IsNullOrWhiteSpace($Password)) {
    $missingSecrets += "WINDOWS_CERTIFICATE_PASSWORD"
  }

  return [pscustomobject]@{
    IsConfigured = ($missingSecrets.Count -eq 0)
    MissingSecrets = $missingSecrets
  }
}

function Get-WindowsSigningCertificateInfo {
  [CmdletBinding()]
  param(
    [AllowNull()]
    [string]$CertificateBase64,

    [AllowNull()]
    [string]$Password,

    [datetime]$NowUtc = [datetime]::UtcNow,

    [switch]$AllowExpired
  )

  $hasCertificate = -not [string]::IsNullOrWhiteSpace($CertificateBase64)
  $hasPassword = -not [string]::IsNullOrWhiteSpace($Password)
  if ($hasCertificate -ne $hasPassword) {
    throw "Set both WINDOWS_CERTIFICATE_BASE64 and WINDOWS_CERTIFICATE_PASSWORD secrets to enable signing."
  }

  if (-not $hasCertificate) {
    return [pscustomobject]@{
      HasCertificate = $false
      CertificateBytes = $null
    }
  }

  $certificateBytes = $null
  $certificateCollection = $null
  $signingCertificate = $null
  $chain = $null
  $accepted = $false
  try {
    try {
      $certificateBytes = [Convert]::FromBase64String($CertificateBase64)
      $certificateCollection = [System.Security.Cryptography.X509Certificates.X509Certificate2Collection]::new()
      $certificateCollection.Import(
        $certificateBytes,
        $Password,
        [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
      )
      if ($certificateCollection.Count -eq 0) {
        throw "The certificate package contains no certificates."
      }
    } catch {
      throw "Unable to read the Windows signing certificate. Verify the certificate data and password secrets."
    }

    $privateKeyCertificates = @($certificateCollection | Where-Object { $_.HasPrivateKey })
    if ($privateKeyCertificates.Count -gt 1) {
      throw "The Windows signing certificate package contains multiple private keys. Use a PFX with one publisher signing certificate and its public issuer certificates."
    }
    if ($privateKeyCertificates.Count -eq 1) {
      $signingCertificate = $privateKeyCertificates[0]
    } else {
      $signingCertificate = $certificateCollection[0]
    }

    $hasPrivateKey = $signingCertificate.HasPrivateKey
    $startsAt = $signingCertificate.NotBefore.ToUniversalTime()
    $expiresAt = $signingCertificate.NotAfter.ToUniversalTime()

    if (-not $hasPrivateKey) {
      throw "The Windows signing certificate does not contain its private signing key. Use a PFX certificate that includes the private key before packaging."
    }

    $basicConstraintsExtensions = @(
      $signingCertificate.Extensions | Where-Object { $_.Oid.Value -eq "2.5.29.19" }
    )
    if ($basicConstraintsExtensions.Count -gt 1) {
      throw "The Windows signing certificate contains duplicate Basic Constraints extensions. Reissue it with one valid end-entity certificate extension set."
    }
    if ($basicConstraintsExtensions.Count -eq 1) {
      try {
        $basicConstraints = [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new(
          $basicConstraintsExtensions[0],
          $basicConstraintsExtensions[0].Critical
        )
      } catch {
        throw "The Windows signing certificate has a malformed Basic Constraints extension. Reissue it as a valid end-entity publisher certificate."
      }
      if ($basicConstraints.CertificateAuthority) {
        throw "The Windows signing certificate is a certificate authority, not an end-entity publisher certificate. Use a code-signing publisher certificate before packaging."
      }
    }

    $enhancedKeyUsageExtensions = @(
      $signingCertificate.Extensions | Where-Object { $_.Oid.Value -eq "2.5.29.37" }
    )
    if ($enhancedKeyUsageExtensions.Count -gt 1) {
      throw "The Windows signing certificate contains duplicate Enhanced Key Usage extensions. Reissue it with one valid Code Signing purpose."
    }
    if ($enhancedKeyUsageExtensions.Count -eq 1) {
      try {
        $ekuReader = [System.Formats.Asn1.AsnReader]::new(
          $enhancedKeyUsageExtensions[0].RawData,
          [System.Formats.Asn1.AsnEncodingRules]::DER
        )
        $ekuSequence = $ekuReader.ReadSequence()
        $ekuPurposeCount = 0
        while ($ekuSequence.HasData) {
          [void]$ekuSequence.ReadObjectIdentifier()
          $ekuPurposeCount++
        }
        $ekuSequence.ThrowIfNotEmpty()
        $ekuReader.ThrowIfNotEmpty()
        if ($ekuPurposeCount -eq 0) {
          throw "The Enhanced Key Usage sequence is empty."
        }
        $enhancedKeyUsage = [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new(
          $enhancedKeyUsageExtensions[0],
          $enhancedKeyUsageExtensions[0].Critical
        )
        $allowsCodeSigning = $false
        foreach ($purpose in $enhancedKeyUsage.EnhancedKeyUsages) {
          if ($purpose.Value -eq "1.3.6.1.5.5.7.3.3") {
            $allowsCodeSigning = $true
            break
          }
        }
      } catch {
        throw "The Windows signing certificate has a malformed Enhanced Key Usage extension. Reissue it with Code Signing (1.3.6.1.5.5.7.3.3) included."
      }
      if (-not $allowsCodeSigning) {
        throw "The Windows signing certificate is not approved for code signing. Use a certificate whose Enhanced Key Usage includes Code Signing (1.3.6.1.5.5.7.3.3) before packaging."
      }
    }

    $keyUsageExtensions = @(
      $signingCertificate.Extensions | Where-Object { $_.Oid.Value -eq "2.5.29.15" }
    )
    if ($keyUsageExtensions.Count -gt 1) {
      throw "The Windows signing certificate contains duplicate Key Usage extensions. Reissue it with one valid Digital Signature permission."
    }
    if ($keyUsageExtensions.Count -eq 1) {
      try {
        $keyUsageReader = [System.Formats.Asn1.AsnReader]::new(
          $keyUsageExtensions[0].RawData,
          [System.Formats.Asn1.AsnEncodingRules]::DER
        )
        $unusedBitCount = 0
        $keyUsageBits = $keyUsageReader.ReadBitString([ref]$unusedBitCount)
        $keyUsageReader.ThrowIfNotEmpty()
        $keyUsageBitCount = ($keyUsageBits.Length * 8) - $unusedBitCount
        if ($keyUsageBitCount -lt 1 -or $keyUsageBitCount -gt 9) {
          throw "The Key Usage bit string has an invalid length."
        }
        $keyUsage = [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
          $keyUsageExtensions[0],
          $keyUsageExtensions[0].Critical
        )
        $allowsDigitalSignature = (
          ($keyUsage.KeyUsages -band [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature) -ne 0
        )
      } catch {
        throw "The Windows signing certificate has a malformed Key Usage extension. Reissue it with Digital Signature enabled."
      }
      if (-not $allowsDigitalSignature) {
        throw "The Windows signing certificate does not allow digital signatures. Use a certificate whose Key Usage includes Digital Signature before packaging."
      }
    }

    # X509Certificate2 exposes validity dates in the process-local time zone.
    # Convert them back to UTC before comparing with the injected UTC instant.
    $now = switch ($NowUtc.Kind) {
      ([DateTimeKind]::Utc) { $NowUtc }
      ([DateTimeKind]::Local) { $NowUtc.ToUniversalTime() }
      default { [datetime]::SpecifyKind($NowUtc, [DateTimeKind]::Utc) }
    }
    if ($startsAt -gt $now) {
      throw "The Windows signing certificate is not valid before $($startsAt.ToString('yyyy-MM-dd HH:mm:ss')) UTC. Use a certificate that is currently valid before packaging."
    }

    $isExpired = $expiresAt -le $now
    if ($isExpired -and -not $AllowExpired) {
      throw "The Windows signing certificate expired on $($expiresAt.ToString('yyyy-MM-dd')) UTC. Renew it before packaging."
    }

    $chain = [System.Security.Cryptography.X509Certificates.X509Chain]::new()
    $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
    $chain.ChainPolicy.VerificationFlags = [System.Security.Cryptography.X509Certificates.X509VerificationFlags]::NoFlag
    $chain.ChainPolicy.VerificationTime = $now
    [void]$chain.ChainPolicy.ApplicationPolicy.Add(
      [System.Security.Cryptography.Oid]::new("1.3.6.1.5.5.7.3.3")
    )
    foreach ($candidate in $certificateCollection) {
      if ($candidate.Thumbprint -ne $signingCertificate.Thumbprint) {
        [void]$chain.ChainPolicy.ExtraStore.Add($candidate)
      }
    }
    $chainBuilt = $false
    try {
      $chainBuilt = $chain.Build($signingCertificate)
    } catch {
      throw "The Windows signing certificate chain could not be validated. Use a publisher certificate issued by a trusted code-signing authority and include its intermediate certificates."
    }

    $chainProblems = @()
    $ignoredExpiredLeafStatusCount = 0
    foreach ($element in $chain.ChainElements) {
      foreach ($status in $element.ChainElementStatus) {
        $isAllowedExpiredLeaf = (
          $AllowExpired -and
          $isExpired -and
          $element.Certificate.Thumbprint -eq $signingCertificate.Thumbprint -and
          $status.Status -eq [System.Security.Cryptography.X509Certificates.X509ChainStatusFlags]::NotTimeValid
        )
        if ($isAllowedExpiredLeaf) {
          $ignoredExpiredLeafStatusCount++
        } else {
          $chainProblems += $status.Status
        }
      }
    }
    if (-not $chainBuilt -and $chainProblems.Count -eq 0 -and $ignoredExpiredLeafStatusCount -eq 0) {
      $chainProblems += "UnknownChainError"
    }
    if ($chainProblems.Count -gt 0) {
      throw "The Windows signing certificate chain is not trusted. Use a publisher certificate issued by a trusted code-signing authority and include its intermediate certificates."
    }

    if (-not $isExpired -and ($expiresAt - $now).TotalDays -le 30) {
      Write-Host "::warning::The Windows signing certificate expires on $($expiresAt.ToString('yyyy-MM-dd')) UTC. Renew it before the next release."
    }

    $accepted = $true
    return [pscustomobject]@{
      HasCertificate = $true
      CertificateBytes = $certificateBytes
      ExpiresAt = $expiresAt
      IsExpired = $isExpired
      RenewalNeeded = (-not $isExpired -and ($expiresAt - $now).TotalDays -le 30)
    }
  } finally {
    if ($chain) {
      $chain.Dispose()
    }
    if ($certificateCollection) {
      foreach ($certificate in $certificateCollection) {
        $certificate.Dispose()
      }
    }
    if (-not $accepted -and $certificateBytes) {
      [Array]::Clear($certificateBytes, 0, $certificateBytes.Length)
    }
  }
}
