param(
  [ValidateSet('prepare', 'start', 'stop', 'restart', 'status', 'watchdog-start', 'watchdog-stop', 'watchdog-status', 'watchdog-run')]
  [string]$Action = 'start',

  [string]$Node = 'all',

  [int]$IntervalSeconds = 30,

  [string]$DashboardUrl = 'http://127.0.0.1:4080',

  [string]$ConnectionProfile = 'premium-1',

  [string]$ServerHost = 'premium-2.lunarbyte.in',

  [int]$ServerPort = 25569,

  [string]$ServerVersion = '26.1.2',

  [int]$ReconnectDelayMs = 30000,

  [switch]$RunImmediately
)

$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$NodesRoot = Join-Path $RepoRoot 'local-nixtri-nodes'
$BaseConfigPath = Join-Path $RepoRoot 'nerv-printer-config\_configs\nerv-printer-config-premium-1.json'
$WatchdogRoot = Join-Path $NodesRoot 'watchdog'
$WatchdogPidPath = Join-Path $WatchdogRoot 'watchdog.pid'
$WatchdogStatePath = Join-Path $WatchdogRoot 'watchdog-state.json'

$NodeDefinitions = @(
  [pscustomobject]@{
    Name = 'VulcanB002'
    BotName = 'VulcanB002'
    HostLabel = 'local-nixtri-VulcanB002'
    Anchor = [pscustomobject]@{ x = -194; y = 82; z = -578 }
  }
)

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

  $relative = $fullPath.Substring($rootPath.Length).TrimStart('\', '/')
  return './' + ($relative -replace '\\', '/')
}

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

function Get-AliveWatchdogProcess {
  return Get-AliveProcessFromPidPath $WatchdogPidPath
}

function Get-SelectedNodes {
  if ($Node -eq 'all') {
    return $NodeDefinitions
  }

  $selected = $NodeDefinitions | Where-Object {
    $_.Name -ieq $Node -or $_.BotName -ieq $Node -or
      ($Node -eq '2' -and $_.Name -eq 'VulcanB002')
  }

  if (-not $selected) {
    $names = ($NodeDefinitions | ForEach-Object { $_.Name }) -join ', '
    throw "Unknown node '$Node'. Bot01 is owned by scripts/nixtri-multi-bot01.ps1; use all, 2, or one of: $names"
  }

  return @($selected)
}

function Get-NodePath {
  param([Parameter(Mandatory = $true)][object]$Definition)
  return Join-Path $NodesRoot $Definition.Name
}

function Get-PidPath {
  param([Parameter(Mandatory = $true)][object]$Definition)
  return Join-Path (Get-NodePath $Definition) 'nerv-printer.pid'
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

function Stop-Watchdog {
  $process = Get-AliveWatchdogProcess
  if (-not $process) {
    Write-Host 'watchdog not running'
    return
  }

  Stop-Process -Id $process.Id -Force
  Remove-Item -LiteralPath $WatchdogPidPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $WatchdogStatePath -Force -ErrorAction SilentlyContinue
  Write-Host "watchdog stopped pid=$($process.Id)"
}

function Ensure-NodeConfig {
  param([Parameter(Mandatory = $true)][object]$Definition)

  if (-not (Test-Path -LiteralPath $BaseConfigPath)) {
    throw "Base config not found: $BaseConfigPath"
  }

  $nodeRoot = Get-NodePath $Definition
  $paths = @(
    $NodesRoot,
    $nodeRoot,
    (Join-Path $nodeRoot 'auth-cache'),
    (Join-Path $nodeRoot 'finished-maps'),
    (Join-Path $nodeRoot 'logs'),
    (Join-Path $nodeRoot 'nbt'),
    (Join-Path $nodeRoot 'sync')
  )
  foreach ($path in $paths) {
    Ensure-Directory $path
  }

  $config = Get-Content -Raw -LiteralPath $BaseConfigPath | ConvertFrom-Json

  if ($null -eq $config.bot) { Set-JsonProperty $config 'bot' ([pscustomobject]@{}) }
  if ($null -eq $config.connection) { Set-JsonProperty $config 'connection' ([pscustomobject]@{}) }
  if ($null -eq $config.connection.profiles) { throw "Base config has no connection.profiles block." }
  if ($null -eq $config.files) { Set-JsonProperty $config 'files' ([pscustomobject]@{}) }
  if ($null -eq $config.dashboard) { Set-JsonProperty $config 'dashboard' ([pscustomobject]@{}) }
  if ($null -eq $config.anchorTranslation) { Set-JsonProperty $config 'anchorTranslation' ([pscustomobject]@{}) }
  if ($null -eq $config.multiUser) { Set-JsonProperty $config 'multiUser' ([pscustomobject]@{}) }
  if ($null -eq $config.printer) { Set-JsonProperty $config 'printer' ([pscustomobject]@{}) }

  Set-JsonProperty $config.connection 'active' $ConnectionProfile
  Set-JsonProperty $config.connection 'selected' $ConnectionProfile

  $profileProperty = $config.connection.profiles.PSObject.Properties[$ConnectionProfile]
  if ($null -eq $profileProperty) {
    $available = ($config.connection.profiles.PSObject.Properties.Name -join ', ')
    throw "Connection profile '$ConnectionProfile' is missing. Available: $available"
  }
  $profile = $profileProperty.Value
  if ($null -eq $profile.bot) { Set-JsonProperty $profile 'bot' ([pscustomobject]@{}) }

  $authCache = Get-RelativePathForConfig (Join-Path $nodeRoot 'auth-cache')
  Set-JsonProperty $profile.bot 'host' $ServerHost
  Set-JsonProperty $profile.bot 'port' $ServerPort
  Set-JsonProperty $profile.bot 'version' $ServerVersion
  Set-JsonProperty $profile.bot 'auth' 'offline'
  Set-JsonProperty $profile.bot 'profilesFolder' $authCache
  if ($null -eq $profile.bot.reconnect) { Set-JsonProperty $profile.bot 'reconnect' ([pscustomobject]@{}) }
  Set-JsonProperty $profile.bot.reconnect 'delayMs' $ReconnectDelayMs

  Set-JsonProperty $config.bot 'username' $Definition.BotName
  Set-JsonProperty -Object $config.bot -Name 'usernames' -Value @([pscustomobject]@{
    name = $Definition.BotName
    enabled = $true
    auth = 'offline'
  })
  Set-JsonProperty $config.bot 'auth' 'offline'
  Set-JsonProperty $config.bot 'profilesFolder' $authCache
  Set-JsonProperty $config.bot 'version' $ServerVersion
  if ($null -eq $config.bot.reconnect) { Set-JsonProperty $config.bot 'reconnect' ([pscustomobject]@{}) }
  Set-JsonProperty $config.bot.reconnect 'delayMs' $ReconnectDelayMs

  Set-JsonProperty $config.files 'nbtFolder' (Get-RelativePathForConfig (Join-Path $nodeRoot 'nbt'))
  Set-JsonProperty $config.files 'progressFile' (Get-RelativePathForConfig (Join-Path $nodeRoot 'logs\printer-progress.json'))
  Set-JsonProperty $config.files 'finishedFolder' (Get-RelativePathForConfig (Join-Path $nodeRoot 'finished-maps'))
  Set-JsonProperty $config.files 'resumeProgress' $true

  Set-JsonProperty $config.dashboard 'enabled' $true
  Set-JsonProperty $config.dashboard 'serviceUrl' $DashboardUrl.TrimEnd('/')
  Set-JsonProperty $config.dashboard 'hostLabel' $Definition.HostLabel

  Set-JsonProperty $config.anchorTranslation 'enabled' $true
  Set-JsonProperty $config.anchorTranslation 'targetAnchor' ([pscustomobject]@{
    x = [int]$Definition.Anchor.x
    y = [int]$Definition.Anchor.y
    z = [int]$Definition.Anchor.z
  })

  Set-JsonProperty $config.multiUser 'enabled' $false
  Set-JsonProperty $config.multiUser 'syncFolder' (Get-RelativePathForConfig (Join-Path $nodeRoot 'sync'))

  Set-JsonProperty $config.printer 'startOnSpawn' $RunImmediately.IsPresent

  $configPath = Join-Path $nodeRoot 'runtime-config.json'
  Write-Utf8NoBomFile $configPath ($config | ConvertTo-Json -Depth 100)
  return $configPath
}

function Start-Node {
  param([Parameter(Mandatory = $true)][object]$Definition)

  $pidPath = Get-PidPath $Definition
  $existing = Get-AliveProcessFromPidPath $pidPath
  if ($existing) {
    Write-Host "$($Definition.Name) already running pid=$($existing.Id)"
    return
  }

  $nodeRoot = Get-NodePath $Definition
  $configPath = Ensure-NodeConfig $Definition
  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $stdout = Join-Path $nodeRoot "stdout-$timestamp.log"
  $stderr = Join-Path $nodeRoot "stderr-$timestamp.log"

  $args = @(
    'nerv-printer.js',
    "--config=$configPath",
    "--connection=$ConnectionProfile"
  )
  if (-not $RunImmediately.IsPresent) {
    $args += '--wait-for-command'
  }

  $process = Start-Process `
    -FilePath 'node' `
    -ArgumentList $args `
    -WorkingDirectory $RepoRoot `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -WindowStyle Hidden `
    -PassThru

  Set-Content -LiteralPath $pidPath -Value $process.Id -Encoding ASCII
  Write-Host "$($Definition.Name) started pid=$($process.Id) bot=$($Definition.BotName) anchor=$($Definition.Anchor.x),$($Definition.Anchor.y),$($Definition.Anchor.z) config=$configPath"
}

function Stop-Node {
  param([Parameter(Mandatory = $true)][object]$Definition)

  $pidPath = Get-PidPath $Definition
  $process = Get-AliveProcessFromPidPath $pidPath
  if (-not $process) {
    Write-Host "$($Definition.Name) not running"
    return
  }

  Stop-Process -Id $process.Id -Force
  Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
  Write-Host "$($Definition.Name) stopped pid=$($process.Id)"
}

function Show-NodeStatus {
  param([Parameter(Mandatory = $true)][object]$Definition)

  $pidPath = Get-PidPath $Definition
  $process = Get-AliveProcessFromPidPath $pidPath
  if ($process) {
    Write-Host "$($Definition.Name): running pid=$($process.Id) bot=$($Definition.BotName) hostLabel=$($Definition.HostLabel)"
  } else {
    Write-Host "$($Definition.Name): stopped bot=$($Definition.BotName) hostLabel=$($Definition.HostLabel)"
  }
}

function Show-WatchdogStatus {
  $process = Get-AliveWatchdogProcess
  if ($process) {
    $state = readOptionalJson $WatchdogStatePath
    $stateInterval = if ($null -ne $state -and $null -ne $state.intervalSeconds) { $state.intervalSeconds } else { $IntervalSeconds }
    $stateNode = if ($null -ne $state -and $state.node) { $state.node } else { $Node }
    Write-Host "watchdog: running pid=$($process.Id) interval=${stateInterval}s node=$stateNode"
  } else {
    Write-Host "watchdog: stopped interval=${IntervalSeconds}s node=$Node"
  }
}

function readOptionalJson {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return $null
  }

  try {
    return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Write-WatchdogState {
  param([Parameter(Mandatory = $true)][int]$ProcessId)

  Ensure-Directory $WatchdogRoot
  $state = [pscustomobject]@{
    pid = $ProcessId
    node = $Node
    intervalSeconds = [Math]::Max(5, $IntervalSeconds)
    dashboardUrl = $DashboardUrl
    connectionProfile = $ConnectionProfile
    serverHost = $ServerHost
    serverPort = $ServerPort
    serverVersion = $ServerVersion
    reconnectDelayMs = $ReconnectDelayMs
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
  }
  Write-Utf8NoBomFile $WatchdogStatePath ($state | ConvertTo-Json -Depth 8)
}

function Start-Watchdog {
  Ensure-Directory $WatchdogRoot

  $existing = Get-AliveWatchdogProcess
  if ($existing) {
    Write-Host "watchdog already running pid=$($existing.Id)"
    return
  }

  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $stdout = Join-Path $WatchdogRoot "stdout-$timestamp.log"
  $stderr = Join-Path $WatchdogRoot "stderr-$timestamp.log"
  $args = @(
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    $PSCommandPath,
    'watchdog-run',
    '-Node',
    $Node,
    '-IntervalSeconds',
    [string][Math]::Max(5, $IntervalSeconds),
    '-DashboardUrl',
    $DashboardUrl,
    '-ConnectionProfile',
    $ConnectionProfile,
    '-ServerHost',
    $ServerHost,
    '-ServerPort',
    [string]$ServerPort,
    '-ServerVersion',
    $ServerVersion,
    '-ReconnectDelayMs',
    [string]$ReconnectDelayMs
  )
  if ($RunImmediately.IsPresent) {
    $args += '-RunImmediately'
  }

  $process = Start-Process `
    -FilePath 'powershell' `
    -ArgumentList $args `
    -WorkingDirectory $RepoRoot `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -WindowStyle Hidden `
    -PassThru

  Set-Content -LiteralPath $WatchdogPidPath -Value $process.Id -Encoding ASCII
  Write-WatchdogState $process.Id
  Write-Host "watchdog started pid=$($process.Id) interval=$([Math]::Max(5, $IntervalSeconds))s node=$Node"
}

function Run-Watchdog {
  Ensure-Directory $WatchdogRoot
  Set-Content -LiteralPath $WatchdogPidPath -Value $PID -Encoding ASCII
  Write-WatchdogState $PID
  Write-Host "watchdog loop active pid=$PID interval=$([Math]::Max(5, $IntervalSeconds))s node=$Node"

  while ($true) {
    for ($i = 0; $i -lt $selectedNodes.Count; $i++) {
      $definition = $selectedNodes[$i]
      $pidPath = Get-PidPath $definition
      $process = Get-AliveProcessFromPidPath $pidPath
      if ($process) {
        Write-Host "$(Get-Date -Format o) $($definition.Name) alive pid=$($process.Id)"
        continue
      }

      Write-Host "$(Get-Date -Format o) $($definition.Name) down; starting"
      try {
        Start-Node $definition
        if ($i -lt ($selectedNodes.Count - 1) -and $IntervalSeconds -gt 0) {
          Write-Host "$(Get-Date -Format o) waiting $IntervalSeconds seconds before checking next node"
          Start-Sleep -Seconds $IntervalSeconds
        }
      } catch {
        Write-Host "$(Get-Date -Format o) $($definition.Name) start failed: $($_.Exception.Message)"
      }
    }

    Start-Sleep -Seconds ([Math]::Max(5, $IntervalSeconds))
  }
}

$selectedNodes = @(Get-SelectedNodes)
$IntervalSeconds = [Math]::Max(0, $IntervalSeconds)

switch ($Action) {
  'watchdog-start' {
    Start-Watchdog
  }
  'watchdog-stop' {
    Stop-Watchdog
  }
  'watchdog-status' {
    Show-WatchdogStatus
  }
  'watchdog-run' {
    Run-Watchdog
  }
  'prepare' {
    foreach ($definition in $selectedNodes) {
      $configPath = Ensure-NodeConfig $definition
      Write-Host "$($definition.Name) prepared bot=$($definition.BotName) anchor=$($definition.Anchor.x),$($definition.Anchor.y),$($definition.Anchor.z) config=$configPath"
    }
  }
  'start' {
    for ($i = 0; $i -lt $selectedNodes.Count; $i++) {
      Start-Node $selectedNodes[$i]
      if ($i -lt ($selectedNodes.Count - 1) -and $IntervalSeconds -gt 0) {
        Write-Host "Waiting $IntervalSeconds seconds before next node..."
        Start-Sleep -Seconds $IntervalSeconds
      }
    }
  }
  'stop' {
    Stop-Watchdog
    foreach ($definition in $selectedNodes) {
      Stop-Node $definition
    }
  }
  'restart' {
    foreach ($definition in $selectedNodes) {
      Stop-Node $definition
    }
    if ($IntervalSeconds -gt 0) {
      Write-Host "Waiting $IntervalSeconds seconds before restart..."
      Start-Sleep -Seconds $IntervalSeconds
    }
    for ($i = 0; $i -lt $selectedNodes.Count; $i++) {
      Start-Node $selectedNodes[$i]
      if ($i -lt ($selectedNodes.Count - 1) -and $IntervalSeconds -gt 0) {
        Write-Host "Waiting $IntervalSeconds seconds before next node..."
        Start-Sleep -Seconds $IntervalSeconds
      }
    }
  }
  'status' {
    foreach ($definition in $selectedNodes) {
      Show-NodeStatus $definition
    }
  }
}
