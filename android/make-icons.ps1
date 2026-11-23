$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$res = Join-Path $PSScriptRoot 'res'
$densities = [ordered]@{
  'mipmap-mdpi'    = 48
  'mipmap-hdpi'    = 72
  'mipmap-xhdpi'   = 96
  'mipmap-xxhdpi'  = 144
  'mipmap-xxxhdpi' = 192
}

function New-RoundedPath([float]$x, [float]$y, [float]$width, [float]$height, [float]$radius) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $diameter = $radius * 2
  $path.AddArc($x, $y, $diameter, $diameter, 180, 90)
  $path.AddArc($x + $width - $diameter, $y, $diameter, $diameter, 270, 90)
  $path.AddArc($x + $width - $diameter, $y + $height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($x, $y + $height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-AppIcon([int]$size, [string]$targetPath) {
  $scale = $size / 192.0
  $bitmap = New-Object System.Drawing.Bitmap($size, $size)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.Clear([System.Drawing.Color]::Transparent)

  $radius = [Math]::Max(2.0, 42.0 * $scale)
  $backgroundPath = New-RoundedPath 0.5 0.5 ($size - 1.0) ($size - 1.0) $radius
  $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
  $background = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 12, 20, 35),
    [System.Drawing.Color]::FromArgb(255, 13, 61, 96),
    48
  )
  $graphics.FillPath($background, $backgroundPath)

  $ringPen = New-Object System.Drawing.Pen(
    [System.Drawing.Color]::FromArgb(38, 56, 189, 248),
    [Math]::Max(1.0, 2.0 * $scale)
  )
  $graphics.DrawEllipse(
    $ringPen,
    [float](28 * $scale),
    [float](28 * $scale),
    [float](136 * $scale),
    [float](136 * $scale)
  )

  $glowPen = New-Object System.Drawing.Pen(
    [System.Drawing.Color]::FromArgb(45, 56, 189, 248),
    [Math]::Max(3.0, 25.0 * $scale)
  )
  $glowPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $glowPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $graphics.DrawArc(
    $glowPen,
    [float](52 * $scale),
    [float](56 * $scale),
    [float](88 * $scale),
    [float](88 * $scale),
    -60,
    300
  )
  $graphics.DrawLine(
    $glowPen,
    [float](96 * $scale),
    [float](38 * $scale),
    [float](96 * $scale),
    [float](100 * $scale)
  )

  $pen = New-Object System.Drawing.Pen(
    [System.Drawing.Color]::FromArgb(255, 86, 210, 255),
    [Math]::Max(2.0, 14.0 * $scale)
  )
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $graphics.DrawArc(
    $pen,
    [float](52 * $scale),
    [float](56 * $scale),
    [float](88 * $scale),
    [float](88 * $scale),
    -60,
    300
  )
  $graphics.DrawLine(
    $pen,
    [float](96 * $scale),
    [float](38 * $scale),
    [float](96 * $scale),
    [float](100 * $scale)
  )

  $directory = Split-Path -Parent $targetPath
  if (-not (Test-Path $directory)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
  }
  $bitmap.Save($targetPath, [System.Drawing.Imaging.ImageFormat]::Png)

  $pen.Dispose()
  $glowPen.Dispose()
  $ringPen.Dispose()
  $background.Dispose()
  $backgroundPath.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
}

foreach ($entry in $densities.GetEnumerator()) {
  $target = Join-Path (Join-Path $res $entry.Key) 'ic_launcher.png'
  New-AppIcon $entry.Value $target
  Write-Host ("Иконка: {0} ({1}px)" -f $target, $entry.Value)
}

New-AppIcon 512 (Join-Path $PSScriptRoot 'icon-preview.png')
Write-Host 'Готово.'
