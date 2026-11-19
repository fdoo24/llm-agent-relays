@echo off
rem ============================================================================
rem   LLM Agent Relays - Launcher & Management Console
rem   Управление, тестирование и ремонт локальных релеев для AutoClaw / OpenClaw
rem ============================================================================

chcp 65001 >nul
setlocal
cd /d "%~dp0"

set SCRIPT="%~dp0scripts\manage.ps1"

if "%~1"=="" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File %SCRIPT% -Action menu
) else (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File %SCRIPT% -Action "%~1"
    if /i not "%~1"=="status" pause
)
