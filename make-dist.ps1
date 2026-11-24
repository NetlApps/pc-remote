param(
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$apk = Join-Path $root 'PcRemote.apk'
$out = Join-Path $root 'PcRemote.zip'
$stageRoot = Join-Path $env:TEMP ('pcremote-dist-' + [Guid]::NewGuid().ToString('N'))
$stage = Join-Path $stageRoot 'PcRemote'

if (-not $SkipBuild) {
  & (Join-Path $root 'android\build-apk.ps1')
  if ($LASTEXITCODE -ne 0) { throw 'Сборка APK завершилась с ошибкой' }
}
if (-not (Test-Path $apk)) { throw "Не найден APK: $apk" }

try {
  New-Item -ItemType Directory -Force -Path $stage | Out-Null

  Copy-Item (Join-Path $root 'README.md') $stage
  Copy-Item (Join-Path $root 'version.json') $stage
  Copy-Item $apk $stage
  Copy-Item (Join-Path $root 'docs') (Join-Path $stage 'docs') -Recurse

  $agentStage = Join-Path $stage 'pc-agent'
  New-Item -ItemType Directory -Force -Path $agentStage | Out-Null
  foreach ($name in @(
    'pc_agent.py',
    'session_helper.py',
    'install-agent.ps1',
    'uninstall-agent.ps1',
    'wg-lan-guard.ps1',
    'install-lan-guard.ps1',
    'agent-info.ps1',
    'setup.cmd',
    'remove-agent.cmd',
    'run-agent.bat',
    'config.example.json'
  )) {
    $source = Join-Path $root ('pc-agent\' + $name)
    if (Test-Path $source) { Copy-Item $source $agentStage }
  }

  $androidStage = Join-Path $stage 'android'
  New-Item -ItemType Directory -Force -Path $androidStage | Out-Null
  foreach ($name in @(
    'AndroidManifest.xml',
    'build-apk.ps1',
    'fix-apk-names.py',
    'make-icons.ps1'
  )) {
    Copy-Item (Join-Path $root ('android\' + $name)) $androidStage
  }
  foreach ($dirName in @('src', 'assets', 'res')) {
    Copy-Item (Join-Path $root ('android\' + $dirName)) (Join-Path $androidStage $dirName) -Recurse
  }

  $forbidden = Get-ChildItem $stage -Recurse -File | Where-Object {
    $_.Name -in @('config.json', 'pc_agent.log', 'session_helper.log', 'pcremote.jks') -or
    $_.FullName -match '\\__pycache__\\' -or
    $_.FullName -match '\\android\\build\\'
  }
  if ($forbidden) {
    throw ('В архив попали служебные файлы: ' + (($forbidden | ForEach-Object FullName) -join ', '))
  }

  if (Test-Path $out) { Remove-Item $out -Force }
  Compress-Archive -Path $stage -DestinationPath $out -CompressionLevel Optimal
  $item = Get-Item $out
  Write-Host ''
  Write-Host ("Архив: {0} ({1:N2} MB)" -f $item.FullName, ($item.Length / 1MB)) -ForegroundColor Green
} finally {
  if (Test-Path $stageRoot) { Remove-Item $stageRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
