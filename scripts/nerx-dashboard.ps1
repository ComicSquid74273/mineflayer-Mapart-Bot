param(
  [ValidateSet('start', 'stop', 'restart', 'status')]
  [string] $Action = 'status'
)

. "$PSScriptRoot\nerx-common.ps1"

switch ($Action) {
  'start' {
    Start-NerxDashboard
    Write-Host '[dashboard] open http://127.0.0.1:4080/'
  }
  'stop' {
    Stop-NerxManagedProcess -Name 'dashboard'
  }
  'restart' {
    Stop-NerxManagedProcess -Name 'dashboard'
    Start-Sleep -Seconds 2
    Start-NerxDashboard
    Write-Host '[dashboard] open http://127.0.0.1:4080/'
  }
  'status' {
    Show-NerxManagedProcessStatus -Name 'dashboard'
  }
}
