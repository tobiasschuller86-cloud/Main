$ErrorActionPreference = "Stop"

# Load only the assertion functions, not the packaging or trust-store setup.
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(
  (Join-Path $PSScriptRoot "test-signed-windows-packaging.ps1"),
  [ref]$tokens,
  [ref]$parseErrors
)
if ($parseErrors.Count) { throw "Unable to parse signed Windows assertion functions." }
foreach ($name in @("Assert-True", "Assert-TrustedSignedOutput", "Assert-NoCertificateMaterialInOutput")) {
  $definition = $ast.Find({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
  }, $false)
  if (-not $definition) { throw "Missing signed Windows assertion function: $name" }
  . ([scriptblock]::Create($definition.Extent.Text))
}

function Assert-Rejected {
  param([scriptblock]$Action, [string]$ExpectedMessage)
  $rejected = $false
  try {
    & $Action
  } catch {
    $rejected = $_.Exception.Message -match $ExpectedMessage
  }
  if (-not $rejected) { throw "Signed output guard failed to reject invalid input with the expected reason." }
}

function Get-AuthenticodeSignature { return $script:testSignature }

$key = [Security.Cryptography.RSA]::Create(2048)
$certificate = $null
try {
  $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
    "CN=Signed Output Assertion Test", $key,
    [Security.Cryptography.HashAlgorithmName]::SHA256,
    [Security.Cryptography.RSASignaturePadding]::Pkcs1
  )
  $certificate = $request.CreateSelfSigned(
    [datetimeoffset]::UtcNow.AddDays(-1), [datetimeoffset]::UtcNow.AddDays(1)
  )
  $script:testSignature = [pscustomobject]@{
    Status = [Management.Automation.SignatureStatus]::Valid
    SignerCertificate = $certificate
    TimeStamperCertificate = $certificate
  }
  # A real certificate object must not be passed directly to a [bool] parameter.
  Assert-TrustedSignedOutput -Path "synthetic.exe" -ExpectedThumbprint $certificate.Thumbprint -Description "Test file"
  $script:testSignature.TimeStamperCertificate = $null
  Assert-Rejected {
    Assert-TrustedSignedOutput -Path "synthetic.exe" -ExpectedThumbprint $certificate.Thumbprint -Description "Test file"
  } "does not have a trusted timestamp"
  $script:testSignature.TimeStamperCertificate = $certificate
  Assert-Rejected {
    Assert-TrustedSignedOutput -Path "synthetic.exe" -ExpectedThumbprint "wrong-publisher" -Description "Test file"
  } "does not match the temporary test publisher"
  $script:testSignature.Status = [Management.Automation.SignatureStatus]::NotSigned
  Assert-Rejected {
    Assert-TrustedSignedOutput -Path "synthetic.exe" -ExpectedThumbprint $certificate.Thumbprint -Description "Test file"
  } "does not have a valid signature"

  foreach ($output in @("synthetic-cert-sentinel", "synthetic-password-sentinel")) {
    Assert-Rejected {
      Assert-NoCertificateMaterialInOutput -Output $output `
        -CertificateBase64 "synthetic-cert-sentinel" -Password "synthetic-password-sentinel"
    } "attempted to print temporary certificate material"
  }
  Assert-NoCertificateMaterialInOutput -Output "Safe diagnostic message" `
    -CertificateBase64 "synthetic-cert-sentinel" -Password "synthetic-password-sentinel"
  Write-Host "Verified signed-output guards accept certificate objects and reject missing timestamps, wrong publishers, unsigned files, and secret output."
} finally {
  Remove-Item function:Get-AuthenticodeSignature -ErrorAction SilentlyContinue
  Remove-Variable testSignature -Scope Script -ErrorAction SilentlyContinue
  if ($certificate) { $certificate.Dispose() }
  $key.Dispose()
}
