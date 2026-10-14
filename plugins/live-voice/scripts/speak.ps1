<#
  The voice of the live-voice Claude Code mod on Windows.

  Reads text from standard input and speaks it with a Windows voice for -Language.
  It uses the WinRT synthesizer, which reaches the OneCore voices (such as
  Microsoft Frank for nl-NL) that System.Speech cannot. While it plays, it stops
  as soon as -StopFile holds "hush" or "stop". -OutFile writes the WAV instead.
#>
param(
  [string]$Language = 'nl',
  [string]$Voice = '',
  [string]$StopFile = '',
  [string]$OutFile = ''
)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$text = [Console]::In.ReadToEnd()
if (-not $text.Trim()) { exit 0 }

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$voices = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices
$pick = if ($Voice) { $voices | Where-Object { $_.DisplayName -eq $Voice } }
if (-not $pick) { $pick = $voices | Where-Object { $_.Language -eq $Language } }
if (-not $pick) { $pick = $voices | Where-Object { $_.Language -like "$($Language.Split('-')[0])-*" } }
if ($pick) { $synth.Voice = @($pick)[0] }

$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
$task = $asTask.MakeGenericMethod([Windows.Media.SpeechSynthesis.SpeechSynthesisStream]).Invoke($null, @($synth.SynthesizeTextToStreamAsync($text)))
$task.Wait()
$wav = New-Object System.IO.MemoryStream
[System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($task.Result).CopyTo($wav)

if ($OutFile) {
  [System.IO.File]::WriteAllBytes($OutFile, $wav.ToArray())
  exit 0
}

# The byte rate sits at offset 28 of the WAV header; the length gives the duration.
$byteRate = [BitConverter]::ToUInt32($wav.ToArray(), 28)
$seconds = ($wav.Length - 44) / [Math]::Max(1, $byteRate)
$wav.Position = 0
$player = New-Object System.Media.SoundPlayer $wav
$player.Load()
$player.Play()
$until = (Get-Date).AddSeconds($seconds + 0.3)
while ((Get-Date) -lt $until) {
  Start-Sleep -Milliseconds 100
  if ($StopFile -and (Test-Path $StopFile)) {
    $word = (Get-Content -Raw $StopFile).Trim()
    if ($word -eq 'hush' -or $word -eq 'stop') { $player.Stop(); break }
  }
}
