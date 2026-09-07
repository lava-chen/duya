Add-Type -AssemblyName System.Drawing
$srcPath = 'C:\Users\lavachen\AppData\Local\Temp\trae\screenshots\duya-full-light.png'
$dstPath = 'C:\Users\lavachen\AppData\Local\Temp\trae\screenshots\duya-sidebar-top-light.png'
$src = [System.Drawing.Image]::FromFile($srcPath)
$w = 325
$h = 306
$dst = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($dst)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$srcRect = New-Object System.Drawing.Rectangle(0, 55, $w, $h)
$dstRect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
$g.DrawImage($src, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
$dst.Save($dstPath, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $dst.Dispose(); $src.Dispose()
Write-Output ('cropped-light ' + $w + 'x' + $h)
