<#
  One-time setup of the live-voice Claude Code mod on Windows: a Python venv in
  -Dir with faster-whisper, sounddevice and numpy, and the Whisper -Model
  downloaded to -Dir\models (small is about 480 MB). /listen setup runs it.
#>
param(
  [Parameter(Mandatory = $true)][string]$Dir,
  [string]$Model = 'small'
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$venv = Join-Path $Dir 'venv'
$py = Join-Path $venv 'Scripts\python.exe'

if (-not (Test-Path $py)) {
  if (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3 -m venv $venv
  } elseif (Get-Command python -ErrorAction SilentlyContinue) {
    & python -m venv $venv
  } else {
    throw 'Python 3.10 or newer is needed: https://www.python.org/downloads/'
  }
  if (-not (Test-Path $py)) { throw "could not create the Python environment in $venv" }
}

& $py -m pip install --disable-pip-version-check -q faster-whisper sounddevice numpy
if ($LASTEXITCODE) { throw "pip install failed (exit $LASTEXITCODE)" }

$env:HF_HUB_DISABLE_SYMLINKS_WARNING = '1'
& $py -I (Join-Path $PSScriptRoot 'listen.py') --models (Join-Path $Dir 'models') --model $Model --download
if ($LASTEXITCODE) { throw "the Whisper model $Model could not be downloaded" }
"live voice is set up in $Dir"
