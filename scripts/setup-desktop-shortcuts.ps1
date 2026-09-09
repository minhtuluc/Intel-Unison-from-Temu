$projectRoot = (Resolve-Path "$PSScriptRoot\..").Path

# Find Desktop path
$desktopDir = [Environment]::GetFolderPath('Desktop')
if (-not (Test-Path $desktopDir)) {
    $desktopDir = "$env:USERPROFILE\Desktop"
}

Write-Host "[UniversalTrans] Creating Desktop shortcuts in: $desktopDir"

$WshShell = New-Object -ComObject WScript.Shell
$startBat = "$projectRoot\scripts\start-server.bat"
$stopBat  = "$projectRoot\scripts\stop-server.bat"

# 1. Shortcut: Bat UniversalTrans (Start)
$sc1 = $WshShell.CreateShortcut("$desktopDir\UniversalTrans - Bat.lnk")
$sc1.TargetPath = $startBat
$sc1.WorkingDirectory = $projectRoot
$sc1.IconLocation = "shell32.dll, 137"
$sc1.Description = "Khoi dong UniversalTrans Server (Port 8080)"
$sc1.Save()

# 2. Shortcut: Tat UniversalTrans (Stop)
$sc2 = $WshShell.CreateShortcut("$desktopDir\UniversalTrans - Tat.lnk")
$sc2.TargetPath = $stopBat
$sc2.WorkingDirectory = $projectRoot
$sc2.IconLocation = "shell32.dll, 131"
$sc2.Description = "Tat UniversalTrans Server (Port 8080)"
$sc2.Save()

Write-Host "[OK] Da tao thanh cong 2 phim tat tren Desktop:"
Write-Host "   - [ON]  UniversalTrans - Bat.lnk"
Write-Host "   - [OFF] UniversalTrans - Tat.lnk"
