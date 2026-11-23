#requires -RunAsAdministrator
<#
  PC Remote - allow LAN access to the agent while WG Tunnel is running.

  WG Tunnel 2.4.x installs a WFP sublayer (weight 65514) with a catch-all
  "block inbound" filter.  Windows Firewall permit filters live in the
  MPSSVC sublayer with a much lower weight, so they never get evaluated.
  This script adds a narrowly scoped inbound permit in its own sublayer with
  weight 65535, so it is evaluated before WG Tunnel's block.

  Scope: inbound TCP 8765 (HTTP API) and UDP 8766 (discovery) from RFC1918
  (LAN) addresses only.
  WG Tunnel itself is not modified: no provider, sublayer or filter of it is
  touched, and its settings are not changed.

  Remove everything created here with:
      wfp-lan-permit.ps1 -Action Remove

  Actions:
    Probe   - read-only: show our filters, if any
    Add     - create provider/sublayer/filters (idempotent)
    Remove  - delete only the objects created by this script
    Status  - exit 0 if our filters exist, 1 otherwise
#>
[CmdletBinding()]
param(
    [ValidateSet('Probe', 'Add', 'Remove', 'Status')]
    [string]$Action = 'Status'
)

$ErrorActionPreference = 'Stop'

# Keys owned by PC Remote.  Never reuse WG Tunnel keys here.
$ProviderKey = [Guid]'a3f1c2d4-5b6e-4f70-8a91-2c3d4e5f6071'
$SubLayerKey = [Guid]'b4e2d3c5-6c7f-4a81-9ba2-3d4e5f607182'

# One permit per protocol and LAN range.  Keys must stay stable so that
# -Action Remove can delete exactly what this script created.
$Permits = @(
    @{ Protocol = 6;  Port = 8765; Keys = @(   # HTTP API
        [Guid]'c5f3e4d6-7d80-4b92-8cb3-4e5f60718293'
        [Guid]'d6a4f5e7-8e91-4ca3-9dc4-5f60718293a4'
        [Guid]'e7b5a6f8-9fa2-4db4-aed5-60718293a4b5'
    ) }
    @{ Protocol = 17; Port = 8766; Keys = @(   # UDP discovery
        [Guid]'f8c6b7a9-0ab3-4ec5-bfe6-718293a4b5c6'
        [Guid]'a9d7c8b0-1bc4-4fd6-c0f7-8293a4b5c6d7'
        [Guid]'b0e8d9c1-2cd5-40e7-d1a8-93a4b5c6d7e8'
    ) }
)
$FilterKeys = @($Permits | ForEach-Object { $_.Keys })

$AgentPort = 8765

# Well-known WFP constants, confirmed against the live firewall filters:
#   FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4  = e1cd9fe7-f4b5-4273-96c0-592e487b8650
#   FWPM_CONDITION_IP_PROTOCOL          = 3971ef2b-623e-4f9a-8cb1-6e79b806b9a7
#   FWPM_CONDITION_IP_LOCAL_PORT        = 0c1ba1af-5765-453f-af22-a8f791ac775b
#   FWPM_CONDITION_IP_REMOTE_ADDRESS    = b235ae9a-1d64-49b8-a44c-5ff3d9095045
$LayerRecvAcceptV4 = [Guid]'e1cd9fe7-f4b5-4273-96c0-592e487b8650'
$ConditionProtocol = [Guid]'3971ef2b-623e-4f9a-8cb1-6e79b806b9a7'
$ConditionLocalPort = [Guid]'0c1ba1af-5765-453f-af22-a8f791ac775b'
$ConditionRemoteAddr = [Guid]'b235ae9a-1d64-49b8-a44c-5ff3d9095045'

# Remote address ranges as IPv4 network order uint32 (RFC1918 only).
$LanRanges = @(
    @(0xC0A80000L, 0xC0A8FFFFL),  # 192.168.0.0  - 192.168.255.255
    @(0x0A000000L, 0x0AFFFFFFL),  # 10.0.0.0     - 10.255.255.255
    @(0xAC100000L, 0xAC1FFFFFL)   # 172.16.0.0   - 172.31.255.255
)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class Wfp
{
    public const uint RPC_C_AUTHN_WINNT = 10;
    public const uint FWP_ACTION_PERMIT = 0x1002;
    public const uint FWP_MATCH_EQUAL = 0;
    public const uint FWP_MATCH_RANGE = 5;
    public const uint FWP_UINT8 = 1;
    public const uint FWP_UINT16 = 2;
    public const uint FWP_UINT32 = 3;
    public const uint FWP_UINT64 = 4;
    public const uint FWP_RANGE_TYPE = 0x102;

    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    public static extern uint FwpmEngineOpen0(
        IntPtr serverName, uint authnService, IntPtr authIdentity,
        IntPtr session, out IntPtr engineHandle);

    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    public static extern uint FwpmEngineClose0(IntPtr engineHandle);

    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    public static extern uint FwpmProviderAdd0(
        IntPtr engineHandle, IntPtr provider, IntPtr sd);

    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    public static extern uint FwpmSubLayerAdd0(
        IntPtr engineHandle, IntPtr subLayer, IntPtr sd);

    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    public static extern uint FwpmFilterAdd0(
        IntPtr engineHandle, IntPtr filter, IntPtr sd, out ulong id);

    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    public static extern uint FwpmFilterDeleteByKey0(
        IntPtr engineHandle, ref Guid key);

    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    public static extern uint FwpmSubLayerDeleteByKey0(
        IntPtr engineHandle, ref Guid key);

    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    public static extern uint FwpmProviderDeleteByKey0(
        IntPtr engineHandle, ref Guid key);

    [DllImport("fwpuclnt.dll", ExactSpelling = true)]
    public static extern uint FwpmFilterGetByKey0(
        IntPtr engineHandle, IntPtr key, out IntPtr filter);

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
    [FieldOffset(132)] public Guid actionFilterType;
    [FieldOffset(152)] public Guid providerContextKey;
    [FieldOffset(168)] public IntPtr reserved;
    [FieldOffset(176)] public ulong filterId;
    [FieldOffset(184)] public uint effectiveWeightType;
    [FieldOffset(192)] public IntPtr effectiveWeightValue;
}

[StructLayout(LayoutKind.Explicit, Size = 72)]
public struct FWPM_SUBLAYER0
{
    [FieldOffset(0)]  public Guid subLayerKey;
    [FieldOffset(16)] public IntPtr displayName;
    [FieldOffset(24)] public IntPtr displayDescription;
    [FieldOffset(32)] public ushort flags;
    [FieldOffset(40)] public IntPtr providerKey;
    [FieldOffset(48)] public uint providerDataSize;
    [FieldOffset(56)] public IntPtr providerData;
    [FieldOffset(64)] public ushort weight;
}

[StructLayout(LayoutKind.Explicit, Size = 64)]
public struct FWPM_PROVIDER0
{
    [FieldOffset(0)]  public Guid providerKey;
    [FieldOffset(16)] public IntPtr displayName;
    [FieldOffset(24)] public IntPtr displayDescription;
    [FieldOffset(32)] public uint flags;
    [FieldOffset(40)] public uint providerDataSize;
    [FieldOffset(48)] public IntPtr providerData;
    [FieldOffset(56)] public IntPtr serviceName;
}

[StructLayout(LayoutKind.Explicit, Size = 40)]
public struct FWPM_FILTER_CONDITION0
{
    [FieldOffset(0)]  public Guid fieldKey;
    [FieldOffset(16)] public uint matchType;
    [FieldOffset(24)] public uint valueType;
    [FieldOffset(32)] public byte valueU8;
    [FieldOffset(32)] public ushort valueU16;
    [FieldOffset(32)] public uint valueU32;
    [FieldOffset(32)] public IntPtr valuePtr;
}
'@

function New-ZeroedHGlobal([int]$size) {
    $ptr = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)
    $bytes = New-Object byte[] $size
    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $ptr, $size)
    return $ptr
}

function Open-WfpEngine {
    $session = New-ZeroedHGlobal 72
    $engine = [IntPtr]::Zero
    $rc = [Wfp]::FwpmEngineOpen0([IntPtr]::Zero, [Wfp]::RPC_C_AUTHN_WINNT, [IntPtr]::Zero, $session, [ref]$engine)
    [Runtime.InteropServices.Marshal]::FreeHGlobal($session)
    if ($rc -ne 0) {
        throw ("FwpmEngineOpen0 failed: 0x{0:X8}" -f $rc)
    }
    return $engine
}

function Write-U32([IntPtr]$ptr, [int]$offset, [uint32]$value) {
    $bytes = [BitConverter]::GetBytes($value)
    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, [IntPtr]::Add($ptr, $offset), 4)
}

function New-RangeBuffer([uint32]$low, [uint32]$high) {
    $ptr = New-ZeroedHGlobal 32
    Write-U32 $ptr 0 ([Wfp]::FWP_UINT32)
    Write-U32 $ptr 8 $low
    Write-U32 $ptr 16 ([Wfp]::FWP_UINT32)
    Write-U32 $ptr 24 $high
    return $ptr
}

function Invoke-Add {
    $engine = Open-WfpEngine
    $ptrs = New-Object System.Collections.ArrayList
    try {
        # Drop stale copies of our own objects (errors are expected on first run).
        foreach ($k0 in $FilterKeys) {
            $k = $k0
            [Wfp]::FwpmFilterDeleteByKey0($engine, [ref]$k) | Out-Null
        }
        $k = $SubLayerKey
        [Wfp]::FwpmSubLayerDeleteByKey0($engine, [ref]$k) | Out-Null
        $k = $ProviderKey
        [Wfp]::FwpmProviderDeleteByKey0($engine, [ref]$k) | Out-Null

        # Provider.
        $provider = [FWPM_PROVIDER0]::new()
        $provider.providerKey = $ProviderKey
        $providerName = [Runtime.InteropServices.Marshal]::StringToHGlobalUni('PC Remote LAN Permit')
        [void]$ptrs.Add($providerName)
        $provider.displayName = $providerName
        $provider.flags = 1
        $providerPtr = New-ZeroedHGlobal 64
        [void]$ptrs.Add($providerPtr)
        [Runtime.InteropServices.Marshal]::StructureToPtr($provider, $providerPtr, $false)
        $rc = [Wfp]::FwpmProviderAdd0($engine, $providerPtr, [IntPtr]::Zero)
        if ($rc -ne 0) { throw ("FwpmProviderAdd0 failed: 0x{0:X8}" -f $rc) }

        # Sublayer with weight above WG Tunnel's 65514.
        $subLayer = [FWPM_SUBLAYER0]::new()
        $subLayer.subLayerKey = $SubLayerKey
        $subLayerName = [Runtime.InteropServices.Marshal]::StringToHGlobalUni('PC Remote LAN Permit Sublayer')
        [void]$ptrs.Add($subLayerName)
        $subLayer.displayName = $subLayerName
        $subLayer.flags = 1
        $subProvider = New-ZeroedHGlobal 16
        [void]$ptrs.Add($subProvider)
        [Runtime.InteropServices.Marshal]::StructureToPtr($ProviderKey, $subProvider, $false)
        $subLayer.providerKey = $subProvider
        $subLayer.weight = 65535
        $subLayerPtr = New-ZeroedHGlobal 72
        [void]$ptrs.Add($subLayerPtr)
        [Runtime.InteropServices.Marshal]::StructureToPtr($subLayer, $subLayerPtr, $false)
        $rc = [Wfp]::FwpmSubLayerAdd0($engine, $subLayerPtr, [IntPtr]::Zero)
        if ($rc -ne 0) { throw ("FwpmSubLayerAdd0 failed: 0x{0:X8}" -f $rc) }

        # One filter per protocol and LAN range.
        foreach ($permit in $Permits) {
            $protoName = if ($permit.Protocol -eq 6) { 'TCP' } else { 'UDP' }
            for ($i = 0; $i -lt $LanRanges.Count; $i++) {
                $low = [uint32]$LanRanges[$i][0]
                $high = [uint32]$LanRanges[$i][1]

                $condPtr = New-ZeroedHGlobal (40 * 3)
                [void]$ptrs.Add($condPtr)

                $c0 = [FWPM_FILTER_CONDITION0]::new()
                $c0.fieldKey = $ConditionProtocol
                $c0.matchType = [Wfp]::FWP_MATCH_EQUAL
                $c0.valueType = [Wfp]::FWP_UINT8
                $c0.valueU8 = [byte]$permit.Protocol
                [Runtime.InteropServices.Marshal]::StructureToPtr($c0, [IntPtr]::Add($condPtr, 0), $false)

                $c1 = [FWPM_FILTER_CONDITION0]::new()
                $c1.fieldKey = $ConditionLocalPort
                $c1.matchType = [Wfp]::FWP_MATCH_EQUAL
                $c1.valueType = [Wfp]::FWP_UINT16
                $c1.valueU16 = [uint16]$permit.Port
                [Runtime.InteropServices.Marshal]::StructureToPtr($c1, [IntPtr]::Add($condPtr, 40), $false)

                $rangePtr = New-RangeBuffer $low $high
                [void]$ptrs.Add($rangePtr)

                $c2 = [FWPM_FILTER_CONDITION0]::new()
                $c2.fieldKey = $ConditionRemoteAddr
                $c2.matchType = [Wfp]::FWP_MATCH_RANGE
                $c2.valueType = [Wfp]::FWP_RANGE_TYPE
                $c2.valuePtr = $rangePtr
                [Runtime.InteropServices.Marshal]::StructureToPtr($c2, [IntPtr]::Add($condPtr, 80), $false)

                $filter = [FWPM_FILTER0]::new()
                $filter.filterKey = $permit.Keys[$i]
                $filterName = [Runtime.InteropServices.Marshal]::StringToHGlobalUni(
                    ("PC Remote {0} {1} LAN permit ({2})" -f $protoName, $permit.Port, (Describe-Range $low $high)))
                [void]$ptrs.Add($filterName)
                $filter.displayName = $filterName
                $filter.flags = 1
                $filter.layerKey = $LayerRecvAcceptV4
                $filter.subLayerKey = $SubLayerKey
                # Weight 1 inside our sublayer; any value works, this layer is above WG.
                $weightPtr = New-ZeroedHGlobal 8
                [void]$ptrs.Add($weightPtr)
                [Runtime.InteropServices.Marshal]::WriteInt64($weightPtr, 0, 1)
                $filter.weightType = [Wfp]::FWP_UINT64
                $filter.weightValue = $weightPtr
                $filter.numFilterConditions = 3
                $filter.filterCondition = $condPtr
                $filter.actionType = [Wfp]::FWP_ACTION_PERMIT
                $filterPtr = New-ZeroedHGlobal 200
                [void]$ptrs.Add($filterPtr)
                [Runtime.InteropServices.Marshal]::StructureToPtr($filter, $filterPtr, $false)

                $id = [uint64]0
                $rc = [Wfp]::FwpmFilterAdd0($engine, $filterPtr, [IntPtr]::Zero, [ref]$id)
                if ($rc -ne 0) { throw ("FwpmFilterAdd0 failed: 0x{0:X8}" -f $rc) }
                Write-Output ("Added {0} {1} {2} (id {3})" -f $protoName, $permit.Port, (Describe-Range $low $high), $id)
            }
        }

        Write-Output "OK"
    }
    finally {
        foreach ($p in $ptrs) {
            [Runtime.InteropServices.Marshal]::FreeHGlobal($p)
        }
        [Wfp]::FwpmEngineClose0($engine) | Out-Null
    }
}

function Describe-Range([uint32]$low, [uint32]$high) {
    $a = ($low -shr 24) -band 0xFF; $b = ($low -shr 16) -band 0xFF
    $c = ($low -shr 8) -band 0xFF;  $d = $low -band 0xFF
    $e = ($high -shr 24) -band 0xFF; $f = ($high -shr 16) -band 0xFF
    $g = ($high -shr 8) -band 0xFF;  $h = $high -band 0xFF
    return ("{0}.{1}.{2}.{3}..{4}.{5}.{6}.{7}" -f $a, $b, $c, $d, $e, $f, $g, $h)
}

function Invoke-Remove {
    $engine = Open-WfpEngine
    try {
        foreach ($k0 in $FilterKeys) {
            $k = $k0
            $rc = [Wfp]::FwpmFilterDeleteByKey0($engine, [ref]$k)
            Write-Output ("filter delete: 0x{0:X8}" -f $rc)
        }
        $k = $SubLayerKey
        $rc = [Wfp]::FwpmSubLayerDeleteByKey0($engine, [ref]$k)
        Write-Output ("sublayer delete: 0x{0:X8}" -f $rc)
        $k = $ProviderKey
        $rc = [Wfp]::FwpmProviderDeleteByKey0($engine, [ref]$k)
        Write-Output ("provider delete: 0x{0:X8}" -f $rc)
    }
    finally {
        [Wfp]::FwpmEngineClose0($engine) | Out-Null
    }
}

function Invoke-Status {
    $engine = Open-WfpEngine
    try {
        $found = 0
        foreach ($key in $FilterKeys) {
            $ptr = [IntPtr]::Zero
            $g = $key
            # FwpmFilterGetByKey0 takes a pointer to the GUID.
            $h = [Runtime.InteropServices.Marshal]::AllocHGlobal(16)
            try {
                [Runtime.InteropServices.Marshal]::StructureToPtr($key, $h, $false)
                $rc = [Wfp]::FwpmFilterGetByKey0($engine, $h, [ref]$ptr)
            }
            finally {
                [Runtime.InteropServices.Marshal]::FreeHGlobal($h)
            }
            if ($rc -eq 0) {
                $found++
                $filter = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][FWPM_FILTER0])
                $name = [Runtime.InteropServices.Marshal]::PtrToStringUni($filter.displayName)
                Write-Output ("filter {0}: {1} action=0x{2:X8}" -f $key, $name, $filter.actionType)
                [Wfp]::FwpmFreeMemory0([ref]$ptr)
            } else {
                Write-Output ("filter {0}: not found (0x{1:X8})" -f $key, $rc)
            }
        }
        if ($found -eq 0) { exit 1 }
    }
    finally {
        [Wfp]::FwpmEngineClose0($engine) | Out-Null
    }
}

switch ($Action) {
    'Probe'  { Invoke-Status }
    'Add'    { Invoke-Add }
    'Remove' { Invoke-Remove }
    'Status' { Invoke-Status }
}
