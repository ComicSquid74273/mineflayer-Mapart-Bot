param(
  [ValidateSet('install', 'uninstall', 'start', 'stop', 'restart', 'status')]
  [string] $Action = 'status',

  [string] $Node = 'all',

  [int] $RestartDelaySec = 30
)

. "$PSScriptRoot\nerx-common.ps1"

function Get-PremiumNixServiceName {
  param([Parameter(Mandatory = $true)] [object] $Node)
  return "premium-nix-$($Node.Id)"
}

function Get-PremiumNixStopFile {
  param([Parameter(Mandatory = $true)] [object] $Node)
  return (Join-Path (Ensure-NerxDir -Path (Get-NerxRuntimeDir)) "$(Get-PremiumNixServiceName -Node $Node).stop")
}

function Get-PremiumNixTask {
  param([Parameter(Mandatory = $true)] [object] $Node)
  return Get-ScheduledTask -TaskName (Get-PremiumNixServiceName -Node $Node) -ErrorAction SilentlyContinue
}

function Install-PremiumNixTask {
  param([Parameter(Mandatory = $true)] [object] $Node)
  Ensure-NerxNodeWorkspace -Node $Node
  $repoRoot = Get-NerxRepoRoot
  $scriptPath = Join-Path $repoRoot 'scripts\premium-nix-supervisor.ps1'
  $taskName = Get-PremiumNixServiceName -Node $Node
  $arg = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`" -NodeId $($Node.Id) -RestartDelaySec $RestartDelaySec"
  $action = New-ScheduledTaskAction -Execute ((Get-Command powershell.exe -ErrorAction Stop).Source) -Argument $arg -WorkingDirectory $repoRoot
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
  try {
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description "premium-nix $($Node.BotName) supervisor" -Force | Out-Null
    Write-Host "[$taskName] installed as Scheduled Task"
  } catch {
    Write-Host "[$taskName] Scheduled Task install failed: $($_.Exception.Message)"
    Write-Host "[$taskName] Run PowerShell as Administrator for install, or use -Action start for local background supervisor mode."
  }
}

function Start-PremiumNixLocalSupervisor {
  param([Parameter(Mandatory = $true)] [object] $Node)
  $taskName = Get-PremiumNixServiceName -Node $Node
  $runtimeDir = Ensure-NerxDir -Path (Get-NerxRuntimeDir)
  $pidFile = Join-Path $runtimeDir "$taskName.supervisor.pid.json"
  if (Test-Path $pidFile) {
    try {
      $existing = Get-Content -Path $pidFile -Raw | ConvertFrom-Json
      Get-Process -Id ([int] $existing.pid) -ErrorAction Stop | Out-Null
      Write-Host "[$taskName] local supervisor already running pid=$($existing.pid)"
      return
    } catch {
      Remove-Item -Path $pidFile -Force -ErrorAction SilentlyContinue
    }
  }
  Ensure-NerxNodeWorkspace -Node $Node
  $scriptPath = Join-Path (Get-NerxRepoRoot) 'scripts\premium-nix-supervisor.ps1'
  $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $scriptPath, '-NodeId', $Node.Id, '-RestartDelaySec', "$RestartDelaySec")
  $p = Start-Process -FilePath ((Get-Command powershell.exe -ErrorAction Stop).Source) -ArgumentList $args -WorkingDirectory (Get-NerxRepoRoot) -WindowStyle Hidden -PassThru
  Write-Host "[$taskName] local supervisor start requested pid=$($p.Id)"
}

function Start-PremiumNix {
  param([Parameter(Mandatory = $true)] [object] $Node)
  Remove-Item -Path (Get-PremiumNixStopFile -Node $Node) -Force -ErrorAction SilentlyContinue
  $taskName = Get-PremiumNixServiceName -Node $Node
  if ($null -ne (Get-PremiumNixTask -Node $Node)) {
    Start-ScheduledTask -TaskName $taskName
    Write-Host "[$taskName] Scheduled Task start requested"
  } else {
    Start-PremiumNixLocalSupervisor -Node $Node
  }
}

function Stop-PremiumNix {
  param([Parameter(Mandatory = $true)] [object] $Node)
  $taskName = Get-PremiumNixServiceName -Node $Node
  $runtimeDir = Ensure-NerxDir -Path (Get-NerxRuntimeDir)
  New-Item -ItemType File -Path (Get-PremiumNixStopFile -Node $Node) -Force | Out-Null
  foreach ($suffix in @('child', 'supervisor')) {
    $pidFile = Join-Path $runtimeDir "$taskName.$suffix.pid.json"
    if (Test-Path $pidFile) {
      try {
        $state = Get-Content -Path $pidFile -Raw | ConvertFrom-Json
        Stop-Process -Id ([int] $state.pid) -Force -ErrorAction SilentlyContinue
        Write-Host "[$taskName] stopped $suffix pid=$($state.pid)"
      } catch {
      }
      Remove-Item -Path $pidFile -Force -ErrorAction SilentlyContinue
    }
  }
  if ($null -ne (Get-PremiumNixTask -Node $Node)) { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue }
  Write-Host "[$taskName] stop requested"
}

function Show-PremiumNixStatus {
  param([Parameter(Mandatory = $true)] [object] $Node)
  $taskName = Get-PremiumNixServiceName -Node $Node
  $runtimeDir = Ensure-NerxDir -Path (Get-NerxRuntimeDir)
  $task = Get-PremiumNixTask -Node $Node
  if ($null -eq $task) {
    Write-Host "[$taskName] Scheduled Task not installed; checking local supervisor mode"
  } else {
    $info = Get-ScheduledTaskInfo -TaskName $taskName
    Write-Host "[$taskName] taskState=$($task.State) lastRun=$($info.LastRunTime) lastResult=$($info.LastTaskResult)"
  }
  foreach ($suffix in @('supervisor', 'child')) {
    $pidFile = Join-Path $runtimeDir "$taskName.$suffix.pid.json"
    if (Test-Path $pidFile) {
      $state = Get-Content -Path $pidFile -Raw | ConvertFrom-Json
      $label = if ($suffix -eq 'child') { 'bot' } else { 'supervisor' }
      Write-Host "[$taskName] $label pid=$($state.pid) workspace=$($state.workspace)"
    } else {
      Write-Host "[$taskName] $suffix stopped"
    }
  }
}

$selectedNodes = Resolve-NerxNodeSelection -Node $Node
switch ($Action) {
  'install' { foreach ($n in $selectedNodes) { Install-PremiumNixTask -Node $n } }
  'uninstall' {
    foreach ($n in $selectedNodes) {
      Stop-PremiumNix -Node $n
      $taskName = Get-PremiumNixServiceName -Node $n
      if ($null -ne (Get-PremiumNixTask -Node $n)) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false; Write-Host "[$taskName] uninstalled" }
    }
  }
  'start' { foreach ($n in $selectedNodes) { Start-PremiumNix -Node $n } }
  'stop' { foreach ($n in $selectedNodes) { Stop-PremiumNix -Node $n } }
  'restart' {
    foreach ($n in $selectedNodes) { Stop-PremiumNix -Node $n }
    Start-Sleep -Seconds 2
    foreach ($n in $selectedNodes) { Start-PremiumNix -Node $n }
  }
  'status' { foreach ($n in $selectedNodes) { Show-PremiumNixStatus -Node $n } }
}
