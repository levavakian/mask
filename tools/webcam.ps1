<#
  Take a photo or record a short video with a Windows webcam, using the camera API built into
  Windows (WinRT MediaCapture), so nothing needs installing. Runs in Windows PowerShell 5.1.
  From WSL use `nix run .#webcam` (see README), which calls this script.

    -Mode photo   Save one frame (.png or .jpg) once auto-exposure has settled.
    -Mode video   Record -Seconds of H.264 video (.mp4).
    -Mode list    Print the cameras and the sizes/frame rates they support.

  -Exposure auto|-13..-1 sets the exposure time as log2(seconds) (-8 = 1/256 s). A short manual
  exposure helps keep bright LEDs from saturating; auto exposure is put back afterwards.
#>
param(
  [ValidateSet('photo', 'video', 'list')]
  [string]$Mode = 'photo',
  [string]$Out = '',
  [string]$Camera = '',
  [string]$Size = '',
  [string]$Exposure = 'auto',
  [double]$Seconds = 5,
  [int]$MaxWarmupMs = 8000
)
$ErrorActionPreference = 'Stop'
# Print failures as one line (no PowerShell stack noise) and exit non-zero; finally blocks still run first.
trap { [Console]::Error.WriteLine('webcam: ' + $_.Exception.Message); exit 1 }
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Drawing

$null = [Windows.Devices.Enumeration.DeviceInformation, Windows.Devices.Enumeration, ContentType = WindowsRuntime]
$null = [Windows.Devices.Enumeration.DeviceInformationCollection, Windows.Devices.Enumeration, ContentType = WindowsRuntime]
$null = [Windows.Media.Capture.MediaCapture, Windows.Media.Capture, ContentType = WindowsRuntime]
$null = [Windows.Media.Capture.Frames.MediaFrameReader, Windows.Media.Capture, ContentType = WindowsRuntime]
$null = [Windows.Media.MediaProperties.MediaEncodingProfile, Windows.Media.MediaProperties, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFolder, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.Buffer, Windows.Storage.Streams, ContentType = WindowsRuntime]

# PowerShell can't await WinRT async calls, so convert them to .NET tasks and block on those.
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 }
$asTaskOp = $asTask | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
$asTaskAction = $asTask | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1

function Wait-Task($task) {
  try { $task.Wait() | Out-Null }
  catch {
    $e = $_.Exception
    while ($e.InnerException) { $e = $e.InnerException }
    throw $e
  }
}
function Await($operation, [Type]$resultType) {
  $task = $asTaskOp.MakeGenericMethod($resultType).Invoke($null, @($operation))
  Wait-Task $task
  $task.Result
}
function Await-Action($action) { Wait-Task ($asTaskAction.Invoke($null, @($action))) }

function Get-Cameras {
  Await ([Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync(
      [Windows.Devices.Enumeration.DeviceClass]::VideoCapture)) ([Windows.Devices.Enumeration.DeviceInformationCollection])
}

function Open-Camera($device, [string]$sharing, [bool]$cpuFrames) {
  $settings = New-Object Windows.Media.Capture.MediaCaptureInitializationSettings
  $settings.VideoDeviceId = $device.Id
  $settings.StreamingCaptureMode = [Windows.Media.Capture.StreamingCaptureMode]::Video
  $settings.SharingMode = [Windows.Media.Capture.MediaCaptureSharingMode]::$sharing
  if ($cpuFrames) { $settings.MemoryPreference = [Windows.Media.Capture.MediaCaptureMemoryPreference]::Cpu }
  $capture = New-Object Windows.Media.Capture.MediaCapture
  Await-Action ($capture.InitializeAsync($settings))
  $capture
}

function Get-ColorSource($capture) {
  foreach ($pair in $capture.FrameSources) {
    if ($pair.Value.Info.SourceKind -eq [Windows.Media.Capture.Frames.MediaFrameSourceKind]::Color) { return $pair.Value }
  }
  throw 'The camera has no color stream.'
}

function Get-Fps($rate) { [math]::Round($rate.Numerator / [math]::Max(1, $rate.Denominator)) }

function Format-Sizes($formats) {
  ($formats | ForEach-Object { '{0}x{1}@{2}' -f $_.VideoFormat.Width, $_.VideoFormat.Height, (Get-Fps $_.FrameRate) } |
    Sort-Object -Unique) -join ' '
}

# Pick the requested size (or the largest one), at the highest frame rate.
function Select-Format($formats, [string]$size) {
  $candidates = $formats
  if ($size) {
    $w, $h = $size -split 'x' | ForEach-Object { [int]$_ }
    $candidates = $formats | Where-Object { $_.VideoFormat.Width -eq $w -and $_.VideoFormat.Height -eq $h }
    if (-not $candidates) { throw "This camera can't do $size; it can do $(Format-Sizes $formats)" }
  }
  $candidates | Sort-Object -Descending `
    { $_.VideoFormat.Width * $_.VideoFormat.Height }, { Get-Fps $_.FrameRate } | Select-Object -First 1
}

function Set-Exposure($capture, [string]$value) {
  $control = $capture.VideoDeviceController.Exposure
  $caps = $control.Capabilities
  if (-not $caps.Supported) { throw 'This camera has no exposure control.' }
  $v = [double]$value
  if ($v -lt $caps.Min -or $v -gt $caps.Max) { throw "Exposure must be between $($caps.Min) and $($caps.Max)." }
  if (-not ($control.TrySetAuto($false) -and $control.TrySetValue($v))) { throw 'The camera refused the exposure setting.' }
}

# Average of a sparse sample of the pixel bytes (alpha skipped); good enough to see exposure settle.
function Get-MeanLevel([byte[]]$bytes) {
  $sum = 0L; $n = 0
  for ($i = 0; $i -lt $bytes.Length; $i += 4001) { if (($i % 4) -ne 3) { $sum += $bytes[$i]; $n++ } }
  $sum / [math]::Max(1, $n)
}

function Read-Frame($reader) {
  $frame = $reader.TryAcquireLatestFrame()
  if (-not $frame) { return $null }
  try {
    $bitmap = $frame.VideoMediaFrame.SoftwareBitmap
    if (-not $bitmap) { return $null }
    $buffer = New-Object Windows.Storage.Streams.Buffer([uint32]($bitmap.PixelWidth * $bitmap.PixelHeight * 4))
    $bitmap.CopyToBuffer($buffer)
    @{
      Width  = $bitmap.PixelWidth
      Height = $bitmap.PixelHeight
      Bytes  = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]::ToArray($buffer)
    }
  } finally { $frame.Dispose() }
}

# Read frames until the picture stops changing brightness (auto-exposure settled), then return the last one.
function Read-SettledFrame($reader, [int]$maxMs) {
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  $last = $null; $previous = -1.0; $steady = 0
  while ($clock.ElapsedMilliseconds -lt $maxMs) {
    Start-Sleep -Milliseconds 200
    $frame = Read-Frame $reader
    if (-not $frame) { continue }
    $level = Get-MeanLevel $frame.Bytes
    # The first frames can be blank, so only settle on black once a really short exposure could explain it.
    $lit = $level -gt 0 -or $clock.ElapsedMilliseconds -ge 2500
    if ($previous -ge 0 -and $lit -and [math]::Abs($level - $previous) -lt 1.5) { $steady++ } else { $steady = 0 }
    $previous = $level; $last = $frame
    if ($steady -ge 4 -and $clock.ElapsedMilliseconds -ge 1500) { break }
  }
  if (-not $last) { throw 'The camera stopped sending frames.' }
  $last.Level = $previous
  $last
}

function Save-Image($frame, [string]$path) {
  $bitmap = New-Object System.Drawing.Bitmap($frame.Width, $frame.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppRgb)
  try {
    $rect = New-Object System.Drawing.Rectangle(0, 0, $frame.Width, $frame.Height)
    $data = $bitmap.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::WriteOnly, $bitmap.PixelFormat)
    [System.Runtime.InteropServices.Marshal]::Copy($frame.Bytes, 0, $data.Scan0, $frame.Bytes.Length)
    $bitmap.UnlockBits($data)
    $stream = New-Object System.IO.MemoryStream
    if ($path -match '\.jpe?g$') {
      $jpeg = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
      $params = New-Object System.Drawing.Imaging.EncoderParameters(1)
      $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]92)
      $bitmap.Save($stream, $jpeg, $params)
    } else {
      $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    # Plain file IO so that \\wsl.localhost\... paths work too.
    [System.IO.File]::WriteAllBytes($path, $stream.ToArray())
  } finally { $bitmap.Dispose() }
}

function Close-Stream($stream) {
  if ($stream.Reader) { try { Await-Action ($stream.Reader.StopAsync()) } catch {} }
  $stream.Capture.Dispose()
}

# Open the camera, start a frame stream and wait for its first frame. Exclusive access is needed to
# change size or exposure; shared read-only access works while another app is using the camera.
# Returns $null if this kind of access gets no frames.
function Start-Stream($device, [string]$sharing, [string]$size) {
  try {
    $capture = Open-Camera $device $sharing $true
  } catch {
    if ($_.Exception -is [System.UnauthorizedAccessException]) {
      throw "Windows blocked camera access. Turn on Settings > Privacy & security > Camera > 'Let desktop apps access your camera'."
    }
    return $null
  }
  $stream = @{ Capture = $capture; Exclusive = ($sharing -eq 'ExclusiveControl'); Reader = $null }
  try {
    $stream.Source = Get-ColorSource $capture
    if ($stream.Exclusive) { Await-Action ($stream.Source.SetFormatAsync((Select-Format $stream.Source.SupportedFormats $size))) }
    $stream.Reader = Await ($capture.CreateFrameReaderAsync($stream.Source, 'BGRA8')) ([Windows.Media.Capture.Frames.MediaFrameReader])
    $status = Await ($stream.Reader.StartAsync()) ([Windows.Media.Capture.Frames.MediaFrameReaderStartStatus])
    if ($status -eq [Windows.Media.Capture.Frames.MediaFrameReaderStartStatus]::Success) {
      $clock = [System.Diagnostics.Stopwatch]::StartNew()
      while ($clock.ElapsedMilliseconds -lt 3000) {
        Start-Sleep -Milliseconds 100
        if (Read-Frame $stream.Reader) { return $stream }
      }
    }
  } catch {
    Close-Stream $stream
    throw
  }
  Close-Stream $stream
  $null
}

$cameras = @(Get-Cameras)
if (-not $cameras) { throw 'Windows reports no cameras.' }

if ($Mode -eq 'list') {
  foreach ($device in $cameras) {
    try {
      # Exclusive access lists the sizes we can actually select.
      try { $capture = Open-Camera $device 'ExclusiveControl' $true } catch { $capture = Open-Camera $device 'SharedReadOnly' $true }
      Write-Output ('{0}: {1}' -f $device.Name, (Format-Sizes (Get-ColorSource $capture).SupportedFormats))
      $capture.Dispose()
    } catch { Write-Output ('{0}: (could not open: {1})' -f $device.Name, $_.Exception.Message) }
  }
  return
}

$device = $cameras | Where-Object { $_.Name -like "*$Camera*" } | Select-Object -First 1
if (-not $device) { throw "No camera matches '$Camera'. Cameras: $(($cameras | ForEach-Object Name) -join ', ')" }
if (-not $Out) { $Out = Join-Path $env:TEMP ('webcam.' + $(if ($Mode -eq 'video') { 'mp4' } else { 'png' })) }

$stream = Start-Stream $device 'ExclusiveControl' $Size
if (-not $stream) {
  # Windows may grant exclusive access to a camera another app is streaming from, then send no frames.
  Write-Warning 'Another app seems to be using the camera; sharing it read-only, so -Size and -Exposure are ignored.'
  $stream = Start-Stream $device 'SharedReadOnly' $Size
}
if (-not $stream) { throw 'No frames arrived from the camera.' }
$capture = $stream.Capture
# Only touch exposure once frames are flowing, so a busy camera's other app is never affected.
$manualExposure = $stream.Exclusive -and $Exposure -ne 'auto'
try {
  if ($manualExposure) { Set-Exposure $capture $Exposure }
  $format = $stream.Source.CurrentFormat
  Write-Output ('camera: {0} {1}x{2}@{3} exposure={4}{5}' -f $device.Name, $format.VideoFormat.Width,
    $format.VideoFormat.Height, (Get-Fps $format.FrameRate), $(if ($manualExposure) { $Exposure } else { 'auto' }),
    $(if ($stream.Exclusive) { '' } else { ' (shared)' }))

  # Let exposure settle; for video the stream keeps running, so the recording starts settled.
  $frame = Read-SettledFrame $stream.Reader $MaxWarmupMs

  if ($Mode -eq 'photo') {
    Save-Image $frame $Out
    Write-Output ('saved: {0} ({1}x{2}, mean level {3:N0}/255)' -f $Out, $frame.Width, $frame.Height, $frame.Level)
  } else {
    $encoding = [Windows.Media.MediaProperties.MediaEncodingProfile]::CreateMp4([Windows.Media.MediaProperties.VideoEncodingQuality]::Auto)
    $encoding.Audio = $null
    # MediaCapture records to a StorageFile, so record into %TEMP% and move the file afterwards.
    $folder = Await ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync($env:TEMP)) ([Windows.Storage.StorageFolder])
    $file = Await ($folder.CreateFileAsync('webcam-recording.mp4',
        [Windows.Storage.CreationCollisionOption]::GenerateUniqueName)) ([Windows.Storage.StorageFile])
    Await-Action ($capture.StartRecordToStorageFileAsync($encoding, $file))
    Start-Sleep -Milliseconds ([int]($Seconds * 1000))
    Await-Action ($capture.StopRecordAsync())
    Move-Item -LiteralPath $file.Path -Destination $Out -Force
    Write-Output ('saved: {0} ({1:N1} s)' -f $Out, $Seconds)
  }
} finally {
  # Exposure is a camera setting that can outlive this process; give other apps auto exposure back.
  if ($manualExposure) { $null = $capture.VideoDeviceController.Exposure.TrySetAuto($true) }
  Close-Stream $stream
}
