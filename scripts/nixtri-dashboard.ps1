param(
  [ValidateSet('start', 'stop', 'restart', 'status', 'watchdog-start', 'watchdog-stop', 'watchdog-status', 'watchdog-run')]
  [string]$Action = 'start',

  [int]$Port = 4080,

  [string]$HostName = '127.0.0.1',

  [string]$InstanceName = 'dashboard',

  [string]$DataDir = '',

  [string]$LogsDir = '',

  [string]$ConfigDir = '',

  [string]$NbtDir = '',

  [string]$DeliveryRuntimeDir = '',

  [string]$SessionCookieName = 'mapart_dashboard_session',

  [int]$IntervalSeconds = 30
)

$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$DashboardRoot = Join-Path $RepoRoot 'dashboard-service'
if ($InstanceName -notmatch '^[A-Za-z0-9_-]+$') {
  throw 'InstanceName may contain only letters, numbers, underscores, and hyphens.'
}
$RuntimeRoot = Join-Path $RepoRoot "local-nixtri-nodes\$InstanceName"
$DataDir = if ($DataDir) { [System.IO.Path]::GetFullPath($DataDir) } else { Join-Path $DashboardRoot 'data' }
$LogsDir = if ($LogsDir) { [System.IO.Path]::GetFullPath($LogsDir) } else { Join-Path $RepoRoot 'logs' }
$ConfigDir = if ($ConfigDir) { [System.IO.Path]::GetFullPath($ConfigDir) } else { Join-Path $RepoRoot 'nerv-printer-config\_configs' }
$NbtDir = if ($NbtDir) { [System.IO.Path]::GetFullPath($NbtDir) } else { Join-Path $RepoRoot 'nerv-printer-config' }
$DeliveryRuntimeDir = if ($DeliveryRuntimeDir) { [System.IO.Path]::GetFullPath($DeliveryRuntimeDir) } else { Join-Path $RepoRoot 'local-nixtri-nodes\delivery' }
$PidPath = Join-Path $RuntimeRoot 'dashboard.pid'
$WatchdogPidPath = Join-Path $RuntimeRoot 'dashboard-watchdog.pid'
$WatchdogStatePath = Join-Path $RuntimeRoot 'dashboard-watchdog-state.json'

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

function Write-Utf8NoBomFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Content
  )

  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Get-AliveDashboardWatchdogProcess {
  return Get-AliveProcessFromPidPath $WatchdogPidPath
}

function Write-DashboardWatchdogState {
  param([Parameter(Mandatory = $true)][int]$ProcessId)

  Ensure-Directory $RuntimeRoot
  $state = [pscustomobject]@{
    pid = $ProcessId
    intervalSeconds = [Math]::Max(5, $IntervalSeconds)
    hostName = $HostName
    port = $Port
    instanceName = $InstanceName
    dataDir = $DataDir
    logsDir = $LogsDir
    configDir = $ConfigDir
    nbtDir = $NbtDir
    deliveryRuntimeDir = $DeliveryRuntimeDir
    sessionCookieName = $SessionCookieName
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
  }
  Write-Utf8NoBomFile $WatchdogStatePath ($state | ConvertTo-Json -Depth 8)
}

function Start-Dashboard {
  Ensure-Directory $RuntimeRoot
  foreach ($directory in @($DataDir, $LogsDir, $ConfigDir, $NbtDir, $DeliveryRuntimeDir)) {
    Ensure-Directory $directory
  }

  $existing = Get-AliveProcessFromPidPath $PidPath
  if ($existing) {
    Write-Host "dashboard already running pid=$($existing.Id) url=http://${HostName}:$Port/"
    return
  }

  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $stdout = Join-Path $RuntimeRoot "stdout-$timestamp.log"
  $stderr = Join-Path $RuntimeRoot "stderr-$timestamp.log"

  $environment = @{
    DASHBOARD_PORT = [string]$Port
    DASHBOARD_HOST = $HostName
    DASHBOARD_DATA_DIR = $DataDir
    DASHBOARD_LOGS_DIR = $LogsDir
    DASHBOARD_CONFIG_DIR = $ConfigDir
    DASHBOARD_NBT_DIR = $NbtDir
    DASHBOARD_DELIVERY_RUNTIME_DIR = $DeliveryRuntimeDir
    DASHBOARD_SESSION_COOKIE_NAME = $SessionCookieName
  }
  $oldEnvironment = @{}
  try {
    foreach ($name in $environment.Keys) {
      $oldEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
      Set-Item -Path "Env:$name" -Value $environment[$name]
    }

    $process = Start-Process `
      -FilePath 'node' `
      -ArgumentList @('src/server.js') `
      -WorkingDirectory $DashboardRoot `
      -RedirectStandardOutput $stdout `
      -RedirectStandardError $stderr `
      -WindowStyle Hidden `
      -PassThru
  } finally {
    foreach ($name in $environment.Keys) {
      if ($null -eq $oldEnvironment[$name]) {
        Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue
      } else {
        Set-Item -Path "Env:$name" -Value $oldEnvironment[$name]
      }
    }
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

function Stop-DashboardWatchdog {
  $process = Get-AliveDashboardWatchdogProcess
  if (-not $process) {
    Write-Host 'dashboard watchdog not running'
    return
  }

  Stop-Process -Id $process.Id -Force
  Remove-Item -LiteralPath $WatchdogPidPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $WatchdogStatePath -Force -ErrorAction SilentlyContinue
  Write-Host "dashboard watchdog stopped pid=$($process.Id)"
}

function Show-DashboardStatus {
  $process = Get-AliveProcessFromPidPath $PidPath
  if ($process) {
    Write-Host "dashboard: running pid=$($process.Id) url=http://${HostName}:$Port/"
  } else {
    Write-Host "dashboard: stopped url=http://${HostName}:$Port/"
  }
}

function Show-DashboardWatchdogStatus {
  $process = Get-AliveDashboardWatchdogProcess
  if ($process) {
    Write-Host "dashboard watchdog: running pid=$($process.Id) interval=$([Math]::Max(5, $IntervalSeconds))s url=http://${HostName}:$Port/"
  } else {
    Write-Host "dashboard watchdog: stopped interval=$([Math]::Max(5, $IntervalSeconds))s url=http://${HostName}:$Port/"
  }
}

function Start-DashboardWatchdog {
  Ensure-Directory $RuntimeRoot

  $existing = Get-AliveDashboardWatchdogProcess
  if ($existing) {
    Write-Host "dashboard watchdog already running pid=$($existing.Id)"
    return
  }

  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $stdout = Join-Path $RuntimeRoot "watchdog-stdout-$timestamp.log"
  $stderr = Join-Path $RuntimeRoot "watchdog-stderr-$timestamp.log"
  $args = @(
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    $PSCommandPath,
    'watchdog-run',
    '-Port',
    [string]$Port,
    '-HostName',
    $HostName,
    '-InstanceName',
    $InstanceName,
    '-DataDir',
    $DataDir,
    '-LogsDir',
    $LogsDir,
    '-ConfigDir',
    $ConfigDir,
    '-NbtDir',
    $NbtDir,
    '-DeliveryRuntimeDir',
    $DeliveryRuntimeDir,
    '-SessionCookieName',
    $SessionCookieName,
    '-IntervalSeconds',
    [string][Math]::Max(5, $IntervalSeconds)
  )

  $process = Start-Process `
    -FilePath 'powershell' `
    -ArgumentList $args `
    -WorkingDirectory $RepoRoot `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -WindowStyle Hidden `
    -PassThru

  Set-Content -LiteralPath $WatchdogPidPath -Value $process.Id -Encoding ASCII
  Write-DashboardWatchdogState $process.Id
  Write-Host "dashboard watchdog started pid=$($process.Id) interval=$([Math]::Max(5, $IntervalSeconds))s url=http://${HostName}:$Port/"
}

function Run-DashboardWatchdog {
  Ensure-Directory $RuntimeRoot
  Set-Content -LiteralPath $WatchdogPidPath -Value $PID -Encoding ASCII
  Write-DashboardWatchdogState $PID
  Write-Host "dashboard watchdog loop active pid=$PID interval=$([Math]::Max(5, $IntervalSeconds))s url=http://${HostName}:$Port/"

  while ($true) {
    $process = Get-AliveProcessFromPidPath $PidPath
    if ($process) {
      Write-Host "$(Get-Date -Format o) dashboard alive pid=$($process.Id)"
    } else {
      Write-Host "$(Get-Date -Format o) dashboard down; starting"
      try {
        Start-Dashboard
      } catch {
        Write-Host "$(Get-Date -Format o) dashboard start failed: $($_.Exception.Message)"
      }
    }

    Start-Sleep -Seconds ([Math]::Max(5, $IntervalSeconds))
  }
}

$IntervalSeconds = [Math]::Max(0, $IntervalSeconds)

switch ($Action) {
  'start' { Start-Dashboard }
  'stop' {
    Stop-DashboardWatchdog
    Stop-Dashboard
  }
  'restart' {
    Stop-Dashboard
    Start-Sleep -Seconds 2
    Start-Dashboard
  }
  'status' { Show-DashboardStatus }
  'watchdog-start' { Start-DashboardWatchdog }
  'watchdog-stop' { Stop-DashboardWatchdog }
  'watchdog-status' { Show-DashboardWatchdogStatus }
  'watchdog-run' { Run-DashboardWatchdog }
}
