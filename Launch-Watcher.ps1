param([switch]$Setup)
$ErrorActionPreference = 'Stop'
$taskStatePath = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data\Local State'
if (!(Test-Path -LiteralPath $taskStatePath)) { throw 'Chrome profile data was not found.' }
$taskState = Get-Content -Raw -LiteralPath $taskStatePath | ConvertFrom-Json
$taskEmailPath = Join-Path $PSScriptRoot 'profile-email.txt'
if (!(Test-Path -LiteralPath $taskEmailPath)) { throw "Create $taskEmailPath containing the email of your Chrome profile." }
$taskEmail = (Get-Content -Raw -LiteralPath $taskEmailPath).Trim()
$taskProfile = $taskState.profile.info_cache.PSObject.Properties | Where-Object { $_.Value.user_name -ieq $taskEmail } | Select-Object -First 1
if (!$taskProfile) { throw "Could not find Chrome profile $taskEmail. Open that profile in Chrome first." }
$taskChromePaths = @(
  (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
  (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
)
$taskChrome = $taskChromePaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (!$taskChrome) { throw 'Google Chrome executable was not found.' }
$taskUrl = 'https://arizonaoutdoorsclub.com/trip-signup/?event_id=6421#aoc-watch-start'
if ($Setup) {
  $taskUrl = 'chrome://extensions/'
  $taskExtension = Join-Path $PSScriptRoot 'extension'
  Set-Clipboard -Value $taskExtension
  Write-Host "Extension folder copied to clipboard: $taskExtension"
  Write-Host 'In Chrome: enable Developer mode, click Load unpacked, and paste the folder path.'
}
# Chrome forwards this invocation to the existing browser for this user-data directory.
# No temporary profile, debugging mode, or credential handling is used.
Start-Process -FilePath $taskChrome -ArgumentList @("--profile-directory=`"$($taskProfile.Name)`"", $taskUrl)
Write-Host "Opened Chrome profile: $($taskProfile.Value.name) ($($taskProfile.Value.user_name))"
