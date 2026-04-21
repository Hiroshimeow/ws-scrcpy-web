@echo off
:: ws-scrcpy-web launcher for Windows
:: Runs Node.js from dependencies folder, handles restart on update

setlocal

set "SCRIPT_DIR=%~dp0"
set "NODE=%SCRIPT_DIR%dependencies\node\node.exe"
set "ENTRY=%SCRIPT_DIR%dist\index.js"
set "DEPS_PATH=%SCRIPT_DIR%dependencies"
set "RESTART_MARKER=%DEPS_PATH%\.restart"

:: Ensure node binary exists
if not exist "%NODE%" (
    echo ERROR: Node.js not found at %NODE%
    echo Run the initial setup or place node.exe in dependencies\node\
    pause
    exit /b 1
)

:: Clean up stale restart marker
if exist "%RESTART_MARKER%" del "%RESTART_MARKER%"

:: Clean up old node binary from previous update
if exist "%NODE%.old" del "%NODE%.old"

:loop
echo Starting ws-scrcpy-web...
"%NODE%" "%ENTRY%"
set "EXIT_CODE=%ERRORLEVEL%"

:: Check if restart was requested — marker file OR exit code 75
if exist "%RESTART_MARKER%" (
    del "%RESTART_MARKER%"
    if exist "%NODE%.old" del "%NODE%.old"
    echo Restarting (marker)...
    timeout /t 2 /nobreak >nul
    goto loop
)
if "%EXIT_CODE%"=="75" (
    if exist "%NODE%.old" del "%NODE%.old"
    echo Restarting (exit 75)...
    timeout /t 2 /nobreak >nul
    goto loop
)

:: Process exited without restart request — stop
echo ws-scrcpy-web exited with code %EXIT_CODE%
exit /b %EXIT_CODE%
