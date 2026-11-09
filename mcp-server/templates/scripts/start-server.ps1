#
# ProjexLight Unified Server Startup Script (Windows PowerShell)
# ============================================
# This script is generated during CLI Export (Task 0) and customized for your project
# Exit codes:
#   0 = Server started successfully
#   1 = Dependency installation failed
#   2 = Build/compilation failed
#   3 = Server failed to start
#   4 = Health check failed

param(
    [string]$Action = "start"
)

$ErrorActionPreference = "Stop"

# ============================================================
# Configuration (Auto-generated based on project)
# ============================================================
$ProjectType = if ($env:PROJECT_TYPE) { $env:PROJECT_TYPE } else { "{{PROJECT_TYPE}}" }
$Framework = if ($env:FRAMEWORK) { $env:FRAMEWORK } else { "{{FRAMEWORK}}" }
$Language = if ($env:LANGUAGE) { $env:LANGUAGE } else { "{{LANGUAGE}}" }
$ServerPort = if ($env:SERVER_PORT) { $env:SERVER_PORT } else { "{{SERVER_PORT}}" }
$HealthEndpoint = if ($env:HEALTH_ENDPOINT) { $env:HEALTH_ENDPOINT } else { "{{HEALTH_ENDPOINT}}" }
$BuildCommand = if ($env:BUILD_COMMAND) { $env:BUILD_COMMAND } else { "{{BUILD_COMMAND}}" }
$StartCommand = if ($env:START_COMMAND) { $env:START_COMMAND } else { "{{START_COMMAND}}" }
$InstallCommand = if ($env:INSTALL_COMMAND) { $env:INSTALL_COMMAND } else { "{{INSTALL_COMMAND}}" }

# Script directory
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)

# Log and PID files
$LogDir = Join-Path $ProjectRoot ".projexlight\logs"
$LogFile = Join-Path $LogDir "server-startup.log"
$PidFile = Join-Path $ProjectRoot ".projexlight\server.pid"

if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

function Write-Log {
    param([string]$Message, [string]$Color = "White")
    Write-Host $Message -ForegroundColor $Color
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "[$timestamp] $Message" | Out-File -FilePath $LogFile -Append
}

function Write-ErrorLog {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Red
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "[$timestamp] ERROR: $Message" | Out-File -FilePath $LogFile -Append
}

# ============================================================
# STEP 1: Load environment variables
# ============================================================
function Load-Environment {
    Write-Log "Loading environment variables..." "Cyan"

    $envFiles = @(
        (Join-Path $ProjectRoot ".env"),
        (Join-Path $ProjectRoot "server\.env"),
        (Join-Path $ProjectRoot "backend\.env"),
        (Join-Path $ProjectRoot ".env.local"),
        (Join-Path $ProjectRoot ".env.development")
    )

    $envLoaded = $false
    foreach ($envFile in $envFiles) {
        if (Test-Path $envFile) {
            Write-Log "   Loading: $envFile"
            Get-Content $envFile | ForEach-Object {
                if ($_ -match '^([^#][^=]+)=(.*)$') {
                    $key = $matches[1].Trim()
                    $value = $matches[2].Trim()
                    [Environment]::SetEnvironmentVariable($key, $value, "Process")
                }
            }
            $envLoaded = $true
        }
    }

    if (-not $envLoaded) {
        Write-Log "   Warning: No .env file found" "Yellow"
    }

    # Override port if specified in .env
    if ($env:PORT) {
        $script:ServerPort = $env:PORT
        Write-Log "   Using PORT from .env: $ServerPort"
    }

    if ($env:DATABASE_URL) {
        Write-Log "   DATABASE_URL configured"
    }
}

# ============================================================
# STEP 2: Install dependencies
# ============================================================
function Install-Dependencies {
    Write-Log "Installing dependencies..." "Cyan"

    Set-Location $ProjectRoot

    if ([string]::IsNullOrEmpty($InstallCommand) -or $InstallCommand -eq "{{INSTALL_COMMAND}}") {
        Write-Log "   Skipping (no install command configured)"
        return $true
    }

    # Check if dependencies are already installed
    switch ($ProjectType) {
        "node" {
            if ((Test-Path "node_modules") -and ((Get-ChildItem "node_modules" -Directory).Count -gt 10)) {
                Write-Log "   Dependencies already installed (node_modules exists)"
                return $true
            }
        }
        "python" {
            if ((Test-Path "venv") -or (Test-Path ".venv")) {
                Write-Log "   Virtual environment found"
            }
        }
    }

    Write-Log "   Running: $InstallCommand"
    try {
        $output = Invoke-Expression $InstallCommand 2>&1
        $output | Out-File -FilePath $LogFile -Append
        Write-Log "   Dependencies installed" "Green"
        return $true
    }
    catch {
        Write-ErrorLog "Dependency installation failed!"
        Write-ErrorLog "   Check log: $LogFile"
        return $false
    }
}

# ============================================================
# STEP 3: Build/Compile project
# ============================================================
function Build-Project {
    Write-Log "Building project..." "Cyan"

    Set-Location $ProjectRoot

    if ([string]::IsNullOrEmpty($BuildCommand) -or $BuildCommand -eq "{{BUILD_COMMAND}}") {
        Write-Log "   Skipping (no build command configured)"
        return $true
    }

    Write-Log "   Running: $BuildCommand"

    try {
        $buildOutput = Invoke-Expression $BuildCommand 2>&1
        $buildOutput | Out-File -FilePath $LogFile -Append

        # Check for TypeScript errors
        $buildOutputStr = $buildOutput | Out-String
        if ($buildOutputStr -match "error TS") {
            Write-ErrorLog "TypeScript compilation errors:"
            $buildOutputStr -split "`n" | Where-Object { $_ -match "error TS" } | Select-Object -First 10 | ForEach-Object {
                Write-ErrorLog "   $_"
            }
            return $false
        }

        Write-Log "   Build successful" "Green"
        return $true
    }
    catch {
        Write-ErrorLog "Build/compilation failed!"
        Write-ErrorLog "   Error: $($_.Exception.Message)"
        return $false
    }
}

# ============================================================
# STEP 4: Start server
# ============================================================
function Start-Server {
    Write-Log "Starting development server..." "Cyan"

    Set-Location $ProjectRoot

    if ([string]::IsNullOrEmpty($StartCommand) -or $StartCommand -eq "{{START_COMMAND}}") {
        Write-ErrorLog "No start command configured!"
        return $false
    }

    # Check if server is already running
    if (Test-Path $PidFile) {
        $oldPid = Get-Content $PidFile
        try {
            $process = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
            if ($process) {
                Write-Log "   Server already running (PID: $oldPid)"
                return $true
            }
        }
        catch { }
        Remove-Item $PidFile -Force
    }

    # Check if port is already in use
    $portInUse = Get-NetTCPConnection -LocalPort $ServerPort -ErrorAction SilentlyContinue
    if ($portInUse) {
        Write-Log "   Warning: Port $ServerPort is already in use" "Yellow"
        Write-Log "   Another process might be running"
        return $true
    }

    Write-Log "   Running: $StartCommand"
    Write-Log "   Server port: $ServerPort"

    # Start server in background
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = "cmd.exe"
    $startInfo.Arguments = "/c $StartCommand"
    $startInfo.WorkingDirectory = $ProjectRoot
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.CreateNoWindow = $true

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    $process.Start() | Out-Null

    $process.Id | Out-File -FilePath $PidFile
    Write-Log "   Server PID: $($process.Id)"

    # Wait for server to initialize
    Write-Log "   Waiting for server to start..."

    $startupTimeout = 60
    $elapsed = 0
    $checkInterval = 2

    while ($elapsed -lt $startupTimeout) {
        Start-Sleep -Seconds $checkInterval
        $elapsed += $checkInterval

        # Check if process is still running
        $proc = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
        if (-not $proc) {
            Write-ErrorLog "Server process died during startup!"
            Write-ErrorLog "   Check log for errors: $LogFile"
            return $false
        }

        # Check if port is responding
        try {
            $response = Invoke-WebRequest -Uri "http://localhost:$ServerPort" -TimeoutSec 2 -UseBasicParsing -ErrorAction SilentlyContinue
            if ($response.StatusCode) {
                Write-Log "   Server started successfully (${elapsed}s)" "Green"
                return $true
            }
        }
        catch { }

        Write-Host "`r   Waiting... $elapsed/${startupTimeout}s" -NoNewline
    }

    Write-ErrorLog "Server failed to start within ${startupTimeout}s"

    # Cleanup
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    return $false
}

# ============================================================
# STEP 5: Health check
# ============================================================
function Test-ServerHealth {
    Write-Log "Running health check..." "Cyan"

    if ([string]::IsNullOrEmpty($HealthEndpoint) -or $HealthEndpoint -eq "{{HEALTH_ENDPOINT}}") {
        $HealthEndpoint = "http://localhost:$ServerPort"
    }

    Write-Log "   Checking: $HealthEndpoint"

    $maxRetries = 5
    for ($i = 1; $i -le $maxRetries; $i++) {
        try {
            $response = Invoke-WebRequest -Uri $HealthEndpoint -TimeoutSec 10 -UseBasicParsing -ErrorAction Stop
            $statusCode = $response.StatusCode

            if ($statusCode -in @(200, 204, 301, 302)) {
                Write-Log "   Health check passed (HTTP $statusCode)" "Green"
                return $true
            }

            Write-Log "   Attempt $i/$maxRetries: HTTP $statusCode"
        }
        catch {
            Write-Log "   Attempt $i/$maxRetries: Connection refused"
        }

        Start-Sleep -Seconds 2
    }

    Write-ErrorLog "Health check failed after $maxRetries attempts"
    return $false
}

# ============================================================
# Report status
# ============================================================
function Report-Status {
    param([int]$ExitCode)

    Write-Host ""
    Write-Host "============================================"

    switch ($ExitCode) {
        0 {
            Write-Log "Server is running and healthy" "Green"
            Write-Log "   Port: $ServerPort"
            Write-Log "   Health: $HealthEndpoint"
            if (Test-Path $PidFile) {
                Write-Log "   PID: $(Get-Content $PidFile)"
            }
        }
        1 {
            Write-ErrorLog "FAILED: Dependency installation"
            Write-ErrorLog "   Fix: Check $LogFile for errors"
        }
        2 {
            Write-ErrorLog "FAILED: Build/compilation"
            Write-ErrorLog "   Fix: Resolve compilation errors before pushing"
        }
        3 {
            Write-ErrorLog "FAILED: Server startup"
            Write-ErrorLog "   Fix: Check server configuration and logs"
        }
        4 {
            Write-ErrorLog "FAILED: Health check"
            Write-ErrorLog "   Fix: Server running but not responding correctly"
        }
    }

    Write-Host "============================================"
    Write-Host ""
}

# ============================================================
# Cleanup function
# ============================================================
function Stop-ServerProcess {
    if (Test-Path $PidFile) {
        $pid = Get-Content $PidFile
        try {
            Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
            Write-Log "Stopping server (PID: $pid)"
        }
        catch { }
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    }
}

# ============================================================
# Main execution
# ============================================================
function Main {
    Write-Log "============================================" "Cyan"
    Write-Log "  ProjexLight Server Startup Script" "Cyan"
    Write-Log "============================================" "Cyan"
    Write-Log "Project Type: $ProjectType"
    Write-Log "Framework: $Framework"
    Write-Log "Language: $Language"
    Write-Log ""

    Load-Environment

    if (-not (Install-Dependencies)) {
        Report-Status 1
        exit 1
    }

    if (-not (Build-Project)) {
        Report-Status 2
        exit 2
    }

    if (-not (Start-Server)) {
        Report-Status 3
        exit 3
    }

    if (-not (Test-ServerHealth)) {
        Report-Status 4
        exit 4
    }

    Report-Status 0
    exit 0
}

# Handle script arguments
switch ($Action) {
    "start" {
        Main
    }
    "stop" {
        Stop-ServerProcess
        Write-Log "Server stopped"
    }
    "status" {
        if (Test-Path $PidFile) {
            $pid = Get-Content $PidFile
            $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
            if ($proc) {
                Write-Log "Server running (PID: $pid)"
                Test-ServerHealth
            }
            else {
                Write-Log "Server not running (stale PID file)"
                Remove-Item $PidFile -Force
            }
        }
        else {
            Write-Log "Server not running"
        }
    }
    default {
        Write-Host "Usage: .\start-server.ps1 [-Action start|stop|status]"
        exit 1
    }
}
