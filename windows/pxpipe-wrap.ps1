param(
    [Parameter(Mandatory = $true)]
    [string]$Agent,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$AgentArgs
)

$ErrorActionPreference = "Stop"

$setupDir = Join-Path $env:USERPROFILE ".config\pxpipe-setup"
$agentsFile = Join-Path $setupDir "agents.json"
$startScript = Join-Path $setupDir "start-pxpipe.ps1"

if (-not (Test-Path $agentsFile)) {
    throw "Missing $agentsFile. Run windows\install.ps1 first."
}

$manifest = Get-Content -Raw -Path $agentsFile | ConvertFrom-Json
$entry = $manifest.agents | Where-Object { $_.command -eq $Agent -or $_.alias -eq $Agent } | Select-Object -First 1
if (-not $entry) {
    throw "Unknown or unsupported agent: $Agent"
}

function Resolve-NodeExe {
    $cmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    foreach ($c in @("$env:ProgramFiles\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
        if (Test-Path $c) { return $c }
    }
    throw "Node.js not found on PATH."
}

function Resolve-PxpipeCli {
    foreach ($c in @(
        "$env:LOCALAPPDATA\pxpipe\node_modules\pxpipe-proxy\bin\cli.js",
        "$env:APPDATA\npm\node_modules\pxpipe-proxy\bin\cli.js"
    )) {
        if (Test-Path $c) { return $c }
    }
    throw "pxpipe-proxy cli.js not found."
}

function Resolve-AgentTarget {
    param([string]$CommandName)
    $localBin = (Join-Path $env:USERPROFILE ".local\bin").ToLowerInvariant()
    $apps = Get-Command $CommandName -All -CommandType Application,ExternalScript -ErrorAction SilentlyContinue
    foreach ($app in $apps) {
        $src = $app.Source
        if (-not $src) { continue }
        $lower = $src.ToLowerInvariant()
        # Skip our own p* shims if someone passes an alias name
        if ($lower.StartsWith($localBin) -and ([IO.Path]::GetFileNameWithoutExtension($lower).StartsWith("p"))) {
            continue
        }
        return $src
    }
    return $null
}

$targetPath = Resolve-AgentTarget -CommandName $entry.command
if (-not $targetPath) {
    throw "Agent '$($entry.command)' not found on PATH."
}

$hasConflict = $false
if ($AgentArgs) {
    foreach ($arg in $AgentArgs) {
        if ($arg -eq "--") { break }
        foreach ($conflict in $entry.conflictFlags) {
            if ($arg -eq $conflict -or $arg.StartsWith("$conflict=")) {
                $hasConflict = $true
                break
            }
        }
        if ($hasConflict) { break }
    }
}

$finalArgs = @()
if (-not $hasConflict -and $entry.yoloFlags) {
    $finalArgs += @($entry.yoloFlags)
}
if ($AgentArgs) {
    $finalArgs += @($AgentArgs)
}

$ext = [IO.Path]::GetExtension($targetPath).ToLowerInvariant()
if ($ext -in @(".cmd", ".bat")) {
    $childCommand = @("cmd.exe", "/c", $targetPath) + $finalArgs
} elseif ($ext -eq ".ps1") {
    $siblingCmd = [IO.Path]::ChangeExtension($targetPath, ".cmd")
    $siblingExe = [IO.Path]::ChangeExtension($targetPath, ".exe")
    if (Test-Path $siblingExe) {
        $childCommand = @($siblingExe) + $finalArgs
    } elseif (Test-Path $siblingCmd) {
        $childCommand = @("cmd.exe", "/c", $siblingCmd) + $finalArgs
    } else {
        $psExe = if (Get-Command pwsh -ErrorAction SilentlyContinue) { "pwsh" } else { "powershell.exe" }
        $childCommand = @($psExe, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $targetPath) + $finalArgs
    }
} else {
    $childCommand = @($targetPath) + $finalArgs
}

if ($env:PXPIPE_WARPED -eq "1") {
    $exe = $childCommand[0]
    $rest = if ($childCommand.Length -gt 1) { $childCommand[1..($childCommand.Length - 1)] } else { @() }
    & $exe @rest
    exit $LASTEXITCODE
}

$ports = @($entry.needsPorts)
if (-not $ports -or $ports.Count -eq 0) { $ports = @(47821) }
& $startScript -Ports $ports

$nodeExe = Resolve-NodeExe
$cliJs = Resolve-PxpipeCli

$warpArgs = @($cliJs, "warp")
foreach ($r in $entry.routes) {
    if ($r) {
        $warpArgs += @("--route", $r)
    }
}
$warpArgs += "--"
$warpArgs += $childCommand

$env:PXPIPE_WARPED = "1"
& $nodeExe @warpArgs
exit $LASTEXITCODE
