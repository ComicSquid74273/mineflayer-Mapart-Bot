param(
  [ValidateSet('prepare', 'start', 'stop', 'restart', 'status', 'dashboard-start', 'dashboard-stop', 'bot-start', 'bot-stop')]
  [string]$Action = 'prepare',

  [int]$DashboardPort = 4081,

  [string]$DashboardHost = '127.0.0.1',

  [string]$ConnectionProfile = 'premium-1',

  [string]$ServerHost = '',

  [int]$ServerPort = 25569,

  [string]$ServerVersion = '26.1.2',

  [int]$ReconnectDelayMs = 30000
)

$ErrorActionPreference = 'Stop'
if (-not $ServerHost) {
  if ($env:NERV_SERVER_HOST) { $ServerHost = $env:NERV_SERVER_HOST }
  else { throw 'ServerHost is required. Pass -ServerHost or set NERV_SERVER_HOST.' }
}

$MasterName = if ($env:BOT01_MASTER_NAME) { $env:BOT01_MASTER_NAME } else { throw 'BOT01_MASTER_NAME is required' }
$SlaveName = if ($env:BOT01_SLAVE_NAME) { $env:BOT01_SLAVE_NAME } else { throw 'BOT01_SLAVE_NAME is required' }
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$BaseConfigPath = Join-Path $RepoRoot 'nerv-printer-config\_configs\nerv-printer-config-premium-1.json'
$DashboardScript = Join-Path $PSScriptRoot 'nixtri-dashboard.ps1'
$InstanceRoot = Join-Path $RepoRoot 'local-nixtri-nodes\multi-bot01'
$PrinterRoot = Join-Path $InstanceRoot 'printer'
$DashboardRoot = Join-Path $InstanceRoot 'dashboard'
$PrinterPidPath = Join-Path $PrinterRoot 'nerv-printer.pid'
$LegacyMasterPidPath = Join-Path $RepoRoot ("local-nixtri-nodes\" + $MasterName + "\nerv-printer.pid")
$ConfigDir = Join-Path $DashboardRoot 'configs'
$RuntimeConfigPath = Join-Path $ConfigDir 'nerv-printer-config.json'
$DashboardNbtDir = Join-Path $PrinterRoot 'nbt'
$DashboardDataDir = Join-Path $DashboardRoot 'data'
$DashboardLogsDir = Join-Path $DashboardRoot 'logs'
$DashboardDeliveryDir = Join-Path $DashboardRoot 'delivery'
$DashboardInstanceName = 'multi-bot01-dashboard'
$DashboardPidPath = Join-Path $RepoRoot "local-nixtri-nodes\$DashboardInstanceName\dashboard.pid"
$DashboardSessionCookieName = 'mapart_dashboard_bot01_multi_test'
$DashboardUrl = "http://${DashboardHost}:$DashboardPort"
$HostLabel = 'local-nixtri-Bot01-multi-test'

function Ensure-Directory {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
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

function Set-JsonProperty {
  param(
    [Parameter(Mandatory = $true)][object]$Object,
    [Parameter(Mandatory = $true)][string]$Name,
    [AllowNull()][object]$Value
  )

  if ($null -eq $Object.PSObject.Properties[$Name]) {
    $Object | Add-Member -MemberType NoteProperty -Name $Name -Value $Value
  } else {
    $Object.$Name = $Value
  }
}

function Get-RelativePathForConfig {
  param([Parameter(Mandatory = $true)][string]$Path)

  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $rootPath = [System.IO.Path]::GetFullPath($RepoRoot).TrimEnd('\', '/')
  if (-not $fullPath.StartsWith($rootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    return ($fullPath -replace '\\', '/')
  }

  return './' + ($fullPath.Substring($rootPath.Length).TrimStart('\', '/') -replace '\\', '/')
}

function Get-AliveProcessFromPidPath {
  param([Parameter(Mandatory = $true)][string]$PidPath)

  if (-not (Test-Path -LiteralPath $PidPath)) { return $null }
  $pidText = Get-Content -LiteralPath $PidPath -ErrorAction SilentlyContinue | Select-Object -First 1
  $pidNumber = 0
  if (-not [int]::TryParse($pidText, [ref]$pidNumber)) { return $null }
  try {
    return Get-Process -Id $pidNumber -ErrorAction Stop
  } catch {
    return $null
  }
}

function Assert-MultiBotProcessIdentity {
  param([Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process)

  try {
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $($Process.Id)" -ErrorAction Stop
  } catch {
    throw "Cannot safely verify Bot01 multi parent pid=$($Process.Id): $($_.Exception.Message)"
  }
  $configNeedle = [Regex]::Escape([System.IO.Path]::GetFullPath($RuntimeConfigPath))
  if ($processInfo.Name -ne 'node.exe' -or $processInfo.CommandLine -notmatch $configNeedle) {
    throw "PID file $PrinterPidPath points to pid=$($Process.Id), but that process is not the Bot01 multi parent. Refusing to continue."
  }
  return $processInfo
}

function Test-TcpPort {
  param(
    [Parameter(Mandatory = $true)][string]$HostName,
    [Parameter(Mandatory = $true)][int]$Port
  )

  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $result = $client.BeginConnect($HostName, $Port, $null, $null)
    if (-not $result.AsyncWaitHandle.WaitOne(750)) { return $false }
    $client.EndConnect($result)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Assert-NoLegacyBot01Process {
  $legacy = Get-AliveProcessFromPidPath $LegacyMasterPidPath
  if ($legacy) {
    throw "Refusing duplicate Bot01 launch: legacy $MasterName process is alive at pid=$($legacy.Id). Stop/migrate it explicitly before starting this two-bot parent."
  }

  try {
    $legacyConfigNeedle = [Regex]::Escape("local-nixtri-nodes\" + $MasterName + "\runtime-config.json")
    $multiConfigNeedle = [Regex]::Escape([System.IO.Path]::GetFullPath($RuntimeConfigPath))
    $duplicates = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop | Where-Object {
      $_.CommandLine -match $legacyConfigNeedle -or
        $_.CommandLine -match $multiConfigNeedle -or
        $_.CommandLine -match ("(?i)--username(?:=|\s+)" + [Regex]::Escape($MasterName) + "(?:\s|$)")
    })
    if ($duplicates.Count -gt 0) {
      $duplicateIds = ($duplicates | ForEach-Object { $_.ProcessId }) -join ', '
      throw "Refusing duplicate Bot01 launch: another $MasterName Node process was detected (pid=$duplicateIds)."
    }
  } catch {
    if ($_.Exception.Message -like 'Refusing duplicate Bot01 launch:*') { throw }
    throw "Cannot safely verify that Bot01 has no duplicate Node process: $($_.Exception.Message)"
  }
}

function Ensure-MultiBotConfig {
  if (-not (Test-Path -LiteralPath $BaseConfigPath)) {
    throw "Base config not found: $BaseConfigPath"
  }

  $directories = @(
    $InstanceRoot,
    $PrinterRoot,
    (Join-Path $PrinterRoot 'auth-cache\master'),
    (Join-Path $PrinterRoot 'auth-cache\slave'),
    (Join-Path $PrinterRoot 'finished-maps'),
    (Join-Path $PrinterRoot 'logs'),
    (Join-Path $PrinterRoot 'nbt'),
    (Join-Path $PrinterRoot 'sync'),
    $DashboardRoot,
    $DashboardDataDir,
    $DashboardLogsDir,
    $ConfigDir,
    $DashboardDeliveryDir
  )
  foreach ($directory in $directories) { Ensure-Directory $directory }

  $config = Get-Content -Raw -LiteralPath $BaseConfigPath | ConvertFrom-Json
  foreach ($section in @('bot', 'connection', 'files', 'dashboard', 'anchorTranslation', 'multiUser', 'printer')) {
    if ($null -eq $config.PSObject.Properties[$section]) {
      Set-JsonProperty $config $section ([pscustomobject]@{})
    }
  }
  if ($null -eq $config.connection.profiles) { throw 'Base config has no connection.profiles block.' }

  Set-JsonProperty $config.connection 'active' $ConnectionProfile
  Set-JsonProperty $config.connection 'selected' $ConnectionProfile
  $profileProperty = $config.connection.profiles.PSObject.Properties[$ConnectionProfile]
  if ($null -eq $profileProperty) {
    $available = ($config.connection.profiles.PSObject.Properties.Name -join ', ')
    throw "Connection profile '$ConnectionProfile' is missing. Available: $available"
  }
  $profile = $profileProperty.Value
  if ($null -eq $profile.bot) { Set-JsonProperty $profile 'bot' ([pscustomobject]@{}) }
  if ($null -eq $profile.bot.reconnect) { Set-JsonProperty $profile.bot 'reconnect' ([pscustomobject]@{}) }
  Set-JsonProperty $profile.bot 'host' $ServerHost
  Set-JsonProperty $profile.bot 'port' $ServerPort
  Set-JsonProperty $profile.bot 'version' $ServerVersion
  Set-JsonProperty $profile.bot 'auth' 'offline'
  Set-JsonProperty $profile.bot.reconnect 'enabled' $true
  Set-JsonProperty $profile.bot.reconnect 'delayMs' $ReconnectDelayMs

  $masterAuth = Get-RelativePathForConfig (Join-Path $PrinterRoot 'auth-cache\master')
  $slaveAuth = Get-RelativePathForConfig (Join-Path $PrinterRoot 'auth-cache\slave')
  Set-JsonProperty $config.bot 'username' $MasterName
  Set-JsonProperty $config.bot 'auth' 'offline'
  Set-JsonProperty $config.bot 'version' $ServerVersion
  Set-JsonProperty $config.bot 'profilesFolder' $masterAuth
  Set-JsonProperty $config.bot 'usernames' @(
    [pscustomobject]@{ name = $MasterName; role = 'master'; enabled = $true; auth = 'offline'; profilesFolder = $masterAuth },
    [pscustomobject]@{ name = $SlaveName; role = 'slave'; enabled = $true; auth = 'offline'; profilesFolder = $slaveAuth }
  )
  if ($null -eq $config.bot.reconnect) { Set-JsonProperty $config.bot 'reconnect' ([pscustomobject]@{}) }
  Set-JsonProperty $config.bot.reconnect 'enabled' $true
  Set-JsonProperty $config.bot.reconnect 'delayMs' $ReconnectDelayMs

  Set-JsonProperty $config.files 'nbtFolder' (Get-RelativePathForConfig (Join-Path $PrinterRoot 'nbt'))
  Set-JsonProperty $config.files 'progressFile' (Get-RelativePathForConfig (Join-Path $PrinterRoot 'logs\printer-progress.json'))
  Set-JsonProperty $config.files 'finishedFolder' (Get-RelativePathForConfig (Join-Path $PrinterRoot 'finished-maps'))
  Set-JsonProperty $config.files 'resumeProgress' $true
  Set-JsonProperty $config.files 'moveToFinishedFolder' $true

  Set-JsonProperty $config.dashboard 'enabled' $true
  Set-JsonProperty $config.dashboard 'serviceUrl' $DashboardUrl
  Set-JsonProperty $config.dashboard 'hostLabel' $HostLabel

  Set-JsonProperty $config.anchorTranslation 'enabled' $true
  Set-JsonProperty $config.anchorTranslation 'targetAnchor' ([pscustomobject]@{ x = 62; y = 82; z = -578 })

  Set-JsonProperty $config.multiUser 'enabled' $true
  Set-JsonProperty $config.multiUser 'mode' 'file'
  Set-JsonProperty $config.multiUser 'syncFolder' (Get-RelativePathForConfig (Join-Path $PrinterRoot 'sync'))
  Set-JsonProperty $config.multiUser 'requireAllReady' $true
  Set-JsonProperty $config.multiUser 'resumeExistingJob' $true
  Set-JsonProperty $config.multiUser 'startAllOnMasterReady' $false
  Set-JsonProperty $config.multiUser 'launchFromSingleProcess' $true
  Set-JsonProperty $config.multiUser 'joinStaggerMs' 8000
  Set-JsonProperty $config.multiUser 'startStaggerMs' 0
  Set-JsonProperty $config.multiUser 'heartbeatMs' 4000
  Set-JsonProperty $config.multiUser 'barrierPollMs' 250
  Set-JsonProperty $config.multiUser 'barrierTimeoutMs' 900000
  Set-JsonProperty $config.multiUser 'resourceLockTimeoutMs' 900000
  Set-JsonProperty $config.multiUser 'bots' @(
    [pscustomobject]@{ name = $MasterName; role = 'master'; enabled = $true; auth = 'offline'; profilesFolder = $masterAuth; joinDelayMs = 0; startDelayMs = 0 },
    [pscustomobject]@{ name = $SlaveName; role = 'slave'; enabled = $true; auth = 'offline'; profilesFolder = $slaveAuth; joinDelayMs = 8000; startDelayMs = 0 }
  )

  Set-JsonProperty $config.printer 'startOnSpawn' $false

  Write-Utf8NoBomFile $RuntimeConfigPath ($config | ConvertTo-Json -Depth 100)
  return $RuntimeConfigPath
}

function Invoke-TestDashboard {
  param([Parameter(Mandatory = $true)][string]$DashboardAction)

  & $DashboardScript $DashboardAction `
    -Port $DashboardPort `
    -HostName $DashboardHost `
    -InstanceName $DashboardInstanceName `
    -DataDir $DashboardDataDir `
    -LogsDir $DashboardLogsDir `
    -ConfigDir $ConfigDir `
    -NbtDir $DashboardNbtDir `
    -DeliveryRuntimeDir $DashboardDeliveryDir `
    -SessionCookieName $DashboardSessionCookieName
}

function Start-TestDashboard {
  $dashboardProcess = Get-AliveProcessFromPidPath $DashboardPidPath
  if (-not $dashboardProcess -and (Test-TcpPort $DashboardHost $DashboardPort)) {
    throw "Refusing to start the test dashboard: ${DashboardHost}:$DashboardPort is already occupied by another process."
  }
  Invoke-TestDashboard 'start'

  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-TcpPort $DashboardHost $DashboardPort) { return }
    $dashboardProcess = Get-AliveProcessFromPidPath $DashboardPidPath
    if ((Test-Path -LiteralPath $DashboardPidPath) -and -not $dashboardProcess) {
      throw 'The isolated dashboard process exited before its TCP port became ready. Check the isolated dashboard stderr log.'
    }
    Start-Sleep -Milliseconds 250
  }
  throw "The isolated dashboard did not become ready at $DashboardUrl within 30 seconds."
}

function Stop-TestDashboard {
  Invoke-TestDashboard 'stop'
}

function Start-MultiBot {
  $existing = Get-AliveProcessFromPidPath $PrinterPidPath
  if ($existing) {
    Assert-MultiBotProcessIdentity $existing | Out-Null
    Write-Host "Bot01 multi parent already running pid=$($existing.Id) master=$MasterName slave=$SlaveName"
    return
  }

  Assert-NoLegacyBot01Process
  $configPath = Ensure-MultiBotConfig
  if (-not (Test-TcpPort $DashboardHost $DashboardPort)) {
    throw "Test dashboard is not listening at $DashboardUrl. Start the isolated dashboard first."
  }

  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $stdout = Join-Path $PrinterRoot "stdout-$timestamp.log"
  $stderr = Join-Path $PrinterRoot "stderr-$timestamp.log"
  $oldLogDir = [Environment]::GetEnvironmentVariable('NERV_LOG_DIR', 'Process')
  $oldUsername = [Environment]::GetEnvironmentVariable('NERV_USERNAME', 'Process')
  $oldUsernames = [Environment]::GetEnvironmentVariable('NERV_USERNAMES', 'Process')
  try {
    Set-Item -Path 'Env:NERV_LOG_DIR' -Value (Join-Path $PrinterRoot 'logs')
    Remove-Item -Path 'Env:NERV_USERNAME' -ErrorAction SilentlyContinue
    Remove-Item -Path 'Env:NERV_USERNAMES' -ErrorAction SilentlyContinue
    $process = Start-Process `
      -FilePath 'node' `
      -ArgumentList @('nerv-printer.js', "--config=$configPath", "--connection=$ConnectionProfile", '--wait-for-command') `
      -WorkingDirectory $RepoRoot `
      -RedirectStandardOutput $stdout `
      -RedirectStandardError $stderr `
      -WindowStyle Hidden `
      -PassThru
  } finally {
    if ($null -eq $oldLogDir) {
      Remove-Item -Path 'Env:NERV_LOG_DIR' -ErrorAction SilentlyContinue
    } else {
      Set-Item -Path 'Env:NERV_LOG_DIR' -Value $oldLogDir
    }
    if ($null -eq $oldUsername) {
      Remove-Item -Path 'Env:NERV_USERNAME' -ErrorAction SilentlyContinue
    } else {
      Set-Item -Path 'Env:NERV_USERNAME' -Value $oldUsername
    }
    if ($null -eq $oldUsernames) {
      Remove-Item -Path 'Env:NERV_USERNAMES' -ErrorAction SilentlyContinue
    } else {
      Set-Item -Path 'Env:NERV_USERNAMES' -Value $oldUsernames
    }
  }

  Set-Content -LiteralPath $PrinterPidPath -Value $process.Id -Encoding ASCII
  Write-Host "Bot01 multi parent started pid=$($process.Id) master=$MasterName interval=0-63 slave=$SlaveName interval=64-127 config=$configPath"
}

function Stop-MultiBot {
  $process = Get-AliveProcessFromPidPath $PrinterPidPath
  if (-not $process) {
    Write-Host 'Bot01 multi parent not running'
    return
  }

  Assert-MultiBotProcessIdentity $process | Out-Null
  Stop-Process -Id $process.Id -Force
  Remove-Item -LiteralPath $PrinterPidPath -Force -ErrorAction SilentlyContinue
  Write-Host "Bot01 multi parent stopped pid=$($process.Id)"
}

function Show-Status {
  $process = Get-AliveProcessFromPidPath $PrinterPidPath
  if ($process) {
    Write-Host "Bot01 multi parent: running pid=$($process.Id) master=$MasterName slave=$SlaveName"
  } else {
    Write-Host "Bot01 multi parent: stopped master=$MasterName slave=$SlaveName"
  }
  Invoke-TestDashboard 'status'
  Write-Host "test dashboard URL: $DashboardUrl"
  Write-Host "runtime config: $RuntimeConfigPath"
}

switch ($Action) {
  'prepare' {
    $configPath = Ensure-MultiBotConfig
    Write-Host "Prepared isolated Bot01 multi-bot runtime without starting any process. config=$configPath dashboard=$DashboardUrl"
  }
  'start' {
    Ensure-MultiBotConfig | Out-Null
    Start-TestDashboard
    Start-MultiBot
  }
  'stop' {
    Stop-MultiBot
    Stop-TestDashboard
  }
  'restart' {
    Stop-MultiBot
    Stop-TestDashboard
    Start-Sleep -Seconds 2
    Start-TestDashboard
    Start-MultiBot
  }
  'status' { Show-Status }
  'dashboard-start' {
    Ensure-MultiBotConfig | Out-Null
    Start-TestDashboard
  }
  'dashboard-stop' { Stop-TestDashboard }
  'bot-start' { Start-MultiBot }
  'bot-stop' { Stop-MultiBot }
}

