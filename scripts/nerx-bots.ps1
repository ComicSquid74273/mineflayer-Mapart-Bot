param(
  [ValidateSet('start', 'stop', 'restart', 'status')]
  [string] $Action = 'status',

  [string] $Node = 'all'
)

. "$PSScriptRoot\nerx-common.ps1"

$selectedNodes = Resolve-NerxNodeSelection -Node $Node

switch ($Action) {
  'start' {
    foreach ($selectedNode in $selectedNodes) { Start-NerxBotNode -Node $selectedNode }
  }
  'stop' {
    foreach ($selectedNode in $selectedNodes) { Stop-NerxManagedProcess -Name $selectedNode.Id }
  }
  'restart' {
    foreach ($selectedNode in $selectedNodes) { Stop-NerxManagedProcess -Name $selectedNode.Id }
    Start-Sleep -Seconds 2
    foreach ($selectedNode in $selectedNodes) { Start-NerxBotNode -Node $selectedNode }
  }
  'status' {
    foreach ($selectedNode in $selectedNodes) { Show-NerxManagedProcessStatus -Name $selectedNode.Id }
  }
}
