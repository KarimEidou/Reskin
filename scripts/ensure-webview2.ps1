# Makes sure the Evergreen WebView2 Runtime is installed (CI runners and
# fresh VMs). The Reskin installer itself uses the silent download
# bootstrapper, so end users don't need this script.
$ErrorActionPreference = 'Stop'
$guid = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$keys = @(
  "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$guid",
  "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$guid",
  "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$guid"
)
foreach ($k in $keys) {
  $pv = (Get-ItemProperty -Path $k -Name pv -ErrorAction SilentlyContinue).pv
  if ($pv -and $pv -ne '0.0.0.0') {
    Write-Host "WebView2 Runtime $pv is installed ($k)"
    exit 0
  }
}
Write-Host 'WebView2 Runtime not found; installing the Evergreen bootstrapper...'
$bootstrapper = Join-Path $env:TEMP 'MicrosoftEdgeWebview2Setup.exe'
Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $bootstrapper
$p = Start-Process -FilePath $bootstrapper -ArgumentList '/silent', '/install' -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "WebView2 bootstrapper failed with exit code $($p.ExitCode)" }
Write-Host 'WebView2 Runtime installed.'
