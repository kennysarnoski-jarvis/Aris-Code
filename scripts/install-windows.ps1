# Aris Code — Windows installer
# ----------------------------------------------------------------------
# One-shot setup for Windows 10 / 11 via WSL2.
#
# Phase 1 (this script, FIRST run, requires admin):
#   - Verify Windows version (WSL2 needs Win10 2004+ or Win11)
#   - Install WSL2 + Ubuntu distro
#   - Tell you to reboot, then re-run this script
#
# Phase 2 (this script, SECOND run after reboot):
#   - Detect that WSL2 + Ubuntu are now installed
#   - Prompt you to set your Ubuntu username/password (one-time)
#   - Bootstrap install-linux.sh inside Ubuntu, which handles everything
#     else (apt deps, Node 22, Bun, node-gyp, clone, bun install).
#
# Idempotent — safe to re-run. Detects what's already done and skips.
#
# Usage (one-liner, in admin PowerShell):
#   iex (irm https://raw.githubusercontent.com/kennysarnoski-jarvis/Aris-Code/main/scripts/install-windows.ps1)
#
# After this script finishes, launch the app from inside Ubuntu with:
#   cd ~/Aris-Code && bun dev:desktop
#
# (The window will appear on your Windows desktop via WSLg.)

$ErrorActionPreference = "Stop"

# ── Color helpers ───────────────────────────────────────────────────
function Write-Step($msg)  { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Skip($msg)  { Write-Host "    [SKIP] $msg" -ForegroundColor Yellow }
function Write-Warn($msg)  { Write-Host "    [WARN] $msg" -ForegroundColor Yellow }
function Write-Die($msg)   {
    Write-Host "`n[ERROR] $msg`n" -ForegroundColor Red
    exit 1
}

# ── Pre-flight ──────────────────────────────────────────────────────
Write-Step "Pre-flight checks"

# 1) Admin check
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($currentUser)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Die @"
This script must be run as Administrator.
Right-click PowerShell (or Terminal) and choose 'Run as administrator',
then re-run the install command.
"@
}
Write-Ok "Running as Administrator"

# 2) Windows version check (WSL2 requires Win10 2004 / build 19041+ or Win11)
$build = [int](Get-CimInstance Win32_OperatingSystem).BuildNumber
if ($build -lt 19041) {
    Write-Die "WSL2 requires Windows 10 build 19041 or newer. Detected build: $build. Update Windows first."
}
Write-Ok "Windows build $build supports WSL2"

# 3) System clock sanity (cert errors come from drift)
$year = (Get-Date).Year
if ($year -lt 2024 -or $year -gt 2030) {
    Write-Warn "System clock looks off (year=$year). If you see SSL/cert errors below, fix Date & Time first then re-run."
}

# ── Phase detection ─────────────────────────────────────────────────
# We're in Phase 2 (post-reboot, ready to invoke Linux installer) if
# WSL is registered AND Ubuntu is in the distro list. Otherwise Phase 1.
function Test-WslAvailable {
    try {
        $null = wsl.exe --status 2>&1
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

function Test-UbuntuInstalled {
    try {
        $distros = wsl.exe --list --quiet 2>&1
        # The output may have null bytes (UTF-16) — strip them and look for "Ubuntu"
        $clean = ($distros -replace "`0", "")
        return ($clean -match "Ubuntu")
    } catch {
        return $false
    }
}

$wslAvailable = Test-WslAvailable
$ubuntuInstalled = $false
if ($wslAvailable) {
    $ubuntuInstalled = Test-UbuntuInstalled
}

# ── PHASE 1: install WSL2 + Ubuntu ──────────────────────────────────
if (-not $wslAvailable -or -not $ubuntuInstalled) {
    Write-Step "Phase 1 — Installing WSL2 and Ubuntu"

    if (-not $wslAvailable) {
        Write-Host "    Running 'wsl --install' (downloads + enables WSL2 features)..."
        wsl.exe --install --no-launch
        if ($LASTEXITCODE -ne 0) {
            Write-Die "wsl --install failed (exit $LASTEXITCODE). If you saw a cert error, fix your system clock and re-run."
        }
        Write-Ok "WSL2 features enabled"
    } else {
        Write-Skip "WSL2 already installed"
    }

    if (-not $ubuntuInstalled) {
        Write-Host "    Installing Ubuntu distro..."
        wsl.exe --install Ubuntu --no-launch
        if ($LASTEXITCODE -ne 0) {
            Write-Die @"
Ubuntu install failed (exit $LASTEXITCODE).
Try: wsl --list --online    (to see available distros)
Then: wsl --install <DistroName>
"@
        }
        Write-Ok "Ubuntu distro registered"
    } else {
        Write-Skip "Ubuntu already installed"
    }

    # If WSL was newly enabled, a reboot is needed. Detect by checking
    # if the WSL kernel can actually run a command. If it can't, we
    # need a reboot before Phase 2 will work.
    $wslReady = $false
    try {
        $null = wsl.exe -e echo ready 2>&1
        $wslReady = ($LASTEXITCODE -eq 0)
    } catch {
        $wslReady = $false
    }

    if (-not $wslReady) {
        Write-Host ""
        Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Yellow
        Write-Host "  REBOOT REQUIRED" -ForegroundColor Yellow
        Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "  WSL2 was just enabled. Reboot Windows, then re-run this same"
        Write-Host "  install command in a new admin PowerShell:"
        Write-Host ""
        Write-Host "      iex (irm https://raw.githubusercontent.com/kennysarnoski-jarvis/Aris-Code/main/scripts/install-windows.ps1)" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "  After reboot, the script will detect WSL is ready and continue"
        Write-Host "  to Phase 2 automatically."
        Write-Host ""
        exit 0
    }

    Write-Ok "WSL kernel responding — no reboot needed, continuing to Phase 2"
}

# ── PHASE 2: bootstrap install-linux.sh inside Ubuntu ───────────────
Write-Step "Phase 2 — Setting up Aris Code inside Ubuntu"

# Ubuntu's first launch is interactive — it asks for username + password.
# We can't fully automate that (Microsoft's installer prompts the user),
# so we detect whether Ubuntu has a default user yet. If not, we tell
# the user to launch it once and finish first-time setup.
$hasUbuntuUser = $false
try {
    $whoami = wsl.exe -d Ubuntu -e whoami 2>&1
    if ($LASTEXITCODE -eq 0 -and $whoami -and ($whoami -notmatch "root")) {
        $hasUbuntuUser = $true
    }
} catch {
    $hasUbuntuUser = $false
}

if (-not $hasUbuntuUser) {
    Write-Host ""
    Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Yellow
    Write-Host "  ONE-TIME UBUNTU SETUP" -ForegroundColor Yellow
    Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Open Start menu → search for 'Ubuntu' → click the Ubuntu app."
    Write-Host "  It'll ask you to create a Linux username (lowercase, no spaces)"
    Write-Host "  and password. These are independent of your Windows login."
    Write-Host ""
    Write-Host "  After you set those and see a prompt like 'kenny@laptop:~`$',"
    Write-Host "  re-run this PowerShell install command:"
    Write-Host ""
    Write-Host "      iex (irm https://raw.githubusercontent.com/kennysarnoski-jarvis/Aris-Code/main/scripts/install-windows.ps1)" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  It'll detect Ubuntu's ready and finish the installation."
    Write-Host ""
    exit 0
}

Write-Ok "Ubuntu set up with user: $whoami"

# Run the Linux script inside Ubuntu. It handles apt deps, Node 22,
# Bun, node-gyp, repo clone, and bun install.
Write-Host "    Bootstrapping install-linux.sh inside Ubuntu..."
Write-Host "    (This is the long step — ~10-20 min. Apt downloads, Electron"
Write-Host "    binary download, npm install. You'll see all of it stream below.)"
Write-Host ""

$linuxScriptUrl = "https://raw.githubusercontent.com/kennysarnoski-jarvis/Aris-Code/main/scripts/install-linux.sh"

# Use bash -c with a heredoc-style command — curl + pipe to bash inside Ubuntu.
wsl.exe -d Ubuntu -e bash -c "curl -fsSL $linuxScriptUrl | bash"

if ($LASTEXITCODE -ne 0) {
    Write-Die @"
The Linux installer failed inside Ubuntu (exit $LASTEXITCODE).
Scroll up to see which step blew up. Common fixes:
  - Cert/clock errors: fix Windows date & time, re-run.
  - apt 'unable to locate package': run 'wsl -d Ubuntu -- sudo apt update' first.
  - Network: confirm WSL2 has internet ('wsl -d Ubuntu -- curl https://github.com').
"@
}

# ── Done ────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host "  Aris Code is installed and ready to launch" -ForegroundColor Green
Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host ""
Write-Host "  Launch from your Ubuntu terminal (Start menu → Ubuntu):" -ForegroundColor White
Write-Host ""
Write-Host "      cd ~/Aris-Code" -ForegroundColor Cyan
Write-Host "      bun dev:desktop" -ForegroundColor Cyan
Write-Host ""
Write-Host "  The Aris Code window will appear on your Windows desktop via WSLg" -ForegroundColor White
Write-Host "  (the GUI bridge that ships with Windows 11 by default; Win10 users"
Write-Host "  may need to install WSLg manually — see Microsoft's WSL GUI guide)."
Write-Host ""
Write-Host "  Sign in path: open Settings → Aris provider → paste your"
Write-Host "  subscription key from https://youraris.com" -ForegroundColor White
Write-Host ""
