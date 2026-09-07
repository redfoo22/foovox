# Foovox installer — Windows.
#
#   irm https://raw.githubusercontent.com/redfoo22/foovox/main/install.ps1 | iex
#
# Installs into %USERPROFILE%\.foovox, checks what is missing, and names the
# exact command for anything it cannot do itself. It deliberately does not
# install Claude Code or sign you in — that is an account decision, and a
# script you piped from the internet should not be making it for you.

$ErrorActionPreference = 'Stop'

$Repo = if ($env:FOOVOX_REPO) { $env:FOOVOX_REPO } else { 'https://github.com/redfoo22/foovox.git' }
$Dir  = if ($env:FOOVOX_DIR)  { $env:FOOVOX_DIR }  else { Join-Path $env:USERPROFILE '.foovox' }

function Bold($t) { Write-Host $t -ForegroundColor White }
function Ok($t)   { Write-Host "  [ok] $t" -ForegroundColor Green }
function Bad($t)  { Write-Host "  [--] $t" -ForegroundColor Red }
function Info($t) { Write-Host "  $t" -ForegroundColor DarkGray }

Write-Host ''
Bold 'Foovox - talk to Claude Code out loud, from your phone'
Write-Host ''

$missing = 0
function Need($cmd, $fix) {
    if (Get-Command $cmd -ErrorAction SilentlyContinue) { Ok $cmd }
    else { Bad "$cmd missing - $fix"; $script:missing = 1 }
}

Need 'git'    'winget install Git.Git'
Need 'node'   'winget install OpenJS.NodeJS.LTS'
Need 'python' 'winget install Python.Python.3.12'

# Read the version from `node --version` and parse it here, rather than asking
# node to parse it and print the answer.
#
# The obvious spelling, `node -p 'process.versions.node.split(".")[0]'`, does
# not survive PowerShell: it strips the inner double quotes before node ever
# sees them, so node receives `split(.)`, throws a SyntaxError, and the result
# casts to 0. Every Windows machine was then told "Node 0 is too old; 20+
# required" and the install stopped — on machines with a perfectly good Node.
# The same line is fine in install.sh, because single quotes in bash keep the
# double quotes intact, which is exactly why it was not noticed.
if (Get-Command node -ErrorAction SilentlyContinue) {
    $raw = (node --version) -replace '^v', ''      # "v22.23.1" -> "22.23.1"
    $major = 0
    [void][int]::TryParse($raw.Split('.')[0], [ref]$major)
    if ($major -lt 20) { Bad "Node $raw is too old; 20+ required"; $missing = 1 }
    else { Info "Node $raw" }
}

# ffmpeg is not optional: replies are sent as mp3, and without an encoder every
# reply is 16x larger and arrives slower than it can be spoken.
if (Get-Command ffmpeg -ErrorAction SilentlyContinue) { Ok 'ffmpeg' }
else { Bad 'ffmpeg missing - winget install Gyan.FFmpeg'; $missing = 1 }

$claude = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
if ((Get-Command claude -ErrorAction SilentlyContinue) -or (Test-Path $claude)) { Ok 'Claude Code' }
else { Bad 'Claude Code missing - install from https://claude.com/claude-code'; $missing = 1 }

if ($missing -ne 0) {
    Write-Host ''
    Bold 'Install the missing pieces above, then run this again.'
    exit 1
}

Write-Host ''
if (Test-Path (Join-Path $Dir '.git')) {
    Bold "Updating $Dir"
    git -C $Dir pull --ff-only
} else {
    Bold "Cloning into $Dir"
    git clone --depth 1 $Repo $Dir
}

Set-Location $Dir

Write-Host ''
Bold 'Installing dependencies and speech models'
Info 'First run downloads about 350 MB of speech models. This takes a few minutes.'
node bin\foovox.mjs install
if ($LASTEXITCODE -ne 0) { Bad 'install failed'; exit 1 }

# Put `foovox` on PATH for this user. A .cmd shim rather than a symlink:
# symlinks need developer mode or an elevated prompt on Windows.
$binDir = Join-Path $env:USERPROFILE '.local\bin'
if (-not (Test-Path $binDir)) { New-Item -ItemType Directory -Force $binDir | Out-Null }
$shim = Join-Path $binDir 'foovox.cmd'
Set-Content -Path $shim -Encoding ascii -Value "@echo off`r`nnode `"$Dir\bin\foovox.mjs`" %*"
Ok 'installed the foovox command'

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$binDir*") {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$binDir", 'User')
    Info "Added $binDir to your PATH - open a new terminal for it to take effect."
}

Write-Host ''
Bold 'Installed. Next:'
Write-Host ''
Write-Host '    foovox setup'
Write-Host ''
Info 'That checks your machine, starts the services, exposes it over Tailscale'
Info 'if you have it, and prints pairing codes to open on your phone.'
