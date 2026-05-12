param(
  [switch]$SkipBuild,
  [switch]$NoOpen,
  [switch]$Background,
  [int]$Port = 3001
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

Write-Host "Server Monitor launcher" -ForegroundColor Cyan
Write-Host "Project: $ProjectRoot"

if (-not (Test-Path ".env")) {
  Write-Host "Missing .env. Create it from .env.example before starting." -ForegroundColor Red
  exit 1
}

if (-not (Test-Path "config\servers.json")) {
  Write-Host "Missing config\servers.json." -ForegroundColor Red
  exit 1
}

$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($listener in $listeners) {
  if ($listener.OwningProcess -gt 0) {
    $process = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    if ($process) {
      Write-Host "Stopping existing process on port ${Port}: $($process.ProcessName) ($($process.Id))"
      Stop-Process -Id $process.Id -Force
    }
  }
}

if (-not $SkipBuild) {
  Write-Host "Building dashboard..."
  npm run build
}

$healthUrl = "http://127.0.0.1:${Port}/api/overview"
$appUrl = "http://127.0.0.1:${Port}"

if (-not $Background) {
  if (-not $NoOpen) {
    Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "Start-Sleep -Seconds 2; Start-Process '$appUrl'"
    )
  }

  Write-Host "Starting dashboard in this terminal: $appUrl" -ForegroundColor Green
  Write-Host "Press Ctrl+C to stop it."
  npm start
  exit $LASTEXITCODE
}

Write-Host "Starting dashboard in the background on $appUrl ..."
$serverProcess = Start-Process `
  -FilePath "npm.cmd" `
  -ArgumentList "start" `
  -WorkingDirectory $ProjectRoot `
  -WindowStyle Hidden `
  -PassThru

$ready = $false

for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 2
    if ($response.StatusCode -eq 200) {
      $ready = $true
      break
    }
  } catch {
    # Keep waiting until the backend finishes starting.
  }
}

if (-not $ready) {
  Write-Host "Dashboard process started, but health check did not respond yet. PID: $($serverProcess.Id)" -ForegroundColor Yellow
  Write-Host "Try opening http://127.0.0.1:${Port} manually after a few seconds."
  exit 1
}

Write-Host "Dashboard is running: $appUrl" -ForegroundColor Green

if (-not $NoOpen) {
  Start-Process $appUrl
}
