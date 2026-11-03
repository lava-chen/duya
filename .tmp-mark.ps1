Add-Type -AssemblyName System.Drawing
$src = 'C:\Users\lavachen\.minimax\v2\assets\2026\11\03\08-51-40-723-asset_20261103-085140-723_1b49bf439d66_c9cbe09a-image.png'
$img = [System.Drawing.Image]::FromFile($src)
$rect = New-Object System.Drawing.Rectangle 230,1015,180,32
$crop = New-Object System.Drawing.Bitmap $rect.Width, $rect.Height
$g = [System.Drawing.Graphics]::FromImage($crop)
$g.DrawImage($img, (New-Object System.Drawing.Rectangle 0,0,$rect.Width,$rect.Height), $rect, [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
$w = $rect.Width * 10
$h = $rect.Height * 10
$s = New-Object System.Drawing.Bitmap $w, $h
$g2 = [System.Drawing.Graphics]::FromImage($s)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
$g2.DrawImage($crop, 0, 0, $w, $h)
$g2.Dispose()
$s.Save('E:\Projects\duya\.tmp-mark.png', [System.Drawing.Imaging.ImageFormat]::Png)
$s.Dispose()
$crop.Dispose()
$img.Dispose()
"ok"
