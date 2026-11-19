# LLM Agent Relays 🚀

> **Локальные релеи и протокольные адаптеры без внешних зависимостей (Zero-Dependency) для AI-агентов (AutoClaw, OpenClaw, Continue, Cline, LibreChat и др.)**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Ready-blue.svg)](https://www.docker.com/)

---

## 📌 Зачем это нужно?

При разработке и работе с автономными AI-агентами (такими как **AutoClaw** и **OpenClaw**) из регионов с сетевыми ограничениями возникают ключевые проблемы:

1. **Блокировки провайдеров**:
   - `api.groq.com` возвращает `403 Forbidden` на прямые запросы.
   - `generativelanguage.googleapis.com` (Gemini) возвращает ошибку `400 "User location is not supported"`.
   - Включение глобального VPN/TUN ломает локальные сети (LAN), SSH, локальные серверы и замедляет работу всей системы.
2. **Несовместимость протокола OpenAI с Gemini**:
   - Агенты отправляют поля вроде `"store": false`, `"thinking"`, `"verbosity"`. Слой совместимости Google бракует такие запросы с ошибкой `400 Invalid JSON payload received. Unknown name "store"`.
   - **Gemini 2.5/3 требует `thought_signature`**: при вызове инструментов (Function Calling / Tool Use) Google присылает сигнатуру размышлений и **обязательно требует** ее возврата в следующем сообщении. Стандартные OpenAI-клиенты отбрасывают эти нестандартные поля, из-за чего многошаговые агенты (AutoClaw / OpenClaw) падают при первой же попытке выполнить tool-call.

**LLM Agent Relays** решает все эти проблемы локально:
- Туннелирует трафик моделей через локальные прокси (**Hiddify** на `:12334`, **xray/v2rayN** на `:10808`), оставляя весь остальной интернет прямым.
- Автоматически вырезает несовместимые поля Google.
- Перехватывает, кэширует и восстанавливает `thought_signature` для безупречного Function Calling в Gemini.
- Написан на **чистом Node.js** без единого стороннего npm-пакета.

---

## 🗺 Архитектура и порты

| Сервис | Локальный порт | Назначение (Upstream) | Прокси-маршруты |
| :--- | :--- | :--- | :--- |
| **OpenRouter Relay** | `http://127.0.0.1:8818/v1` | `https://openrouter.ai/api/v1` | SOCKS5 / HTTP (12334, 10808) |
| **Groq Relay** | `http://127.0.0.1:8819/v1` | `https://api.groq.com/openai/v1` | SOCKS5 / HTTP (10808, 12334) |
| **Gemini Relay** | `http://127.0.0.1:8820/v1` | `https://generativelanguage.googleapis.com/v1beta/openai` | SOCKS5 / HTTP (10808, 12334) |

Каждый релей имеет встроенные эндпоинты самодиагностики:
- `GET /health` — проверка состояния процесса и доступности прокси-клиентов.
- `GET /__diag` — реальный HTTPS-пробник upstream через каждый настроенный маршрут с замером задержки.

---

## 🚀 Быстрый запуск

### Вариант 1: Windows (через интерактивный батник)

Просто дважды кликните по файлу **`manage.bat`**:

```text
================================================================
           LLM Agent Relays - Панель управления
================================================================
  [1] Проверить статус и здоровье (Health Check)
  [2] Запустить все релеи (фоновый режим / без окна)
  [3] Запустить все релеи (в отдельном окне с логами)
  [4] Остановить все релеи
  [5] Ремонт и перезапуск (Repair & Restart)
  [6] Глубокая диагностика upstream (__diag тест провайдеров)
  [0] Выход
================================================================
```

Также поддерживается вызов с аргументами командной строки:
```cmd
manage.bat status    :: Проверить состояние релеев и прокси
manage.bat start     :: Запустить в фоне
manage.bat repair    :: Перезапустить, завершить зависшие процессы и проверить здоровье
manage.bat stop      :: Остановить все релеи
manage.bat diag      :: Глубокий тест upstream-подключений
```

### Вариант 2: Linux / macOS (через bash)

```bash
chmod +x scripts/manage.sh
./scripts/manage.sh start     # запуск в фоне
./scripts/manage.sh status    # проверка состояния
./scripts/manage.sh repair    # ремонт и перезапуск
./scripts/manage.sh stop      # остановка
```

### Вариант 3: Docker & Docker Compose (сервер / VPS / десктоп)

```bash
# Клонируем и запускаем
docker compose up -d

# Просмотр логов
docker compose logs -f
```

---

## ⚙️ Настройка в OpenClaw и AutoClaw

В настройках провайдеров моделей вашего агента укажите:

### 1. Google Gemini (через релей 8820)
- **Base URL**: `http://127.0.0.1:8820/v1`
- **Protocol**: `Chat Completions` (OpenAI-compatible)
- **API Key**: Ваш ключ Gemini (`AIza...`)
- **Рекомендуемые модели**: `gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-1.5-flash`

### 2. Groq (через релей 8819)
- **Base URL**: `http://127.0.0.1:8819/v1`
- **Protocol**: `Chat Completions` (OpenAI-compatible)
- **API Key**: Ваш ключ Groq (`gsk_...`)
- **Рекомендуемые модели**: `llama-3.3-70b-versatile`, `deepseek-r1-distill-llama-70b`

### 3. OpenRouter (через релей 8818)
- **Base URL**: `http://127.0.0.1:8818/v1`
- **Protocol**: `Chat Completions` (OpenAI-compatible)
- **API Key**: Ваш ключ OpenRouter (`sk-or-v1-...`)
- **Рекомендуемые модели**: Любая модель OpenRouter (например `anthropic/claude-3.5-sonnet`)

---

## 🔧 Конфигурация (.env)

Скопируйте `.env.example` в `.env` при необходимости изменить стандартные порты:

```env
# Локальные прокси-порты (Hiddify 12334, xray 10808)
RELAY_PROXY_PORTS=12334,10808

# Слушающие порты
OPENROUTER_PORT=8818
GROQ_PORT=8819
GEMINI_PORT=8820
```

---

## 🛠 Тестирование и ремонт (Self-Healing)

Если агент сообщает об ошибке соединения с моделью:
1. Запустите `manage.bat repair` (или `./scripts/manage.sh repair`).
2. Скрипт:
   - Завершит любые зависшие или зомби-процессы Node.js на портах 8818–8820.
   - Проверит, слушают ли локальные клиенты **Hiddify** (`12334`) и **v2rayN** (`10808`).
   - Поднимет свежие экземпляры релеев.
   - Проведет автоматический опрос `/health`.

---

## 📄 Лицензия

MIT License. Свободно для личного и коммерческого использования.
