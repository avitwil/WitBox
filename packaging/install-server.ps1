# WitBox server on Windows (experimental) — created by Avi Twil.  https://witbox.avitwil.io
#
# The WitBox server is a Linux program. On Windows it runs inside WSL2 (Windows Subsystem for Linux):
# this script installs WSL2 + Ubuntu 24.04 if needed, then runs the normal Linux installer inside it.
# The Windows app (WitBox.exe) is only a client; it connects to the server over your Tailscale network.
#
# Requirements: Windows 11 (or Windows 10 22H2), virtualization enabled in the BIOS, 16 GB RAM recommended.
# Run from the folder that also holds install.sh and witbox-linux-x86_64.tar.gz:
#     powershell -ExecutionPolicy Bypass -File install-server.ps1
param([string]$Distro = 'Ubuntu-24.04', [string]$LinuxUser = 'witbox')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
function Say($t)  { Write-Host "==> $t" -ForegroundColor Cyan }
function Warn($t) { Write-Host "  ! $t" -ForegroundColor Yellow }

# --- administrator rights (needed once, to enable WSL and register the keep-alive task)
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Say 'Asking for administrator rights...'
  Start-Process powershell -Verb RunAs -ArgumentList "-NoExit -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`" -Distro $Distro -LinuxUser $LinuxUser"
  exit
}
foreach ($f in 'install.sh', 'witbox-linux-x86_64.tar.gz') { if (-not (Test-Path (Join-Path $here $f))) { throw "$f must be in the same folder as this script ($here)." } }

# --- 1. WSL2
Say '1/5  WSL2'
$null = & wsl.exe --status 2>&1
if ($LASTEXITCODE -ne 0) {
  & wsl.exe --install --no-distribution
  Warn 'WSL was just enabled. RESTART Windows, then run this script again.'
  Read-Host 'Press Enter to close'; exit
}
& wsl.exe --update | Out-Null
& wsl.exe --set-default-version 2 | Out-Null

# --- 2. Ubuntu
Say "2/5  $Distro"
$env:WSL_UTF8 = '1'
$have = (& wsl.exe -l -q) -replace "`0", '' | Where-Object { $_.Trim() -eq $Distro }
if (-not $have) {
  & wsl.exe --install -d $Distro --no-launch
  if ($LASTEXITCODE -ne 0) { throw "Could not install $Distro. Install it from the Microsoft Store and run this script again." }
}
# a dedicated Linux user with sudo, and systemd (WitBox and Tailscale run as services)
$setup = @"
set -e
id $LinuxUser >/dev/null 2>&1 || useradd -m -s /bin/bash -G sudo $LinuxUser
echo '$LinuxUser ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-$LinuxUser; chmod 440 /etc/sudoers.d/90-$LinuxUser
printf '[boot]\nsystemd=true\n[user]\ndefault=$LinuxUser\n[network]\nhostname=witbox\ngenerateHosts=true\n' > /etc/wsl.conf
"@
$setup -replace "`r", '' | & wsl.exe -d $Distro -u root -- bash -s
if ($LASTEXITCODE -ne 0) { throw 'Could not prepare the Linux user inside WSL.' }
& wsl.exe --terminate $Distro | Out-Null
Start-Sleep -Seconds 3

# --- 3. nested virtualization (for the bots' shared computer) — on by default in Windows 11
Say '3/5  Virtualization for the bots'' shared computer'
$kvm = (& wsl.exe -d $Distro -u root -- bash -c 'test -e /dev/kvm && echo yes || echo no').Trim()
if ($kvm -ne 'yes') { Warn 'No /dev/kvm inside WSL (needs Windows 11 and a CPU with nested virtualization). WitBox will be installed without the bots'' shared computer.' }

# --- 4. the Linux installer
Say '4/5  Installing WitBox inside WSL (answer the questions below; links for Claude and Tailscale sign-in will appear)'
$wslHere = (& wsl.exe -d $Distro -u $LinuxUser -- wslpath -a "$here").Trim()
& wsl.exe -d $Distro -u $LinuxUser -- bash -lc "mkdir -p ~/witbox-setup && cp '$wslHere/install.sh' '$wslHere/witbox-linux-x86_64.tar.gz' ~/witbox-setup/ && sed -i 's/\r$//' ~/witbox-setup/install.sh && chmod +x ~/witbox-setup/install.sh && cd ~/witbox-setup && ./install.sh"
if ($LASTEXITCODE -ne 0) { Warn 'The Linux installer reported a problem (see above). You can run it again any time with this script.' }

# --- 5. keep WSL (and so WitBox) running whenever you are signed in to Windows
Say '5/5  Start WitBox with Windows'
$action  = New-ScheduledTaskAction -Execute 'wsl.exe' -Argument "-d $Distro --exec sleep infinity"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$set     = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden
Register-ScheduledTask -TaskName 'WitBox server (WSL)' -Action $action -Trigger $trigger -Settings $set -Force | Out-Null
Start-ScheduledTask -TaskName 'WitBox server (WSL)'

$url = (& wsl.exe -d $Distro -u $LinuxUser -- bash -lc 'witbox url 2>/dev/null').Trim()
Write-Host ''
Write-Host "WitBox is installed. Open the WitBox app and enter this address:  $url" -ForegroundColor Green
Write-Host 'This PC must also be connected to the same Tailscale network (install Tailscale for Windows and sign in).'
Write-Host "Manage the server:  wsl -d $Distro -- witbox status"
Read-Host 'Press Enter to close'
