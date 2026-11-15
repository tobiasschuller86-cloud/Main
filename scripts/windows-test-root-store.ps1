# Test infrastructure only. Never dot-source this file from production packaging.
function Open-WindowsTestRootStore {
  $location = [System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser
  if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
      $principal = [Security.Principal.WindowsPrincipal]::new($identity)
      if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Windows certificate tests require an elevated temporary test runner; refusing an interactive CurrentUser Root import."
      }
    } finally {
      $identity.Dispose()
    }
    # CurrentUser Root can show a modal confirmation dialog, even in CI.
    # LocalMachine requires elevation but does not show that per-user prompt.
    $location = [System.Security.Cryptography.X509Certificates.StoreLocation]::LocalMachine
  }
  Write-Host "Opening temporary test root store ($location); test cleanup removes the added certificate."
  $store = [System.Security.Cryptography.X509Certificates.X509Store]::new(
    [System.Security.Cryptography.X509Certificates.StoreName]::Root,
    $location
  )
  try {
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    return $store
  } catch {
    $store.Dispose()
    throw
  }
}
