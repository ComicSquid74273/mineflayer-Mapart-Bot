Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-NerxRepoRoot {
  return (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

function Get-NerxRuntimeDir {
  return (Join-Path (Get-NerxRepoRoot) 'logs\nerx-local')
}

function Get-NerxWorkspaceBase {
  return (Join-Path (Split-Path (Get-NerxRepoRoot) -Parent) 'mapart-bot-nodes')
}

function Ensure-NerxDir {
  param([Parameter(Mandatory = $true)] [string] $Path)
  New-Item -ItemType Directory -Path $Path -Force | Out-Null
  return $Path
}

function Write-NerxUtf8NoBom {
  param(
    [Parameter(Mandatory = $true)] [string] $Path,
    [Parameter(Mandatory = $true)] [string] $Content
  )
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Set-NerxProperty {
  param(
    [Parameter(Mandatory = $true)] [object] $Object,
    [Parameter(Mandatory = $true)] [string] $Name,
    [AllowNull()] [object] $Value
  )
  if ($null -eq $Object.PSObject.Properties[$Name]) {
    $Object | Add-Member -MemberType NoteProperty -Name $Name -Value $Value
  } else {
    $Object.$Name = $Value
  }
}

function Get-NerxNodeDefinitions {
  $base = Get-NerxWorkspaceBase
  return @(
    [pscustomobject]@{
      Id = 'node-01'
      BotName = 'VulcanB001'
      HostLabel = 'nerx-lunarbyte-node-01'
      ConfigPath = 'nerv-printer-config\_configs\nerx-premium-node-01.json'
      WorkspacePath = (Join-Path $base 'node-01')
      TargetAnchor = [pscustomobject]@{ x = 62; y = 82; z = -578 }
    },
    [pscustomobject]@{
      Id = 'node-02'
      BotName = 'VulcanB002'
      HostLabel = 'nerx-lunarbyte-node-02'
      ConfigPath = 'nerv-printer-config\_configs\nerx-premium-node-02.json'
      WorkspacePath = (Join-Path $base 'node-02')
      TargetAnchor = [pscustomobject]@{ x = -194; y = 82; z = -578 }
    }
  )
}

function Resolve-NerxNodeSelection {
  param([string] $Node = 'all')
  $nodes = Get-NerxNodeDefinitions
  $value = ('' + $Node).Trim().ToLowerInvariant()
  if ($value -eq 'all' -or $value -eq 'both') { return $nodes }
  switch ($value) {
    '1' { return @($nodes[0]) }
    '01' { return @($nodes[0]) }
    'node1' { return @($nodes[0]) }
    'node01' { return @($nodes[0]) }
    'node-1' { return @($nodes[0]) }
    'node-01' { return @($nodes[0]) }
    'vulcanb001' { return @($nodes[0]) }
    'comicbot01' { return @($nodes[0]) }
    '2' { return @($nodes[1]) }
    '02' { return @($nodes[1]) }
    'node2' { return @($nodes[1]) }
    'node02' { return @($nodes[1]) }
    'node-2' { return @($nodes[1]) }
    'node-02' { return @($nodes[1]) }
    'vulcanb002' { return @($nodes[1]) }
    'comicbot02' { return @($nodes[1]) }
    default { throw "Unknown node '$Node'. Use all, 1, 2, node-01, or node-02." }
  }
}

function New-NerxNodeConfigObject {
  param(
    [Parameter(Mandatory = $true)] [object] $Node,
    [Parameter(Mandatory = $true)] [string] $TemplatePath
  )
  $config = Get-Content -Path $TemplatePath -Raw | ConvertFrom-Json

  if ($null -eq $config.PSObject.Properties['bot']) { Set-NerxProperty $config 'bot' ([pscustomobject]@{}) }
  Set-NerxProperty $config.bot 'usernames' @([pscustomobject]@{ name = $Node.BotName; enabled = $true; auth = 'offline' })
  Set-NerxProperty $config.bot 'username' $Node.BotName
  Set-NerxProperty $config.bot 'version' '26.1.2'

  if ($null -eq $config.PSObject.Properties['connection']) { Set-NerxProperty $config 'connection' ([pscustomobject]@{}) }
  Set-NerxProperty $config.connection 'active' 'premium-1'
  Set-NerxProperty $config.connection 'selected' 'premium-1'
  $premium = $config.connection.profiles.'premium-1'
  if ($null -ne $premium -and $null -ne $premium.PSObject.Properties['bot']) {
    Set-NerxProperty $premium.bot 'host' 'premium-2.lunarbyte.in'
    Set-NerxProperty $premium.bot 'port' 25569
    Set-NerxProperty $premium.bot 'auth' 'offline'
    Set-NerxProperty $premium.bot 'version' '26.1.2'
    if ($null -eq $premium.bot.PSObject.Properties['reconnect']) { Set-NerxProperty $premium.bot 'reconnect' ([pscustomobject]@{}) }
    Set-NerxProperty $premium.bot.reconnect 'delayMs' 30000
  }

  if ($null -eq $config.PSObject.Properties['files']) { Set-NerxProperty $config 'files' ([pscustomobject]@{}) }
  Set-NerxProperty $config.files 'nbtFolder' './nerv-printer-config'
  Set-NerxProperty $config.files 'progressFile' './logs/printer-progress.json'
  Set-NerxProperty $config.files 'finishedFolder' './finished-maps'

  if ($null -eq $config.PSObject.Properties['multiUser']) { Set-NerxProperty $config 'multiUser' ([pscustomobject]@{}) }
  Set-NerxProperty $config.multiUser 'enabled' $false

  if ($null -eq $config.PSObject.Properties['dashboard']) { Set-NerxProperty $config 'dashboard' ([pscustomobject]@{}) }
  Set-NerxProperty $config.dashboard 'enabled' $true
  Set-NerxProperty $config.dashboard 'serviceUrl' 'http://127.0.0.1:4080'
  Set-NerxProperty $config.dashboard 'hostLabel' $Node.HostLabel

  if ($null -eq $config.PSObject.Properties['anchorTranslation']) { Set-NerxProperty $config 'anchorTranslation' ([pscustomobject]@{}) }
  Set-NerxProperty $config.anchorTranslation 'enabled' $true
  Set-NerxProperty $config.anchorTranslation 'sourceAnchor' ([pscustomobject]@{ x = -706; y = -9; z = -962 })
  Set-NerxProperty $config.anchorTranslation 'targetAnchor' $Node.TargetAnchor
  return $config
}

function Write-NerxNodeConfig {
  param(
    [Parameter(Mandatory = $true)] [object] $Node,
    [Parameter(Mandatory = $true)] [string] $RootPath
  )
  $template = Join-Path $RootPath 'nerv-printer-config\_configs\nerv-printer-config-premium-1.json'
  if (-not (Test-Path $template)) { throw "Missing template config: $template" }
  $target = Join-Path $RootPath $Node.ConfigPath
  Ensure-NerxDir -Path (Split-Path $target -Parent) | Out-Null
  $json = (New-NerxNodeConfigObject -Node $Node -TemplatePath $template) | ConvertTo-Json -Depth 100
  Write-NerxUtf8NoBom -Path $target -Content ($json + [Environment]::NewLine)
  Write-Host "[config] wrote $target"
}

function Write-NerxNodeConfigs {
  $root = Get-NerxRepoRoot
  foreach ($node in Get-NerxNodeDefinitions) {
    Write-NerxNodeConfig -Node $node -RootPath $root
  }
}

function Assert-NerxWorkspacePath {
  param([Parameter(Mandatory = $true)] [string] $WorkspacePath)
  $repo = [System.IO.Path]::GetFullPath((Get-NerxRepoRoot)).TrimEnd('\')
  $workspace = [System.IO.Path]::GetFullPath($WorkspacePath).TrimEnd('\')
  if ($workspace -eq $repo -or $workspace.StartsWith($repo + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Workspace must not be the repo root or inside it: $workspace"
  }
}

function Sync-NerxProjectCopy {
  param([Parameter(Mandatory = $true)] [object] $Node)
  $root = Get-NerxRepoRoot
  $workspace = $Node.WorkspacePath
  Assert-NerxWorkspacePath -WorkspacePath $workspace
  Ensure-NerxDir -Path $workspace | Out-Null
  $args = @(
    ($root.TrimEnd('\') + '\'),
    ($workspace.TrimEnd('\') + '\'),
    '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP',
    '/XD', '.git', 'node_modules', 'logs', 'graphify-out', 'auth-cache', 'finished-maps', 'dashboard-service\data',
    '/XF', '*.pid.json'
  )
  Write-Host "[copy] syncing $root -> $workspace"
  & robocopy @args | Out-Host
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }
}

function Ensure-NerxNodeWorkspace {
  param([Parameter(Mandatory = $true)] [object] $Node)
  Sync-NerxProjectCopy -Node $Node
  Write-NerxNodeConfig -Node $Node -RootPath $Node.WorkspacePath
  Ensure-NerxDir -Path (Join-Path $Node.WorkspacePath 'nerv-printer-config') | Out-Null
  Ensure-NerxDir -Path (Join-Path $Node.WorkspacePath 'logs') | Out-Null
  Ensure-NerxDir -Path (Join-Path $Node.WorkspacePath 'finished-maps') | Out-Null

  if (-not (Test-Path (Join-Path $Node.WorkspacePath 'node_modules'))) {
    $npm = (Get-Command npm -ErrorAction Stop).Source
    Write-Host "[deps] installing node dependencies in $($Node.WorkspacePath)"
    $p = Start-Process -FilePath $npm -ArgumentList @('install', 'mineflayer@4.38.0', 'minecraft-protocol@1.68.0', 'mineflayer-pathfinder@2.4.5', '--save-exact', '--omit=dev') -WorkingDirectory $Node.WorkspacePath -Wait -PassThru -NoNewWindow
    if ($p.ExitCode -ne 0) { throw "npm install failed in $($Node.WorkspacePath) with exit code $($p.ExitCode)" }
  }

  Write-Host "[workspace] $($Node.Id) ready at $($Node.WorkspacePath)"
  Write-Host "[workspace] put $($Node.BotName) NBT files in $(Join-Path $Node.WorkspacePath 'nerv-printer-config')"
}

function Ensure-NerxNodeWorkspaces {
  param([object[]] $Nodes = (Get-NerxNodeDefinitions))
  foreach ($node in $Nodes) { Ensure-NerxNodeWorkspace -Node $node }
}

function Get-NerxPidFile {
  param([Parameter(Mandatory = $true)] [string] $Name)
  return (Join-Path (Ensure-NerxDir -Path (Get-NerxRuntimeDir)) "$Name.pid.json")
}

function Get-NerxManagedProcess {
  param([Parameter(Mandatory = $true)] [string] $Name)
  $pidFile = Get-NerxPidFile -Name $Name
  if (-not (Test-Path $pidFile)) { return $null }
  try {
    $state = Get-Content -Path $pidFile -Raw | ConvertFrom-Json
    $proc = Get-Process -Id ([int] $state.pid) -ErrorAction Stop
    return [pscustomobject]@{ State = $state; Process = $proc }
  } catch {
    Remove-Item -Path $pidFile -Force -ErrorAction SilentlyContinue
    return $null
  }
}

function Start-NerxManagedProcess {
  param(
    [Parameter(Mandatory = $true)] [string] $Name,
    [Parameter(Mandatory = $true)] [string] $Kind,
    [Parameter(Mandatory = $true)] [string] $FilePath,
    [Parameter(Mandatory = $true)] [string[]] $ArgumentList,
    [Parameter(Mandatory = $true)] [string] $WorkingDirectory
  )
  $existing = Get-NerxManagedProcess -Name $Name
  if ($null -ne $existing) {
    Write-Host "[$Name] already running pid=$($existing.State.pid)"
    return
  }
  $runtime = Ensure-NerxDir -Path (Get-NerxRuntimeDir)
  $stdout = Join-Path $runtime "$Name.out.log"
  $stderr = Join-Path $runtime "$Name.err.log"
  $p = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  $state = [pscustomobject]@{ name = $Name; kind = $Kind; pid = $p.Id; stdout = $stdout; stderr = $stderr; startedAt = (Get-Date).ToUniversalTime().ToString('o') }
  Write-NerxUtf8NoBom -Path (Get-NerxPidFile -Name $Name) -Content (($state | ConvertTo-Json -Depth 10) + [Environment]::NewLine)
  Write-Host "[$Name] started pid=$($p.Id)"
}

function Stop-NerxManagedProcess {
  param([Parameter(Mandatory = $true)] [string] $Name)
  $existing = Get-NerxManagedProcess -Name $Name
  if ($null -eq $existing) {
    Write-Host "[$Name] not running"
    return
  }
  Stop-Process -Id ([int] $existing.State.pid) -Force -ErrorAction SilentlyContinue
  Remove-Item -Path (Get-NerxPidFile -Name $Name) -Force -ErrorAction SilentlyContinue
  Write-Host "[$Name] stopped"
}

function Show-NerxManagedProcessStatus {
  param([Parameter(Mandatory = $true)] [string] $Name)
  $existing = Get-NerxManagedProcess -Name $Name
  if ($null -eq $existing) {
    Write-Host "[$Name] stopped"
  } else {
    Write-Host "[$Name] running pid=$($existing.State.pid) stdout=$($existing.State.stdout) stderr=$($existing.State.stderr)"
  }
}

function Start-NerxDashboard {
  Start-NerxManagedProcess -Name 'dashboard' -Kind 'dashboard' -FilePath ((Get-Command node -ErrorAction Stop).Source) -ArgumentList @('dashboard-service\src\server.js') -WorkingDirectory (Get-NerxRepoRoot)
}

function Start-NerxBotNode {
  param([Parameter(Mandatory = $true)] [object] $Node)
  Ensure-NerxNodeWorkspace -Node $Node
  Start-NerxManagedProcess -Name $Node.Id -Kind 'bot' -FilePath ((Get-Command node -ErrorAction Stop).Source) -ArgumentList @('nerv-printer.js', "--config=$($Node.ConfigPath)", '--connection=premium-1', '--wait-for-command') -WorkingDirectory $Node.WorkspacePath
}
