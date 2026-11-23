param(
  [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

function Pause-IfNeeded {
  if (-not $NoPause) { Read-Host 'Нажмите Enter, чтобы закрыть' | Out-Null }
}

$dir = $PSScriptRoot
$configPath = Join-Path $dir 'config.json'
$agentPath = Join-Path $dir 'pc_agent.py'

if (-not (Test-Path $configPath)) {
  Write-Host 'config.json ещё не создан. Сначала запустите установку агента.' -ForegroundColor Yellow
  Pause-IfNeeded
  exit 1
}

$pythonCandidates = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\python.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python310\python.exe'),
  'C:\Python312\python.exe',
  'C:\Python311\python.exe',
  'C:\Python310\python.exe'
)
$python = $null
foreach ($candidate in $pythonCandidates) {
  if ($candidate -and (Test-Path $candidate)) { $python = $candidate; break }
}
if (-not $python) {
  $command = Get-Command python.exe -ErrorAction SilentlyContinue
  if ($command) { $python = $command.Source }
}

$config = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$token = [string]$config.token
$port = [int]$config.port
$sessionPort = 8767
if ($config.PSObject.Properties.Name -contains 'session_port') {
  $sessionPort = [int]$config.session_port
}
$info = $null
if ($python) {
  try { $info = (& $python $agentPath --info | ConvertFrom-Json) } catch {}
}

Write-Host ''
Write-Host '  Данные для подключения телефона' -ForegroundColor Cyan
Write-Host '  ===============================' -ForegroundColor DarkCyan
if ($info) {
  Write-Host ("   Имя ПК:    {0}" -f $info.hostname)
  Write-Host ("   IP-адрес:  {0}" -f $info.ip)
  Write-Host ("   MAC:       {0}" -f $info.mac)
}
Write-Host ("   Порт:      {0}" -f $port)
Write-Host ("   Токен:     {0}" -f $token) -ForegroundColor Yellow
Write-Host '  ===============================' -ForegroundColor DarkCyan
Write-Host ''

foreach ($taskName in @('PCRemoteAgent', 'PCRemoteHelper')) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task) {
    $taskInfo = Get-ScheduledTaskInfo -TaskName $taskName
    Write-Host ("  Задача {0}: {1}" -f $taskName, $task.State)
    Write-Host ("    Последний запуск: {0}" -f $taskInfo.LastRunTime)
  } else {
    Write-Host ("  Задача {0} не установлена." -f $taskName) -ForegroundColor Yellow
  }
}

try {
  $status = Invoke-RestMethod `
    -Uri ("http://127.0.0.1:{0}/status" -f $port) `
    -Headers @{ 'X-Auth-Token' = $token } `
    -TimeoutSec 5
  Write-Host ("  Агент отвечает:   да ({0})" -f $status.hostname) -ForegroundColor Green
  if ($status.session -and $status.session.ok) {
    Write-Host ("  Помощник сессии:  да (сессия {0}, пользователь {1})" -f $status.session.session_id, $status.session.user) -ForegroundColor Green
  } else {
    Write-Host '  Помощник сессии:  нет — войдите в Windows и проверьте задачу PCRemoteHelper.' -ForegroundColor Red
  }
} catch {
  Write-Host '  Агент отвечает:   нет' -ForegroundColor Red
  Write-Host '  Проверьте задачу PCRemoteAgent и журнал pc_agent.log.' -ForegroundColor DarkGray
}

try {
  $health = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/health" -f $sessionPort) -TimeoutSec 4
  Write-Host ("  Помощник /health: да (версия {0})" -f $health.version) -ForegroundColor Green
} catch {
  Write-Host '  Помощник /health: нет' -ForegroundColor Red
}

Write-Host ''
Pause-IfNeeded
