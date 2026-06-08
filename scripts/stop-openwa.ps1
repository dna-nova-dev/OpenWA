# Stop OpenWA: kill the whole dev tree, not just the API port.
#
# Order matters — we kill the parent watcher (`concurrently` / `nest --watch`)
# BEFORE the listening process, because nest's watcher respawns the API on every
# file change and would otherwise relaunch it the moment we kill the port.
#
# Safe to run when nothing is up — it just reports "nothing to kill".

$ApiPort = 2785
$ProjectRoot = 'c:\Users\Lenovo\Documents\GitHub\OpenWA'
$SessionDir = Join-Path $ProjectRoot 'data\sessions'
$Killed = 0

Write-Host ''
Write-Host '── Apagando OpenWA ─────────────────────────────────────' -ForegroundColor Cyan
Write-Host ''

# 1) Watcher / parents del dev tree. Tiene que ir PRIMERO o `nest --watch`
#    respawnea el API en cuanto matemos el puerto.
#
#    Filtro ajustado para no tocar tsserver/Cursor: el cmdline debe apuntar al
#    repo de OpenWA Y además ser uno de los runners conocidos (nest/concurrently/
#    vite/ts-node) o el binario principal compilado.
$runnerTokens = @('nest', 'concurrently', 'vite', 'ts-node', 'dist\main', 'dist/main')
$nodes = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
        if (-not $_.CommandLine) { return $false }
        if ($_.CommandLine -inotlike "*$ProjectRoot*") { return $false }
        foreach ($t in $runnerTokens) { if ($_.CommandLine -ilike "*$t*") { return $true } }
        return $false
    }

if ($nodes) {
    Write-Host "Node de OpenWA (watcher + parents): $($nodes.Count) proceso(s)"
    foreach ($p in $nodes) {
        try {
            Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
            Write-Host "  ✓ Matado PID $($p.ProcessId)" -ForegroundColor Green
            $Killed++
        } catch {
            # Hijo ya muerto cuando matamos al padre → silencioso.
        }
    }
    Start-Sleep -Milliseconds 800
} else {
    Write-Host 'Sin node de OpenWA' -ForegroundColor DarkGray
}

Write-Host ''

# 2) Por si algo quedó escuchando en el puerto del API igual.
$portPids = (Get-NetTCPConnection -LocalPort $ApiPort -State Listen -ErrorAction SilentlyContinue).OwningProcess |
    Sort-Object -Unique
if ($portPids) {
    Write-Host "API en :$ApiPort → PID(s): $($portPids -join ', ')"
    foreach ($id in $portPids) {
        try {
            Stop-Process -Id $id -Force -ErrorAction Stop
            Write-Host "  ✓ Matado PID $id" -ForegroundColor Green
            $Killed++
        } catch {
            Write-Host "  ✗ Falló $id : $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
} else {
    Write-Host "Nada escuchando en :$ApiPort" -ForegroundColor DarkGray
}

Write-Host ''

# 3) Chromium huérfano (puppeteer) que apunta al SESSION_DATA_PATH de OpenWA.
$chromes = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and ($_.CommandLine -like "*$SessionDir*" -or $_.CommandLine -like '*OpenWA*') }

if ($chromes) {
    Write-Host "Chromium de OpenWA: $($chromes.Count) proceso(s)"
    foreach ($p in $chromes) {
        try {
            Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
            Write-Host "  ✓ Matado Chromium PID $($p.ProcessId)" -ForegroundColor Green
            $Killed++
        } catch {
            # Muy común: el hijo ya murió cuando matamos al padre. Lo silenciamos.
        }
    }
} else {
    Write-Host 'Sin Chromium de OpenWA suelto' -ForegroundColor DarkGray
}

Write-Host ''

# 4) Verificación final: nada escuchando + nada de node de OpenWA suelto.
$remainPort = Get-NetTCPConnection -LocalPort $ApiPort -State Listen -ErrorAction SilentlyContinue
$remainNode = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -ilike "*$ProjectRoot*" }

if ($remainPort -or $remainNode) {
    if ($remainPort) { Write-Host "⚠ Puerto $ApiPort SIGUE ocupado." -ForegroundColor Red }
    if ($remainNode) { Write-Host "⚠ Aún hay $($remainNode.Count) node de OpenWA viv@(s)." -ForegroundColor Red }
} else {
    Write-Host "✓ Puerto $ApiPort libre y sin watcher. ($Killed proceso(s) matado(s).)" -ForegroundColor Green
}

Write-Host ''
Write-Host 'Cerrando en 3 s…' -ForegroundColor DarkGray
Start-Sleep -Seconds 3
