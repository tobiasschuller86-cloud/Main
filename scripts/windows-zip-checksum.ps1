function Test-WindowsZipChecksum {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ZipPath
  )

  if (-not (Test-Path -LiteralPath $ZipPath -PathType Leaf)) {
    throw "The downloaded Windows ZIP is missing."
  }

  $zipBuild = Get-Item -LiteralPath $ZipPath
  $checksumPath = "$($zipBuild.FullName).sha256"
  if (-not (Test-Path -LiteralPath $checksumPath -PathType Leaf)) {
    throw "The downloaded Windows ZIP checksum is missing."
  }

  $checksumLine = [IO.File]::ReadAllText($checksumPath)
  if ($checksumLine -notmatch '\A([0-9a-fA-F]{64})  ([^\r\n]+)(?:\r?\n)?\z') {
    throw "The downloaded Windows ZIP checksum has an invalid format."
  }
  $checksumHash = $Matches[1]
  $checksumFileName = $Matches[2]
  if ($checksumFileName -cne $zipBuild.Name) {
    throw "The downloaded Windows ZIP checksum names a different file."
  }

  $actualHash = (Get-FileHash -LiteralPath $zipBuild.FullName -Algorithm SHA256).Hash
  if ($checksumHash -ine $actualHash) {
    throw "The downloaded Windows ZIP does not match its SHA-256 checksum."
  }

  Write-Host "Verified SHA-256 checksum for $($zipBuild.Name)."
}
