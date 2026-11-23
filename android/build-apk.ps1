param(
  [switch]$Install
)

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$OutApk = Join-Path $ProjectRoot 'PcRemote.apk'
$ManifestPath = Join-Path $PSScriptRoot 'AndroidManifest.xml'
$AssetsDir = Join-Path $PSScriptRoot 'assets'
$Build = Join-Path $PSScriptRoot 'build'
$KeystoreDir = Join-Path $PSScriptRoot 'keystore'
$Keystore = Join-Path $KeystoreDir 'pcremote.jks'

$ManifestText = Get-Content $ManifestPath -Raw
if ($ManifestText -match 'android:versionCode="(\d+)"') {
  $VersionCode = [int]$Matches[1]
} else {
  throw 'versionCode не найден в AndroidManifest.xml'
}
if ($ManifestText -match 'android:versionName="([^"]+)"') {
  $VersionName = $Matches[1]
} else {
  throw 'versionName не найден в AndroidManifest.xml'
}

if (-not (Test-Path (Join-Path $AssetsDir 'www\index.html'))) {
  throw "Не найдены веб-ассеты: $AssetsDir\www\index.html"
}

$VersionFile = Join-Path $ProjectRoot 'version.json'
if (Test-Path $VersionFile) {
  $VersionInfo = Get-Content $VersionFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([int]$VersionInfo.versionCode -ne $VersionCode) {
    throw "version.json: versionCode $($VersionInfo.versionCode), а в AndroidManifest.xml — $VersionCode"
  }
  if ([string]$VersionInfo.versionName -ne $VersionName) {
    throw "version.json: versionName $($VersionInfo.versionName), а в AndroidManifest.xml — $VersionName"
  }
}

if (-not $env:JAVA_HOME) {
  $jdkCandidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Android Studio\jbr'),
    (Join-Path $env:ProgramFiles 'Android\Android Studio\jbr'),
    (Join-Path $env:ProgramFiles 'Java\jdk-17'),
    (Join-Path $env:USERPROFILE 'android-tools\jdk\jdk-17.0.20.1+1')
  )
  foreach ($candidate in $jdkCandidates) {
    if ($candidate -and (Test-Path (Join-Path $candidate 'bin\javac.exe'))) {
      $env:JAVA_HOME = $candidate
      break
    }
  }
}
if (-not $env:JAVA_HOME -or -not (Test-Path (Join-Path $env:JAVA_HOME 'bin\javac.exe'))) {
  throw 'Не найден JDK 17. Установите JDK и задайте переменную JAVA_HOME.'
}

if (-not $env:ANDROID_HOME) {
  $sdkCandidates = @(
    (Join-Path $env:LOCALAPPDATA 'Android\Sdk'),
    (Join-Path $env:USERPROFILE 'android-tools\sdk'),
    (Join-Path $env:ProgramFiles 'Android\Sdk')
  )
  foreach ($candidate in $sdkCandidates) {
    if ($candidate -and (Test-Path (Join-Path $candidate 'platforms'))) {
      $env:ANDROID_HOME = $candidate
      break
    }
  }
}
if (-not $env:ANDROID_HOME -or -not (Test-Path (Join-Path $env:ANDROID_HOME 'platforms'))) {
  throw 'Не найден Android SDK. Задайте переменную ANDROID_HOME.'
}

$JdkBin = Join-Path $env:JAVA_HOME 'bin'
$BuildTools = Get-ChildItem (Join-Path $env:ANDROID_HOME 'build-tools') -Directory -ErrorAction SilentlyContinue |
  Where-Object { Test-Path (Join-Path $_.FullName 'aapt2.exe') } |
  Sort-Object Name -Descending |
  Select-Object -First 1
if (-not $BuildTools) { throw 'В Android SDK нет build-tools с aapt2.exe' }
$BuildTools = $BuildTools.FullName
$PlatformDir = Get-ChildItem (Join-Path $env:ANDROID_HOME 'platforms') -Directory -ErrorAction SilentlyContinue |
  Where-Object { Test-Path (Join-Path $_.FullName 'android.jar') } |
  Sort-Object Name -Descending |
  Select-Object -First 1
if (-not $PlatformDir) { throw 'В Android SDK нет platforms с android.jar' }
$PlatformJar = Join-Path $PlatformDir.FullName 'android.jar'
$env:Path = "$JdkBin;$BuildTools;$env:Path"

$Python = (Get-Command python.exe -ErrorAction SilentlyContinue).Source
if (-not $Python) { throw 'Python 3 не найден: он нужен для нормализации путей внутри APK' }

foreach ($tool in @(
  (Join-Path $JdkBin 'java.exe'),
  (Join-Path $JdkBin 'javac.exe'),
  (Join-Path $JdkBin 'jar.exe'),
  (Join-Path $JdkBin 'keytool.exe'),
  (Join-Path $BuildTools 'aapt2.exe'),
  (Join-Path $BuildTools 'd8.bat'),
  (Join-Path $BuildTools 'zipalign.exe'),
  (Join-Path $BuildTools 'apksigner.bat')
)) {
  if (-not (Test-Path $tool)) { throw "Не найден инструмент: $tool" }
}
if (-not (Test-Path $PlatformJar)) { throw "Не найден android.jar: $PlatformJar" }

Write-Host 'Подготовка каталога сборки…'
if (Test-Path $Build) { Remove-Item $Build -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $Build 'gen') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Build 'classes') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Build 'dex') | Out-Null

Write-Host 'Компиляция ресурсов…'
& (Join-Path $BuildTools 'aapt2.exe') compile --dir (Join-Path $PSScriptRoot 'res') -o (Join-Path $Build 'res.zip')
if ($LASTEXITCODE -ne 0) { throw 'aapt2 compile завершился с ошибкой' }

Write-Host 'Связывание ресурсов и манифеста…'
$linkArgs = @(
  'link',
  '-o', (Join-Path $Build 'base.apk'),
  '-I', $PlatformJar,
  '--manifest', $ManifestPath,
  '-R', (Join-Path $Build 'res.zip'),
  '-A', $AssetsDir,
  '--java', (Join-Path $Build 'gen'),
  '--min-sdk-version', '24',
  '--target-sdk-version', '34',
  '--version-code', "$VersionCode",
  '--version-name', "$VersionName",
  '--auto-add-overlay'
)
& (Join-Path $BuildTools 'aapt2.exe') @linkArgs
if ($LASTEXITCODE -ne 0) { throw 'aapt2 link завершился с ошибкой' }

Write-Host 'Компиляция Java…'
$sources = @((Join-Path $Build 'gen\ru\netla\pcremote\R.java'))
$sources += Get-ChildItem (Join-Path $PSScriptRoot 'src') -Recurse -Filter *.java |
  ForEach-Object { $_.FullName }
& (Join-Path $JdkBin 'javac.exe') -encoding UTF-8 -source 8 -target 8 `
  -classpath $PlatformJar -d (Join-Path $Build 'classes') @sources
if ($LASTEXITCODE -ne 0) { throw 'javac завершился с ошибкой' }

Write-Host 'Сборка dex…'
& (Join-Path $JdkBin 'jar.exe') cf (Join-Path $Build 'classes.jar') -C (Join-Path $Build 'classes') .
if ($LASTEXITCODE -ne 0) { throw 'jar classes завершился с ошибкой' }
& (Join-Path $BuildTools 'd8.bat') --lib $PlatformJar --min-api 24 `
  --output (Join-Path $Build 'dex') (Join-Path $Build 'classes.jar')
if ($LASTEXITCODE -ne 0) { throw 'd8 завершился с ошибкой' }

Write-Host 'Упаковка…'
& (Join-Path $JdkBin 'jar.exe') uf (Join-Path $Build 'base.apk') -C (Join-Path $Build 'dex') classes.dex
if ($LASTEXITCODE -ne 0) { throw 'упаковка classes.dex завершилась с ошибкой' }

Write-Host 'Выравнивание…'
& (Join-Path $BuildTools 'zipalign.exe') -f -p 4 (Join-Path $Build 'base.apk') (Join-Path $Build 'aligned.apk')
if ($LASTEXITCODE -ne 0) { throw 'zipalign завершился с ошибкой' }

Write-Host 'Исправление путей assets…'
& $Python (Join-Path $PSScriptRoot 'fix-apk-names.py') (Join-Path $Build 'aligned.apk')
if ($LASTEXITCODE -ne 0) { throw 'Не удалось нормализовать пути assets в APK' }

if (-not (Test-Path $Keystore)) {
  Write-Host 'Создание ключа подписи…'
  New-Item -ItemType Directory -Force -Path $KeystoreDir | Out-Null
  & (Join-Path $JdkBin 'keytool.exe') -genkeypair -v `
    -keystore $Keystore `
    -alias pcremote `
    -keyalg RSA `
    -keysize 2048 `
    -validity 10000 `
    -storepass pcremote `
    -keypass pcremote `
    -dname 'CN=PC Remote, OU=Local, O=NeTLA, L=Local, ST=Local, C=RU'
  if ($LASTEXITCODE -ne 0) { throw 'keytool завершился с ошибкой' }
}

Write-Host 'Подпись…'
& (Join-Path $BuildTools 'apksigner.bat') sign `
  --ks $Keystore `
  --ks-key-alias pcremote `
  --ks-pass pass:pcremote `
  --key-pass pass:pcremote `
  --out $OutApk (Join-Path $Build 'aligned.apk')
if ($LASTEXITCODE -ne 0) { throw 'apksigner sign завершился с ошибкой' }

Write-Host 'Проверка подписи…'
& (Join-Path $BuildTools 'apksigner.bat') verify --verbose $OutApk
if ($LASTEXITCODE -ne 0) { throw 'apksigner verify завершился с ошибкой' }

$apk = Get-Item $OutApk
Write-Host ''
Write-Host ("APK: {0} ({1:N1} MB)" -f $apk.FullName, ($apk.Length / 1MB)) -ForegroundColor Green
Write-Host ''

if ($Install) {
  $adb = (Get-Command adb -ErrorAction SilentlyContinue).Source
  if (-not $adb) {
    $candidate = 'C:\Users\NeTLA\platform-tools\adb.exe'
    if (Test-Path $candidate) { $adb = $candidate }
  }
  if (-not $adb) { throw 'adb не найден' }
  Write-Host 'Установка на подключённый телефон…'
  & $adb install -r $OutApk
  if ($LASTEXITCODE -ne 0) { throw 'adb install завершился с ошибкой' }
}
