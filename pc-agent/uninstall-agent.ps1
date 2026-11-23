param(
  [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

function Pause-IfNeeded {
  if (-not $NoPause) { Read-Host 'Нажмите Enter, чтобы закрыть' | Out-Null }
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'Нужны права администратора. Запустите remove-agent.cmd.' -ForegroundColor Red
  Pause-IfNeeded
  exit 1
}

Write-Host ''
Write-Host '  Удаление агента «ПК Пульт»' -ForegroundColor Cyan
Write-Host ''

foreach ($taskName in @('PCRemoteAgent', 'PCRemoteLock', 'PCRemoteHelper')) {
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Задача удалена: $taskName"
  }
}

foreach ($ruleName in @('PC Remote Agent (TCP)', 'PC Remote Agent (UDP)', 'PC Remote Agent (TCP 8765)', 'PC Remote Agent (UDP 8766)')) {
  $rules = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
  if ($rules) {
    $rules | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    Write-Host "Правило брандмауэра удалено: $ruleName"
  }
}

$wfpScript = Join-Path $PSScriptRoot 'wfp-lan-permit.ps1'
if (Test-Path $wfpScript) {
  try {
    & $wfpScript -Action Remove | Out-Null
    Write-Host 'Разрешение WFP для WG Tunnel удалено'
  } catch {
    Write-Host ('Не удалось удалить разрешение WFP: ' + $_.Exception.Message) -ForegroundColor Yellow
  }
}

$agentPath = Join-Path $PSScriptRoot 'pc_agent.py'
$sessionHelperPath = Join-Path $PSScriptRoot 'session_helper.py'
Get-CimInstance Win32_Process -Filter "Name = 'python.exe' OR Name = 'pythonw.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and ($_.CommandLine.Contains($agentPath) -or $_.CommandLine.Contains($sessionHelperPath)) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Write-Host ''
Write-Host 'Агент удалён. config.json и журнал оставлены в папке агента.' -ForegroundColor Green
Write-Host ''
Pause-IfNeeded
