param(
  [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$dir = $PSScriptRoot
$agentPath = Join-Path $dir 'pc_agent.py'
$sessionHelperPath = Join-Path $dir 'session_helper.py'
$configPath = Join-Path $dir 'config.json'
$logPath = Join-Path $dir 'pc_agent.log'
$sessionLogPath = Join-Path $dir 'session_helper.log'
$taskName = 'PCRemoteAgent'
$lockTaskName = 'PCRemoteLock'
$helperTaskName = 'PCRemoteHelper'
$firewallTcp = 'PC Remote Agent (TCP)'
$firewallUdp = 'PC Remote Agent (UDP)'

function Pause-IfNeeded {
  if (-not $NoPause) { Read-Host 'Нажмите Enter, чтобы закрыть' | Out-Null }
}

function Fail([string]$message) {
  Write-Host ''
  Write-Host $message -ForegroundColor Red
  Pause-IfNeeded
  exit 1
}

Write-Host ''
Write-Host '  ПК Пульт — установка агента на ПК' -ForegroundColor Cyan
Write-Host '  ==================================' -ForegroundColor DarkCyan
Write-Host ''

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Fail 'Нужны права администратора. Запустите setup.cmd (или PowerShell от имени администратора).'
}

if (-not (Test-Path $agentPath)) {
  Fail "Не найден файл агента: $agentPath"
}
if (-not (Test-Path $sessionHelperPath)) {
  Fail "Не найден помощник сессии: $sessionHelperPath"
}

# --- Python ---------------------------------------------------------------

$pythonCandidates = @(
  'C:\Users\NeTLA\AppData\Local\Programs\Python\Python312\python.exe',
  (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\python.exe'),
  'C:\Python312\python.exe',
  'C:\Python311\python.exe'
)
$python = $null
foreach ($candidate in $pythonCandidates) {
  if ($candidate -and (Test-Path $candidate)) { $python = $candidate; break }
}
if (-not $python) {
  $command = Get-Command python.exe -ErrorAction SilentlyContinue
  if ($command) { $python = $command.Source }
}
if (-not $python) {
  Fail 'Python 3 не найден. Установите Python с python.org (галочка «Add Python to PATH») и повторите.'
}
$pythonw = Join-Path (Split-Path $python) 'pythonw.exe'
if (-not (Test-Path $pythonw)) { $pythonw = $python }

Write-Host "Python: $python" -ForegroundColor DarkGray

# --- Конфигурация ---------------------------------------------------------

& $python $agentPath --init | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'Не удалось создать config.json' }

$config = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$token = [string]$config.token
$port = [int]$config.port
$discoveryPort = [int]$config.discovery_port
$sessionPort = 8767
if ($config.PSObject.Properties.Name -contains 'session_port') {
  $sessionPort = [int]$config.session_port
}

$infoJson = & $python $agentPath --info
if ($LASTEXITCODE -ne 0) { Fail 'Не удалось получить сведения о ПК' }
$info = $infoJson | ConvertFrom-Json

# --- Останавливаем старые копии -------------------------------------------

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
}
if (Get-ScheduledTask -TaskName $helperTaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $helperTaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $helperTaskName -Confirm:$false -ErrorAction SilentlyContinue
}
Get-CimInstance Win32_Process -Filter "Name = 'python.exe' OR Name = 'pythonw.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and ($_.CommandLine.Contains($agentPath) -or $_.CommandLine.Contains($sessionHelperPath)) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 700

# --- Задача автозапуска (SYSTEM, старт при загрузке) -----------------------

Write-Host 'Создаю задачу автозапуска…'
$agentAction = New-ScheduledTaskAction -Execute $pythonw -Argument ('"' + $agentPath + '"') -WorkingDirectory $dir
$agentTrigger = New-ScheduledTaskTrigger -AtStartup
$agentSettings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Days 3650) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)
$agentPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask `
  -TaskName $taskName `
  -Description 'PC Remote Agent — приём команд от приложения «ПК Пульт»' `
  -Action $agentAction `
  -Trigger $agentTrigger `
  -Settings $agentSettings `
  -Principal $agentPrincipal `
  -Force | Out-Null

# --- Задача блокировки в сессии пользователя ------------------------------

Write-Host 'Создаю задачу блокировки экрана…'
$consoleUser = $null
try {
  $consoleUser = (Get-CimInstance Win32_ComputerSystem -ErrorAction Stop).UserName
} catch {}
if (-not $consoleUser) { $consoleUser = $identity.Name }

if (Get-ScheduledTask -TaskName $lockTaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $lockTaskName -Confirm:$false -ErrorAction SilentlyContinue
}
$lockAction = New-ScheduledTaskAction -Execute 'rundll32.exe' -Argument 'user32.dll,LockWorkStation'
$lockSettings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
$lockPrincipal = New-ScheduledTaskPrincipal -UserId $consoleUser -LogonType Interactive -RunLevel Limited
Register-ScheduledTask `
  -TaskName $lockTaskName `
  -Description 'Блокировка экрана по команде PC Remote Agent' `
  -Action $lockAction `
  -Settings $lockSettings `
  -Principal $lockPrincipal `
  -Force | Out-Null

# --- Помощник в сессии пользователя ---------------------------------------

Write-Host 'Создаю помощника для громкости, медиа, скриншотов и программ…'
$helperAction = New-ScheduledTaskAction -Execute $pythonw -Argument ('"' + $sessionHelperPath + '"') -WorkingDirectory $dir
$helperTrigger = New-ScheduledTaskTrigger -AtLogOn -User $consoleUser
$helperSettings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Days 3650) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)
$helperPrincipal = New-ScheduledTaskPrincipal -UserId $consoleUser -LogonType Interactive -RunLevel Limited
Register-ScheduledTask `
  -TaskName $helperTaskName `
  -Description 'PC Remote Helper — команды в интерактивной сессии пользователя' `
  -Action $helperAction `
  -Trigger $helperTrigger `
  -Settings $helperSettings `
  -Principal $helperPrincipal `
  -Force | Out-Null

try {
  Start-ScheduledTask -TaskName $helperTaskName -ErrorAction Stop
} catch {
  Write-Host '  Помощник запустится при следующем входе пользователя в Windows.' -ForegroundColor Yellow
}
Start-Sleep -Milliseconds 1200

$sessionReady = $false
try {
  $health = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/health" -f $sessionPort) -TimeoutSec 4
  $sessionReady = [bool]$health.ok
} catch {
  $sessionReady = $false
}

# --- Брандмауэр -----------------------------------------------------------

Write-Host 'Открываю порты в брандмауэре (только локальная сеть)…'
foreach ($ruleName in @($firewallTcp, $firewallUdp, 'PC Remote Agent (TCP 8765)', 'PC Remote Agent (UDP 8766)')) {
  Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction SilentlyContinue
}
New-NetFirewallRule `
  -DisplayName $firewallTcp `
  -Description 'PC Remote Agent — HTTP-команды' `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort $port `
  -Profile Any `
  -RemoteAddress LocalSubnet | Out-Null
New-NetFirewallRule `
  -DisplayName $firewallUdp `
  -Description 'PC Remote Agent — поиск в сети' `
  -Direction Inbound `
  -Action Allow `
  -Protocol UDP `
  -LocalPort $discoveryPort `
  -Profile Any `
  -RemoteAddress LocalSubnet | Out-Null

# --- Запуск и проверка ----------------------------------------------------

Write-Host 'Запускаю агента…'
Start-ScheduledTask -TaskName $taskName

$status = $null
for ($attempt = 1; $attempt -le 5; $attempt++) {
  Start-Sleep -Seconds 2
  try {
    $status = Invoke-RestMethod `
      -Uri ("http://127.0.0.1:{0}/status" -f $port) `
      -Headers @{ 'X-Auth-Token' = $token } `
      -TimeoutSec 5
    break
  } catch {
    $status = $null
  }
}

Write-Host ''
if ($status) {
  Write-Host '  ГОТОВО — агент установлен и работает' -ForegroundColor Green
} else {
  Write-Host '  Агент установлен, но пока не отвечает' -ForegroundColor Yellow
  Write-Host '  Последние строки журнала:' -ForegroundColor DarkGray
  if (Test-Path $logPath) {
    Get-Content $logPath -Tail 15 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
  }
}
if ($sessionReady) {
  Write-Host '  Помощник сессии: работает (громкость, медиа, скриншоты, программы)' -ForegroundColor Green
} else {
  Write-Host '  Помощник сессии: не отвечает' -ForegroundColor Yellow
  Write-Host '  Он запустится при входе пользователя в Windows. Проверьте задачу PCRemoteHelper.' -ForegroundColor DarkGray
  if (Test-Path $sessionLogPath) {
    Get-Content $sessionLogPath -Tail 8 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
  }
}
Write-Host ''
Write-Host '  ================ ДАННЫЕ ДЛЯ ТЕЛЕФОНА ================' -ForegroundColor Cyan
Write-Host ("   Имя ПК:    {0}" -f $info.hostname)
Write-Host ("   IP-адрес:  {0}" -f $info.ip)
Write-Host ("   MAC:       {0}" -f $info.mac)
Write-Host ("   Порт:      {0}" -f $port)
Write-Host ("   Токен:     {0}" -f $token) -ForegroundColor Yellow
Write-Host '  ====================================================' -ForegroundColor Cyan
Write-Host ''
Write-Host '  Дальше: установите APK, откройте приложение, нажмите'
Write-Host '  «Найти ПК в сети» и введите токен. IP и MAC подставятся сами.'
Write-Host ''
Write-Host '  Токен также сохранён в файле:' -ForegroundColor DarkGray
Write-Host "    $configPath" -ForegroundColor DarkGray
Write-Host ''

Pause-IfNeeded
