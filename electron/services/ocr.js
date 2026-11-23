'use strict'
/**
 * Reads text from pictures with the OCR engine built into Windows 10/11 (Windows.Media.Ocr), for
 * PDFs that are only page images (exported slides, scans) and for photos/screenshots.
 * Runs offline, on this computer; nothing is uploaded. Returns '' when OCR isn't available
 * (macOS/Linux, no OCR language installed) or the picture has no readable text.
 */
const { execFile } = require('child_process')
const path = require('path')

// The script is passed inline (-EncodedCommand) so it also works from inside the packaged app.asar.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$m = [System.WindowsRuntimeSystemExtensions].GetMethods()
$asOp = ($m | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation${'`'}1' })[0]
$asAct = ($m | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
function Await($op, [Type]$t) { $k = $asOp.MakeGenericMethod($t).Invoke($null, @($op)); $k.Wait() | Out-Null; $k.Result }
function AwaitAction($op) { $asAct.Invoke($null, @($op)).Wait() | Out-Null }
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) { exit 0 }
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($P)) ([Windows.Storage.StorageFile])
function Read-Bitmap($stream) {
  $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bmp = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  if ($bmp.PixelWidth -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension -or $bmp.PixelHeight -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension) { return '' }
  (Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])).Text
}
$out = @()
if ($P.ToLower().EndsWith('.pdf')) {
  $pdf = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
  for ($i = 0; $i -lt [Math]::Min($N, $pdf.PageCount); $i++) {
    $s = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    $o = New-Object Windows.Data.Pdf.PdfPageRenderOptions
    $o.DestinationWidth = 1600
    AwaitAction ($pdf.GetPage($i).RenderToStreamAsync($s, $o))
    $out += Read-Bitmap $s
  }
} else {
  $s = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $out += Read-Bitmap $s
}
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Console]::Out.Write(($out -join [Environment]::NewLine))
`

const OCR_EXT = new Set(['pdf', 'png', 'jpg', 'jpeg', 'bmp', 'gif', 'tif', 'tiff'])
const available = () => process.platform === 'win32'

/**
 * @param {string} file  absolute path
 * @param {{pages?:number, timeoutMs?:number}} opts  pages: how many PDF pages to read
 * @returns {Promise<string>}
 */
function ocrText(file, { pages = 2, timeoutMs = 30000 } = {}) {
  file = path.resolve(file) // the Windows API needs a full path with backslashes
  const ext = String(file).toLowerCase().split('.').pop()
  if (!available() || !OCR_EXT.has(ext)) return Promise.resolve('')
  const lit = s => `'${String(s).replace(/'/g, "''")}'`
  const script = `$P = ${lit(file)}; $N = ${Math.max(1, Math.min(5, pages | 0))}\n${SCRIPT}`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => resolve(err ? '' : String(stdout || '').replace(/\r/g, '').trim()))
  })
}

module.exports = { ocrText, ocrAvailable: available, OCR_EXT }
