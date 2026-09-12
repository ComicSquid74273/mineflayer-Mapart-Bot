param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('node-01', 'node-02')]
  [string] $NodeId,

  [int] $RestartDelaySec = 30
)

. "$PSScriptRoot\nerx-common.ps1"

$node = Get-NerxNodeDefinitions | Where-Object { $_.Id -eq $NodeId } | Select-Object -First 1
if ($null -eq $node) { throw "Unknown node '$NodeId'." }

$serviceName = "premium-nix-$($node.Id)"
$runtimeDir = Ensure-NerxDir -Path (Get-NerxRuntimeDir)
$stopFile = Join-Path $runtimeDir "$serviceName.stop"
$supervisorPidFile = Join-Path $runtimeDir "$serviceName.supervisor.pid.json"
$childPidFile = Join-Path $runtimeDir "$serviceName.child.pid.json"
$botStdout = Join-Path $runtimeDir "$serviceName.bot.out.log"
$botStderr = Join-Path $runtimeDir "$serviceName.bot.err.log"
$transcriptFile = Join-Path $runtimeDir "$serviceName.supervisor.log"

Remove-Item -Path $stopFile -Force -ErrorAction SilentlyContinue
Write-NerxUtf8NoBom -Path $supervisorPidFile -Content (([pscustomobject]@{
  name = $serviceName
  nodeId = $node.Id
  botName = $node.BotName
  workspace = $node.WorkspacePath
  pid = $PID
  restartDelaySec = $RestartDelaySec
  startedAt = (Get-Date).ToUniversalTime().ToString('o')
} | ConvertTo-Json -Depth 10) + [Environment]::NewLine)

Start-Transcript -Path $transcriptFile -Append | Out-Null
try {
  Write-Host "[$serviceName] supervisor started pid=$PID restartDelaySec=$RestartDelaySec"
  Ensure-NerxNodeWorkspace -Node $node
  while (-not (Test-Path $stopFile)) {
    $args = @('nerv-printer.js', "--config=$($node.ConfigPath)", '--connection=premium-1', '--wait-for-command')
    $child = Start-Process -FilePath ((Get-Command node -ErrorAction Stop).Source) -ArgumentList $args -WorkingDirectory $node.WorkspacePath -WindowStyle Hidden -RedirectStandardOutput $botStdout -RedirectStandardError $botStderr -PassThru
    Write-NerxUtf8NoBom -Path $childPidFile -Content (([pscustomobject]@{
      name = $serviceName
      nodeId = $node.Id
      botName = $node.BotName
      pid = $child.Id
      workspace = $node.WorkspacePath
      stdout = $botStdout
      stderr = $botStderr
      startedAt = (Get-Date).ToUniversalTime().ToString('o')
    } | ConvertTo-Json -Depth 10) + [Environment]::NewLine)

    Wait-Process -Id $child.Id -ErrorAction SilentlyContinue
    Remove-Item -Path $childPidFile -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path $stopFile)) {
      Write-Host "[$serviceName] bot exited; restarting in $RestartDelaySec sec"
      Start-Sleep -Seconds ([Math]::Max(1, $RestartDelaySec))
    }
  }
} finally {
  Remove-Item -Path $supervisorPidFile -Force -ErrorAction SilentlyContinue
  Write-Host "[$serviceName] supervisor stopped"
  Stop-Transcript | Out-Null
}
