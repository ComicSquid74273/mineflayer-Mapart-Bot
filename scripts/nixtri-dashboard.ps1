param(
  [ValidateSet('start', 'stop', 'restart', 'status')]
  [string]$Action = 'start',

  [int]$Port = 4080,

  [string]$HostName = '127.0.0.1'
)

$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$DashboardRoot = Join-Path $RepoRoot 'dashboard-service'
$RuntimeRoot = Join-Path $RepoRoot 'local-nixtri-nodes\dashboard'
$PidPath = Join-Path $RuntimeRoot 'dashboard.pid'

function Ensure-Directory {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
  }
}

function Get-AliveProcessFromPidPath {
  param([Parameter(Mandatory = $true)][string]$PidPath)

  if (-not (Test-Path -LiteralPath $PidPath)) {
    return $null
  }

  $processIdText = (Get-Content -LiteralPath $PidPath -ErrorAction SilentlyContinue | Select-Object -First 1)
  $processIdNumber = 0
  if (-not [int]::TryParse($processIdText, [ref]$processIdNumber)) {
    Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
    return $null
  }

  try {
    return Get-Process -Id $processIdNumber -ErrorAction Stop
  } catch {
    Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
    return $null
  }
}

function Start-Dashboard {
  Ensure-Directory $RuntimeRoot

  $existing = Get-AliveProcessFromPidPath $PidPath
  if ($existing) {
    Write-Host "dashboard already running pid=$($existing.Id) url=http://${HostName}:$Port/"
    return
  }

  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $stdout = Join-Path $RuntimeRoot "stdout-$timestamp.log"
  $stderr = Join-Path $RuntimeRoot "stderr-$timestamp.log"

  $oldPort = $env:DASHBOARD_PORT
  $oldHost = $env:DASHBOARD_HOST
  try {
    $env:DASHBOARD_PORT = [string]$Port
    $env:DASHBOARD_HOST = $HostName

    $process = Start-Process `
      -FilePath 'node' `
      -ArgumentList @('src/server.js') `
      -WorkingDirectory $DashboardRoot `
      -RedirectStandardOutput $stdout `
      -RedirectStandardError $stderr `
      -WindowStyle Hidden `
      -PassThru
  } finally {
    if ($null -eq $oldPort) { Remove-Item Env:\DASHBOARD_PORT -ErrorAction SilentlyContinue } else { $env:DASHBOARD_PORT = $oldPort }
    if ($null -eq $oldHost) { Remove-Item Env:\DASHBOARD_HOST -ErrorAction SilentlyContinue } else { $env:DASHBOARD_HOST = $oldHost }
  }

  Set-Content -LiteralPath $PidPath -Value $process.Id -Encoding ASCII
  Write-Host "dashboard started pid=$($process.Id) url=http://${HostName}:$Port/"
}

function Stop-Dashboard {
  $process = Get-AliveProcessFromPidPath $PidPath
  if (-not $process) {
    Write-Host 'dashboard not running'
    return
  }

  Stop-Process -Id $process.Id -Force
  Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
  Write-Host "dashboard stopped pid=$($process.Id)"
}

function Show-DashboardStatus {
  $process = Get-AliveProcessFromPidPath $PidPath
  if ($process) {
    Write-Host "dashboard: running pid=$($process.Id) url=http://${HostName}:$Port/"
  } else {
    Write-Host "dashboard: stopped url=http://${HostName}:$Port/"
  }
}

switch ($Action) {
  'start' { Start-Dashboard }
  'stop' { Stop-Dashboard }
  'restart' {
    Stop-Dashboard
    Start-Sleep -Seconds 2
    Start-Dashboard
  }
  'status' { Show-DashboardStatus }
}
