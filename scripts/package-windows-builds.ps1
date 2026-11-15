$ErrorActionPreference = "Stop"
. "$PSScriptRoot/windows-signing-certificate.ps1"

$certificateBase64 = $env:WINDOWS_CERTIFICATE_BASE64
$certificatePassword = $env:WINDOWS_CERTIFICATE_PASSWORD
$certificateInfo = $null
$signingCertificate = $null
$certificatePath = $null
$zipCheckDirectory = Join-Path ([IO.Path]::GetTempPath()) "tt-turnier-zip-signature-check-$([guid]::NewGuid())"
$buildStagingDirectory = Join-Path ([IO.Path]::GetTempPath()) "tt-turnier-windows-build-$([guid]::NewGuid())"
$outputDirectory = "generated-artifacts/tt-turnier-windows"
$outputBackupDirectory = Join-Path ([IO.Path]::GetTempPath()) "tt-turnier-windows-output-backup-$([guid]::NewGuid())"
$outputTransactionStarted = $false

try {
  $certificateInfo = Get-WindowsSigningCertificateInfo `
    -CertificateBase64 $certificateBase64 `
    -Password $certificatePassword

  if ($certificateInfo.HasCertificate) {
    $signingCertificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
      $certificateInfo.CertificateBytes,
      $certificatePassword,
      [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
    )
    $certificatePath = Join-Path ([IO.Path]::GetTempPath()) "tt-turnier-signing-$([guid]::NewGuid()).pfx"
    [IO.File]::WriteAllBytes($certificatePath, $certificateInfo.CertificateBytes)
    $env:CSC_LINK = $certificatePath
    $env:CSC_KEY_PASSWORD = $certificatePassword
    $signingLabel = "signed"
    Write-Host "Signing the Windows app, installer, and ZIP build."
  } else {
    $signingLabel = "unsigned"
    Write-Host "Signing secrets are absent; creating unsigned Windows builds."
  }

  pnpm --filter @workspace/tt-turnier run desktop:windows:installer:package "--config.directories.output=$buildStagingDirectory"
  if ($LASTEXITCODE -ne 0) {
    throw "Windows installer packaging failed with exit code $LASTEXITCODE."
  }

  pnpm --filter @workspace/tt-turnier run desktop:windows:zip:package "--config.directories.output=$buildStagingDirectory"
  if ($LASTEXITCODE -ne 0) {
    throw "Windows ZIP packaging failed with exit code $LASTEXITCODE."
  }

  $installers = @(Get-ChildItem $buildStagingDirectory -Filter "Tischtennis-Turnier-*-x64.exe" -File)
  $zipBuilds = @(Get-ChildItem $buildStagingDirectory -Filter "Tischtennis-Turnier-*-x64.zip" -File)
  if ($installers.Count -ne 1 -or $zipBuilds.Count -ne 1) {
    throw "Expected exactly one Windows installer and ZIP build; found $($installers.Count) installer(s) and $($zipBuilds.Count) ZIP build(s)."
  }

  $installer = $installers[0]
  $zipBuild = $zipBuilds[0]
  $installerName = $installer.BaseName + "-$signingLabel" + $installer.Extension
  $zipBuildName = $zipBuild.BaseName + "-$signingLabel" + $zipBuild.Extension
  Rename-Item -LiteralPath $installer.FullName -NewName $installerName
  Rename-Item -LiteralPath $zipBuild.FullName -NewName $zipBuildName

  if ($certificateInfo.HasCertificate) {
    if ($installerName -notmatch "-signed\.exe$" -or $zipBuildName -notmatch "-signed\.zip$") {
      throw "Signed Windows builds do not have the expected signed labels."
    }
  } elseif ($installerName -notmatch "-unsigned\.exe$" -or $zipBuildName -notmatch "-unsigned\.zip$") {
    throw "Unsigned Windows builds do not have the expected unsigned labels."
  }

  $installerPath = Join-Path $buildStagingDirectory $installerName
  $installerHash = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText(
    "$installerPath.sha256",
    "$installerHash  $([IO.Path]::GetFileName($installerPath))`n",
    [Text.Encoding]::ASCII
  )
  Write-Host "Created SHA-256 checksum for $installerName."

  $zipBuildPath = Join-Path $buildStagingDirectory $zipBuildName
  $zipHash = (Get-FileHash -LiteralPath $zipBuildPath -Algorithm SHA256).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText(
    "$zipBuildPath.sha256",
    "$zipHash  $([IO.Path]::GetFileName($zipBuildPath))`n",
    [Text.Encoding]::ASCII
  )
  Write-Host "Created SHA-256 checksum for $zipBuildName."

  $installerSignature = Get-AuthenticodeSignature -FilePath $installerPath
  if ($certificateInfo.HasCertificate) {
    if ($installerSignature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
      throw "The Windows installer is not validly signed: $($installerSignature.StatusMessage)"
    }
    if (-not $installerSignature.SignerCertificate -or $installerSignature.SignerCertificate.Thumbprint -ne $signingCertificate.Thumbprint) {
      throw "The Windows installer is not signed by the configured publisher certificate."
    }
    if (-not $installerSignature.TimeStamperCertificate) {
      throw "The Windows installer does not have a trusted timestamp."
    }
    Write-Host "Verified installer signature for publisher certificate $($signingCertificate.Thumbprint)."
  } elseif ($installerSignature.Status -ne [System.Management.Automation.SignatureStatus]::NotSigned) {
    throw "Expected an unsigned Windows installer, found signature status $($installerSignature.Status)."
  } else {
    Write-Host "Verified the unsigned Windows installer."
  }

  New-Item -ItemType Directory -Path $zipCheckDirectory | Out-Null
  [System.IO.Compression.ZipFile]::ExtractToDirectory($zipBuildPath, $zipCheckDirectory)
  $zipExecutables = @(
    Get-ChildItem $zipCheckDirectory -File -Recurse |
      Where-Object { $_.Extension -ieq ".exe" }
  )
  $appExecutables = @($zipExecutables | Where-Object { $_.Name -ieq "Tischtennis-Turnier.exe" })
  if ($appExecutables.Count -ne 1) {
    throw "Expected exactly one Tischtennis-Turnier.exe in the Windows ZIP; found $($appExecutables.Count)."
  }
  if ($zipExecutables.Count -eq 0) {
    throw "Expected at least one executable in the Windows ZIP."
  }

  foreach ($zipExecutable in $zipExecutables) {
    $appSignature = Get-AuthenticodeSignature -FilePath $zipExecutable.FullName
    if ($certificateInfo.HasCertificate) {
      if ($appSignature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        throw "The executable '$($zipExecutable.Name)' inside the Windows ZIP is not validly signed: $($appSignature.StatusMessage)"
      }
      if (-not $appSignature.SignerCertificate -or $appSignature.SignerCertificate.Thumbprint -ne $signingCertificate.Thumbprint) {
        throw "The executable '$($zipExecutable.Name)' inside the Windows ZIP is not signed by the configured publisher certificate."
      }
      if (-not $appSignature.TimeStamperCertificate) {
        throw "The executable '$($zipExecutable.Name)' inside the Windows ZIP does not have a trusted timestamp."
      }
      Write-Host "Verified ZIP executable signature and trusted timestamp for $($zipExecutable.Name)."
    } elseif ($appSignature.Status -ne [System.Management.Automation.SignatureStatus]::NotSigned) {
      throw "Expected an unsigned executable inside the Windows ZIP, found signature status $($appSignature.Status)."
    } else {
      Write-Host "Verified the unsigned ZIP executable $($zipExecutable.Name)."
    }
  }

  $buildFiles = @(
    $installerPath
    "$installerPath.sha256"
    $zipBuildPath
    "$zipBuildPath.sha256"
  )
  New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
  New-Item -ItemType Directory -Path $outputBackupDirectory -Force | Out-Null
  $staleBuildFiles = @(
    Get-ChildItem -LiteralPath $outputDirectory -File |
      Where-Object {
        $_.Name -match '^Tischtennis-Turnier-.+-x64(?:-(?:signed|unsigned))?\.(?:exe|zip)(?:\.sha256)?$'
      }
  )

  foreach ($staleBuildFile in $staleBuildFiles) {
    Copy-Item -LiteralPath $staleBuildFile.FullName -Destination $outputBackupDirectory
  }

  $outputTransactionStarted = $true
  foreach ($staleBuildFile in $staleBuildFiles) {
    Remove-Item -LiteralPath $staleBuildFile.FullName -Force
  }
  foreach ($buildFile in $buildFiles) {
    $publishedPath = Join-Path $outputDirectory (Split-Path -Leaf $buildFile)
    Move-Item -LiteralPath $buildFile -Destination $publishedPath
  }
} catch {
  $publicationError = $_
  if ($outputTransactionStarted -and (Test-Path -LiteralPath $outputDirectory)) {
    try {
      $partialBuildFiles = @(
        Get-ChildItem -LiteralPath $outputDirectory -File |
          Where-Object {
            $_.Name -match '^Tischtennis-Turnier-.+-x64(?:-(?:signed|unsigned))?\.(?:exe|zip)(?:\.sha256)?$'
          }
      )
      foreach ($partialBuildFile in $partialBuildFiles) {
        Remove-Item -LiteralPath $partialBuildFile.FullName -Force
      }
      if (Test-Path -LiteralPath $outputBackupDirectory) {
        Get-ChildItem -LiteralPath $outputBackupDirectory -File |
          ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination $outputDirectory -Force
          }
      }
    } catch {
      throw "Windows build publication failed: $($publicationError.Exception.Message) Previous assets could not be fully restored: $($_.Exception.Message)"
    }
  }
  throw $publicationError
} finally {
  if ($signingCertificate) {
    $signingCertificate.Dispose()
  }
  if ($certificatePath -and (Test-Path -LiteralPath $certificatePath)) {
    Remove-Item -LiteralPath $certificatePath -Force
  }
  if (Test-Path -LiteralPath $zipCheckDirectory) {
    Remove-Item -LiteralPath $zipCheckDirectory -Recurse -Force
  }
  if (Test-Path -LiteralPath $buildStagingDirectory) {
    Remove-Item -LiteralPath $buildStagingDirectory -Recurse -Force
  }
  if (Test-Path -LiteralPath $outputBackupDirectory) {
    Remove-Item -LiteralPath $outputBackupDirectory -Recurse -Force
  }
  if ($certificateInfo.CertificateBytes) {
    [Array]::Clear($certificateInfo.CertificateBytes, 0, $certificateInfo.CertificateBytes.Length)
  }
  $certificateBase64 = $null
  $certificatePassword = $null
  Remove-Item Env:WINDOWS_CERTIFICATE_BASE64 -ErrorAction SilentlyContinue
  Remove-Item Env:WINDOWS_CERTIFICATE_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:CSC_LINK -ErrorAction SilentlyContinue
  Remove-Item Env:CSC_KEY_PASSWORD -ErrorAction SilentlyContinue
}
