#requires -RunAsAdministrator
<#
  Installs the PC Remote LAN guard scheduled task.
  Run this from an elevated PowerShell (the main installer does it for you).
#>
$ErrorActionPreference = 'Stop'

$TaskName = 'PCRemoteLanGuard'
$GuardScript = Join-Path $PSScriptRoot 'wg-lan-guard.ps1'

if (-not (Test-Path -LiteralPath $GuardScript)) {
    throw "Guard script not found: $GuardScript"
}

# Убираем объекты WFP, которые могла оставить старая версия установщика.
$LegacyWfp = Join-Path $PSScriptRoot 'wfp-lan-permit.ps1'
if (Test-Path -LiteralPath $LegacyWfp) {
    try { & $LegacyWfp -Action Remove | Out-Null } catch { }
}

$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $GuardScript)
$trigger = New-ScheduledTaskTrigger -AtStartup

$principal = New-ScheduledTaskPrincipal `
    -UserId 'SYSTEM' `
    -LogonType ServiceAccount `
    -RunLevel Highest

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description 'PC Remote - keeps WG Tunnel IPv4 LAN block filters removed so the phone can reach the agent.' `
    -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Write-Output "Installed and started scheduled task: $TaskName"
Write-Output "Guard script: $GuardScript"
