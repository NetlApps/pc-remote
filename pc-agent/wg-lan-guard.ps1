#requires -RunAsAdministrator
<#
  PC Remote - LAN guard for WG Tunnel (Windows).

  Background: WG Tunnel 2.4.1 creates four catch-all WFP block filters in its
  own dynamic session when a VPN tunnel starts.  Its "Allow LAN traffic"
  option is supposed to add permits for RFC1918 networks, but on this build it
  fails with:

      KillSwitch: parse allowed networks: netip.ParsePrefix(...): no '/'

  As a result, all LAN traffic (including the PC Remote agent on TCP 8765 and
  UDP 8766) is blocked while the VPN tunnel is up, even with the kill switch
  off.

  A filter cannot be added into WG's dynamic sublayer from another process
  (FWP_E_WRONG_SESSION), but its filters can be deleted by key.  This guard
  keeps the two IPv4 catch-all blocks removed while leaving WG's tunnel
  permits and the IPv6 blocks intact.  The VPN tunnel itself is not touched.

  Only the exact filters named "WGTunnel-Block inbound all (IPv4)" and
  "WGTunnel-Block outbound all (IPv4)" in WG's sublayer are removed.  If WG
  changes those names, the guard will not delete anything.

  The guard pauses while WG's kill switch is enabled, so it never weakens
  kill-switch protection: it only restores LAN access when WG itself is
  supposed to allow LAN traffic (kill switch off).  The kill-switch state is
  read from WG's cache file.

  Run as SYSTEM at boot (scheduled task PCRemoteLanGuard).  To stop it:
      Stop-ScheduledTask -TaskName PCRemoteLanGuard
  To remove it:
      Unregister-ScheduledTask -TaskName PCRemoteLanGuard -Confirm:$false
#>

param(
    [switch]$Once
)

$ErrorActionPreference = 'Stop'
$LogPath = Join-Path $PSScriptRoot 'lan_guard.log'
$MutexName = 'Global\PcRemoteLanGuard'
$KillSwitchCache = 'C:\ProgramData\wgtunnel\cache.properties'
$WgSubLayer = [Guid]'6bf7cff1-91e4-4369-9d8b-ec46f3b71c36'
$LayerConnectV4 = [Guid]'c38d57d1-05a7-4c33-904f-7fbceee60e82'
$LayerRecvAcceptV4 = [Guid]'e1cd9fe7-f4b5-4273-96c0-592e487b8650'
$BlockNames = @(
    'WGTunnel-Block inbound all (IPv4)',
    'WGTunnel-Block outbound all (IPv4)'
)

function Write-GuardLog {
    param([string]$Message)
    try {
        $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
        Add-Content -LiteralPath $LogPath -Value $line -Encoding utf8
        if ((Get-Item -LiteralPath $LogPath -ErrorAction SilentlyContinue).Length -gt 1MB) {
            Move-Item -LiteralPath $LogPath -Destination ($LogPath + '.1') -Force
        }
    } catch {
        # logging must never stop the guard
    }
}

$mutex = New-Object System.Threading.Mutex($false, $MutexName)
$acquired = $false
try {
    $acquired = $mutex.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
    $acquired = $true
}
if (-not $acquired) {
    exit 0
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class PcRemoteWfp
{
    public const uint RPC_C_AUTHN_WINNT = 10;

    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    public static extern uint FwpmEngineOpen0(IntPtr serverName, uint authnService, IntPtr authIdentity, IntPtr session, out IntPtr engineHandle);

    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    public static extern uint FwpmEngineClose0(IntPtr engineHandle);

    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    public static extern uint FwpmFilterCreateEnumHandle0(IntPtr engineHandle, IntPtr enumTemplate, out IntPtr enumHandle);

    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    public static extern uint FwpmFilterEnum0(IntPtr engineHandle, IntPtr enumHandle, uint numEntriesRequested, out IntPtr entries, out uint numEntriesReturned);

    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    public static extern uint FwpmFilterDestroyEnumHandle0(IntPtr engineHandle, IntPtr enumHandle);

    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    public static extern uint FwpmFilterDeleteByKey0(IntPtr engineHandle, ref Guid key);

    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    public static extern void FwpmFreeMemory0(ref IntPtr p);
}

[StructLayout(LayoutKind.Explicit, Size = 200)]
public struct FWPM_FILTER0
{
    [FieldOffset(0)]   public Guid filterKey;
    [FieldOffset(16)]  public IntPtr displayName;
    [FieldOffset(24)]  public IntPtr displayDescription;
    [FieldOffset(32)]  public uint flags;
    [FieldOffset(40)]  public IntPtr providerKey;
    [FieldOffset(48)]  public uint providerDataSize;
    [FieldOffset(56)]  public IntPtr providerData;
    [FieldOffset(64)]  public Guid layerKey;
    [FieldOffset(80)]  public Guid subLayerKey;
    [FieldOffset(96)]  public uint weightType;
    [FieldOffset(104)] public IntPtr weightValue;
    [FieldOffset(112)] public uint numFilterConditions;
    [FieldOffset(120)] public IntPtr filterCondition;
    [FieldOffset(128)] public uint actionType;
    [FieldOffset(136)] public Guid actionFilterType;
    [FieldOffset(152)] public Guid providerContextKey;
    [FieldOffset(168)] public IntPtr reserved;
    [FieldOffset(176)] public ulong filterId;
    [FieldOffset(184)] public uint effectiveWeightType;
    [FieldOffset(192)] public IntPtr effectiveWeightValue;
}

[StructLayout(LayoutKind.Explicit, Size = 72)]
public struct FWPM_FILTER_ENUM_TEMPLATE0
{
    [FieldOffset(0)]  public IntPtr providerKey;
    [FieldOffset(8)]  public Guid layerKey;
    [FieldOffset(24)] public uint enumType;
    [FieldOffset(28)] public uint flags;
    [FieldOffset(32)] public IntPtr providerContextTemplate;
    [FieldOffset(40)] public uint numFilterConditions;
    [FieldOffset(48)] public IntPtr filterCondition;
    [FieldOffset(56)] public uint actionMask;
    [FieldOffset(64)] public IntPtr calloutKey;
}
'@

function Remove-WgIpv4Blocks {
    param([IntPtr]$Engine)

    $deleted = 0
    foreach ($layer in @($LayerConnectV4, $LayerRecvAcceptV4)) {
        $tpl = [FWPM_FILTER_ENUM_TEMPLATE0]::new()
        $tpl.layerKey = $layer
        $tpl.enumType = 0
        $tpl.flags = 0
        $tpl.actionMask = [uint32]::MaxValue
        $tpl.numFilterConditions = 0
        $tplPtr = [Runtime.InteropServices.Marshal]::AllocHGlobal(72)
        try {
            [Runtime.InteropServices.Marshal]::StructureToPtr($tpl, $tplPtr, $false)
            $enumHandle = [IntPtr]::Zero
            $rc = [PcRemoteWfp]::FwpmFilterCreateEnumHandle0($Engine, $tplPtr, [ref]$enumHandle)
            if ($rc -ne 0) {
                Write-GuardLog ("createEnum layer={0} rc=0x{1:X8}" -f $layer, $rc)
                continue
            }
        } finally {
            [Runtime.InteropServices.Marshal]::FreeHGlobal($tplPtr)
        }

        try {
            while ($true) {
                $entries = [IntPtr]::Zero
                $returned = [uint32]0
                $rc = [PcRemoteWfp]::FwpmFilterEnum0($Engine, $enumHandle, 100, [ref]$entries, [ref]$returned)
                if ($rc -ne 0) {
                    Write-GuardLog ("enum layer={0} rc=0x{1:X8}" -f $layer, $rc)
                    break
                }
                if ($returned -eq 0) { break }
                try {
                    for ($i = 0; $i -lt $returned; $i++) {
                        $ptr = [Runtime.InteropServices.Marshal]::ReadIntPtr($entries, $i * 8)
                        $f = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][FWPM_FILTER0])
                        if ($f.subLayerKey -ne $WgSubLayer) { continue }
                        if ($f.actionType -ne 0x1001) { continue }
                        if ($f.displayName -eq [IntPtr]::Zero) { continue }
                        $name = [Runtime.InteropServices.Marshal]::PtrToStringUni($f.displayName)
                        if ($BlockNames -notcontains $name) { continue }

                        $key = $f.filterKey
                        $delRc = [PcRemoteWfp]::FwpmFilterDeleteByKey0($Engine, [ref]$key)
                        if ($delRc -eq 0 -or $delRc -eq 0x80320003) {
                            $deleted++
                        } else {
                            Write-GuardLog ("delete {0} rc=0x{1:X8}" -f $key, $delRc)
                        }
                    }
                } finally {
                    [PcRemoteWfp]::FwpmFreeMemory0([ref]$entries)
                }
            }
        } finally {
            [PcRemoteWfp]::FwpmFilterDestroyEnumHandle0($Engine, $enumHandle) | Out-Null
        }
    }
    return $deleted
}

function Get-KillSwitchEnabled {
    # $true / $false, or $null when the state cannot be read.
    try {
        if (-not (Test-Path -LiteralPath $KillSwitchCache)) { return $null }
        $match = Select-String -LiteralPath $KillSwitchCache `
            -Pattern '^\s*killswitch_enabled\s*=\s*(true|false)\s*$' `
            -ErrorAction Stop | Select-Object -First 1
        if (-not $match) { return $null }
        return ($match.Matches[0].Groups[1].Value -eq 'true')
    } catch {
        return $null
    }
}

$engine = [IntPtr]::Zero
$rc = [PcRemoteWfp]::FwpmEngineOpen0([IntPtr]::Zero, [PcRemoteWfp]::RPC_C_AUTHN_WINNT, [IntPtr]::Zero, [IntPtr]::Zero, [ref]$engine)
if ($rc -ne 0) {
    Write-GuardLog ("startup: FwpmEngineOpen0 rc=0x{0:X8}" -f $rc)
    exit 1
}

Write-GuardLog ("started pid={0} once={1}" -f $PID, $Once)
$lastKs = $null
try {
    do {
        try {
            $ks = Get-KillSwitchEnabled
            if ($ks -ne $false) {
                if ($ks -ne $lastKs) {
                    $label = if ($ks -eq $true) { 'on' } else { 'unknown' }
                    Write-GuardLog ("kill switch {0}: LAN guard paused" -f $label)
                    $lastKs = $ks
                }
            } else {
                if ($lastKs -ne $false) {
                    Write-GuardLog 'kill switch off: LAN guard active'
                    $lastKs = $false
                }
                $n = Remove-WgIpv4Blocks -Engine $engine
                if ($n -gt 0) {
                    Write-GuardLog ("removed {0} WG IPv4 block filter(s)" -f $n)
                }
            }
        } catch {
            Write-GuardLog ("loop error: {0}" -f $_.Exception.Message)
        }
        if (-not $Once) { Start-Sleep -Seconds 2 }
    } while (-not $Once)
} finally {
    [PcRemoteWfp]::FwpmEngineClose0($engine) | Out-Null
    $mutex.ReleaseMutex()
}

