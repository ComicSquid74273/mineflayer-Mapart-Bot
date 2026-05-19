param(
  [ValidateSet('prepare', 'start', 'stop', 'restart', 'status')]
  [string]$Action = 'start',

  [string]$Node = 'all',

  [int]$IntervalSeconds = 30,

  [string]$DashboardUrl = 'http://127.0.0.1:4080',

  [string]$ConnectionProfile = 'premium-1',

  [switch]$RunImmediately
)

$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$NodesRoot = Join-Path $RepoRoot 'local-nixtri-nodes'
$BaseConfigPath = Join-Path $RepoRoot 'nerv-printer-config\_configs\nerv-printer-config-premium-1.json'

$NodeDefinitions = @(
  [pscustomobject]@{
    Name = 'ComicBot01'
    BotName = 'ComicBot01'
    HostLabel = 'local-nixtri-ComicBot01'
    Anchor = [pscustomobject]@{ x = 62; y = 173; z = -194 }
  },
  [pscustomobject]@{
    Name = 'ComicBot02'
    BotName = 'ComicBot02'
    HostLabel = 'local-nixtri-ComicBot02'
    Anchor = [pscustomobject]@{ x = 318; y = 161; z = -194 }
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

function Get-SelectedNodes {
  if ($Node -eq 'all') {
    return $NodeDefinitions
  }

  $selected = $NodeDefinitions | Where-Object {
    $_.Name -ieq $Node -or $_.BotName -ieq $Node -or
      ($Node -eq '1' -and $_.Name -eq 'ComicBot01') -or
      ($Node -eq '2' -and $_.Name -eq 'ComicBot02')
  }

  if (-not $selected) {
    $names = ($NodeDefinitions | ForEach-Object { $_.Name }) -join ', '
    throw "Unknown node '$Node'. Use all, 1, 2, or one of: $names"
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
  Set-JsonProperty $profile.bot 'auth' 'offline'
  Set-JsonProperty $profile.bot 'profilesFolder' $authCache

  Set-JsonProperty $config.bot 'username' $Definition.BotName
  Set-JsonProperty -Object $config.bot -Name 'usernames' -Value @([pscustomobject]@{
    name = $Definition.BotName
    enabled = $true
    auth = 'offline'
  })
  Set-JsonProperty $config.bot 'auth' 'offline'
  Set-JsonProperty $config.bot 'profilesFolder' $authCache

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
  $config | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $configPath -Encoding UTF8
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

$selectedNodes = @(Get-SelectedNodes)
$IntervalSeconds = [Math]::Max(0, $IntervalSeconds)

switch ($Action) {
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
