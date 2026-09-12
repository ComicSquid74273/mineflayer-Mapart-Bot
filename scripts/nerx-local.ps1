param(
  [ValidateSet('start', 'stop', 'restart', 'status', 'setup')]
  [string] $Action = 'status'
)

. "$PSScriptRoot\nerx-common.ps1"

switch ($Action) {
  'setup' {
    Ensure-NerxNodeWorkspaces
  }
  'start' {
    Start-NerxDashboard
    Start-Sleep -Seconds 2
    foreach ($node in Get-NerxNodeDefinitions) { Start-NerxBotNode -Node $node }
    Write-Host '[all] dashboard: http://127.0.0.1:4080/'
  }
  'stop' {
    foreach ($node in Get-NerxNodeDefinitions) { Stop-NerxManagedProcess -Name $node.Id }
    Stop-NerxManagedProcess -Name 'dashboard'
  }
  'restart' {
    foreach ($node in Get-NerxNodeDefinitions) { Stop-NerxManagedProcess -Name $node.Id }
    Stop-NerxManagedProcess -Name 'dashboard'
    Start-Sleep -Seconds 2
    Start-NerxDashboard
    Start-Sleep -Seconds 2
    foreach ($node in Get-NerxNodeDefinitions) { Start-NerxBotNode -Node $node }
    Write-Host '[all] dashboard: http://127.0.0.1:4080/'
  }
  'status' {
    Show-NerxManagedProcessStatus -Name 'dashboard'
    foreach ($node in Get-NerxNodeDefinitions) { Show-NerxManagedProcessStatus -Name $node.Id }
  }
}
