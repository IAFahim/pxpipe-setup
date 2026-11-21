param(
    [int[]]$Ports = @(47821, 47822)
)

$ErrorActionPreference = "Stop"

function Test-LocalPort {
    param([int]$Port)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
        $ok = $iar.AsyncWaitHandle.WaitOne(200, $false)
        if ($ok -and $client.Connected) {
            $client.EndConnect($iar) | Out-Null
            return $true
        }
        return $false
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

function Resolve-NodeExe {
    $cmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    $candidates = @(
        "$env:ProgramFiles\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
        "$env:USERPROFILE\scoop\apps\nodejs-lts\current\node.exe",
        "$env:USERPROFILE\scoop\apps\nodejs\current\node.exe"
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { return $c }
    }
    throw "Node.js not found on PATH. Install Node.js >= 22.15 (recommended 24+)."
}

function Resolve-PxpipeCli {
    $candidates = @(
        "$env:LOCALAPPDATA\pxpipe\node_modules\pxpipe-proxy\bin\cli.js",
        "$env:APPDATA\npm\node_modules\pxpipe-proxy\bin\cli.js"
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { return $c }
    }
    throw "pxpipe-proxy cli.js not found. Re-run windows\install.ps1."
}

$nodeExe = Resolve-NodeExe
$cliJs = Resolve-PxpipeCli
$stateDir = Join-Path $env:USERPROFILE ".pxpipe"
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

foreach ($port in $Ports) {
    if (Test-LocalPort -Port $port) {
        continue
    }

    $logFile = Join-Path $stateDir "pxpipe-$port.log"
    $envJson = @{
        PORT = "$port"
        HOST = "127.0.0.1"
        PXPIPE_MAX_REQUEST_BYTES = "67108864"
    }
    if ($port -eq 47822) {
        $envJson["OPENAI_UPSTREAM"] = "https://chatgpt.com"
        $envJson["PXPIPE_SESSION_STATE"] = (Join-Path $stateDir "session-state-chatgpt.json")
    }

    $spawnSpecJson = (@{
        node = $nodeExe
        cli = $cliJs
        log = $logFile
        env = $envJson
    } | ConvertTo-Json -Compress)
    $spawnSpecB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($spawnSpecJson))

    $js = 'const fs=require(''node:fs'');const {spawn}=require(''node:child_process'');const spec=JSON.parse(Buffer.from(process.argv[1],''base64'').toString(''utf8''));const fd=fs.openSync(spec.log,''a'');const child=spawn(spec.node,[spec.cli],{detached:true,windowsHide:true,stdio:[''ignore'',fd,fd],env:{...process.env,...spec.env}});child.unref();'

    & $nodeExe -e $js $spawnSpecB64 | Out-Null

    $ready = $false
    for ($i = 0; $i -lt 50; $i++) {
        if (Test-LocalPort -Port $port) {
            $ready = $true
            break
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not $ready) {
        throw "Timed out waiting for pxpipe on 127.0.0.1:$port (see $logFile)"
    }
}
