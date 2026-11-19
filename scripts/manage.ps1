<#
  manage.ps1 - Диспетчер управления, тестирования и ремонта LLM Agent Relays
#>
param(
  [ValidateSet('status', 'start', 'console', 'stop', 'restart', 'repair', 'diag', 'menu')]
  [string]$Action = 'menu',
  [string]$NodePath = ''
)

$ErrorActionPreference = 'Continue'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$BaseDir = Split-Path -Parent $ScriptDir
$LogDir = Join-Path $BaseDir 'logs'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

$Ports = @(
  @{ Name = 'OpenRouter'; Port = 8818; Upstream = 'openrouter.ai' },
  @{ Name = 'Groq';       Port = 8819; Upstream = 'api.groq.com' },
  @{ Name = 'Gemini';     Port = 8820; Upstream = 'generativelanguage.googleapis.com' }
)

function Find-NodeExecutable {
  if ($NodePath -and (Test-Path $NodePath)) { return $NodePath }
  if ($env:NODE_EXE -and (Test-Path $env:NODE_EXE)) { return $env:NODE_EXE }

  $cmd = Get-Command 'node' -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  $candidates = @(
    "$env:LOCALAPPDATA\Programs\AutoClaw2\resources\vendor\node\node.exe",
    "$env:ProgramFiles\nodejs\node.exe",
    "$env:LOCALAPPDATA\Programs\OpenClaw\resources\vendor\node\node.exe",
    "C:\Program Files\nodejs\node.exe",
    "C:\Users\almal\AppData\Local\Programs\AutoClaw2\resources\vendor\node\node.exe"
  )

  foreach ($c in $candidates) {
    if (Test-Path $c) { return $c }
  }

  return $null
}

$NodeExe = Find-NodeExecutable

function Ensure-Node {
  if (-not $NodeExe) {
    Write-Host "`n[ОШИБКА] Node.js не найден в системе (PATH или стандартные папки AutoClaw)." -ForegroundColor Red
    Write-Host "Пожалуйста, установите Node.js (https://nodejs.org) или укажите путь в переменной NODE_EXE." -ForegroundColor Yellow
    exit 1
  }
}

function Test-TcpPort([int]$Port, [string]$Host = '127.0.0.1', [int]$TimeoutMs = 600) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $iar = $c.BeginConnect($Host, $Port, $null, $null)
    $success = $iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)
    if ($success -and $c.Connected) {
      $c.EndConnect($iar)
      $c.Close()
      return $true
    }
    $c.Close()
    return $false
  } catch { return $false }
}

function Show-Status {
  Ensure-Node
  & $NodeExe "$ScriptDir\diag.js"
}

function Show-Diag {
  Ensure-Node
  & $NodeExe "$ScriptDir\diag.js" --deep
}

function Stop-Relays {
  Write-Host "`n[1/2] Остановка запущенных релеев..." -ForegroundColor Cyan

  $killed = 0
  foreach ($item in $Ports) {
    $port = $item.Port
    $listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($listeners) {
      foreach ($conn in $listeners) {
        $pidToKill = $conn.OwningProcess
        if ($pidToKill -gt 0) {
          try {
            Stop-Process -Id $pidToKill -Force -ErrorAction SilentlyContinue
            Write-Host "  - Остановлен процесс PID $pidToKill на порту $port ($($item.Name))" -ForegroundColor Yellow
            $killed++
          } catch {}
        }
      }
    }
  }

  # Дополнительно проверяем процессы node с index.js / relay.js в этой директории
  try {
    $nodeProcs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
    foreach ($p in $nodeProcs) {
      if ($p.CommandLine -match 'llm-agent-relays' -or $p.CommandLine -match 'index\.js') {
        try {
          Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
          Write-Host "  - Завершен связанный процесс node.exe (PID $($p.ProcessId))" -ForegroundColor Yellow
          $killed++
        } catch {}
      }
    }
  } catch {}

  Start-Sleep -Milliseconds 800
  Write-Host "[2/2] Завершено. Остановлено процессов: $killed" -ForegroundColor Green
}

function Start-RelaysBackground {
  Ensure-Node
  Write-Host "`n[1/3] Проверка портов перед запуском..." -ForegroundColor Cyan

  $alreadyListening = @()
  foreach ($p in $Ports) {
    if (Test-TcpPort $p.Port) { $alreadyListening += $p.Name }
  }

  if ($alreadyListening.Count -gt 0) {
    Write-Host "  Внимание: порты уже заняты для: $($alreadyListening -join ', ')." -ForegroundColor Yellow
    Write-Host "  Если нужно перезапустить их начисто, используйте опцию 'Ремонт и перезапуск'." -ForegroundColor Yellow
  }

  Write-Host "[2/3] Запуск релеев в фоновом режиме..." -ForegroundColor Cyan
  $indexPath = Join-Path $BaseDir 'index.js'
  $outLog = Join-Path $LogDir 'unified.log'

  # Запуск через Start-Process со скрытым окном
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $NodeExe
  $psi.Arguments = "`"$indexPath`""
  $psi.WorkingDirectory = $BaseDir
  $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $psi.CreateNoWindow = $true
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $false
  $psi.RedirectStandardError = $false

  [System.Diagnostics.Process]::Start($psi) | Out-Null
  Start-Sleep -Seconds 2

  Write-Host "[3/3] Проверка готовности сервисов..." -ForegroundColor Cyan
  Show-Status
}

function Start-RelaysConsole {
  Ensure-Node
  Write-Host "`nЗапуск релеев в открытом окне консоли..." -ForegroundColor Cyan
  $indexPath = Join-Path $BaseDir 'index.js'
  Start-Process cmd.exe -ArgumentList "/k `"`"$NodeExe`" `"$indexPath`"`"" -WorkingDirectory $BaseDir
}

function Repair-And-Restart {
  Write-Host "`n" + ("=" * 64) -ForegroundColor Magenta
  Write-Host "         РЕМОНТ И ВОССТАНОВЛЕНИЕ LLM AGENT RELAYS" -ForegroundColor Magenta
  Write-Host ("=" * 64) -ForegroundColor Magenta

  # Шаг 1: Завершить любые зависшие процессы
  Write-Host "`n[Шаг 1/4] Принудительная остановка зависших процессов..." -ForegroundColor Cyan
  Stop-Relays

  # Шаг 2: Проверка локальных прокси (12334, 10808)
  Write-Host "`n[Шаг 2/4] Проверка доступности прокси-клиентов..." -ForegroundColor Cyan
  $hiddifyOk = Test-TcpPort 12334
  $xrayOk = Test-TcpPort 10808

  if ($hiddifyOk) {
    Write-Host "  [OK] Hiddify на порту 12334 активен" -ForegroundColor Green
  } else {
    Write-Host "  [FAIL] Hiddify на порту 12334 не отвечает" -ForegroundColor Red
  }

  if ($xrayOk) {
    Write-Host "  [OK] xray / v2rayN на порту 10808 активен" -ForegroundColor Green
  } else {
    Write-Host "  [FAIL] xray / v2rayN на порту 10808 не отвечает" -ForegroundColor Red
  }

  if (-not $hiddifyOk -and -not $xrayOk) {
    Write-Host "`n  [ПРЕДУПРЕЖДЕНИЕ] Ни один локальный прокси не запущен!" -ForegroundColor Yellow
    Write-Host "  Релеи запустятся, но запросы к зарубежным моделям (OpenRouter, Groq, Gemini)" -ForegroundColor Yellow
    Write-Host "  могут блокироваться без включенного Hiddify или v2rayN." -ForegroundColor Yellow
  }

  # Шаг 3: Запуск свежего процесса
  Write-Host "`n[Шаг 3/4] Чистый запуск релеев..." -ForegroundColor Cyan
  Start-RelaysBackground

  # Шаг 4: Итоговый отчет
  Write-Host "`n[Шаг 4/4] Ремонт завершен успешно!" -ForegroundColor Green
}

function Show-Menu {
  while ($true) {
    Clear-Host
    Write-Host "================================================================" -ForegroundColor Cyan
    Write-Host "           LLM Agent Relays - Панель управления" -ForegroundColor Cyan
    Write-Host "================================================================" -ForegroundColor Cyan
    Write-Host "  Используемый Node.js : $(if ($NodeExe) { $NodeExe } else { 'НЕ НАЙДЕН' })" -ForegroundColor DarkGray
    Write-Host "  Каталог проекта      : $BaseDir" -ForegroundColor DarkGray
    Write-Host "----------------------------------------------------------------"
    Write-Host "  [1] Проверить статус и здоровье (Health Check)" -ForegroundColor White
    Write-Host "  [2] Запустить все релеи (фоновый режим / без окна)" -ForegroundColor White
    Write-Host "  [3] Запустить все релеи (в отдельном окне с логами)" -ForegroundColor White
    Write-Host "  [4] Остановить все релеи" -ForegroundColor White
    Write-Host "  [5] Ремонт и перезапуск (Repair & Restart)" -ForegroundColor Yellow
    Write-Host "  [6] Глубокая диагностика upstream (__diag тест провайдеров)" -ForegroundColor White
    Write-Host "  [0] Выход" -ForegroundColor White
    Write-Host "================================================================" -ForegroundColor Cyan
    $choice = Read-Host "Выберите действие [0-6]"

    switch ($choice) {
      '1' { Show-Status; pause }
      '2' { Start-RelaysBackground; pause }
      '3' { Start-RelaysConsole; pause }
      '4' { Stop-Relays; pause }
      '5' { Repair-And-Restart; pause }
      '6' { Show-Diag; pause }
      '0' { exit 0 }
      default { Write-Host "Неверный выбор." -ForegroundColor Red; Start-Sleep -Seconds 1 }
    }
  }
}

# Маршрутизация по переданному действию
switch ($Action.ToLower()) {
  'status'  { Show-Status }
  'diag'    { Show-Diag }
  'start'   { Start-RelaysBackground }
  'console' { Start-RelaysConsole }
  'stop'    { Stop-Relays }
  'restart' { Stop-Relays; Start-RelaysBackground }
  'repair'  { Repair-And-Restart }
  'menu'    { Show-Menu }
  default   { Show-Menu }
}
