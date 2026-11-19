#!/usr/bin/env bash
# ==============================================================================
#  LLM Agent Relays - Linux/macOS Management Script
# ==============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$BASE_DIR/logs"
DATA_DIR="$BASE_DIR/data"
PID_FILE="$DATA_DIR/relays.pid"

mkdir -p "$LOG_DIR" "$DATA_DIR"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
    echo -e "\033[31m[ERROR] Node.js is not installed or not in PATH.\033[0m"
    echo "Please install Node.js 18+ (https://nodejs.org)."
    exit 1
fi

status() {
    "$NODE_BIN" "$SCRIPT_DIR/diag.js"
}

diag() {
    "$NODE_BIN" "$SCRIPT_DIR/diag.js" --deep
}

start() {
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo -e "\033[33mRelays are already running (PID $(cat "$PID_FILE")).\033[0m"
        status
        return
    fi

    echo -e "\033[36mStarting LLM Agent Relays in background...\033[0m"
    cd "$BASE_DIR"
    nohup "$NODE_BIN" "$BASE_DIR/index.js" > "$LOG_DIR/unified.log" 2>&1 &
    PID=$!
    echo $PID > "$PID_FILE"
    sleep 2

    if kill -0 "$PID" 2>/dev/null; then
        echo -e "\033[32mRelays started successfully (PID $PID).\033[0m"
        status
    else
        echo -e "\033[31mRelays failed to start. Check $LOG_DIR/unified.log for details.\033[0m"
        exit 1
    fi
}

stop() {
    echo -e "\033[36mStopping relays...\033[0m"
    if [ -f "$PID_FILE" ]; then
        PID="$(cat "$PID_FILE")"
        if kill -0 "$PID" 2>/dev/null; then
            kill "$PID" || kill -9 "$PID"
            echo "Killed process $PID."
        fi
        rm -f "$PID_FILE"
    fi

    # Also clean up any lingering processes on ports 8818, 8819, 8820
    for port in 8818 8819 8820; do
        if command -v fuser >/dev/null 2>&1; then
            fuser -k "${port}/tcp" 2>/dev/null || true
        elif command -v lsof >/dev/null 2>&1; then
            pids=$(lsof -ti :"$port" || true)
            if [ -n "$pids" ]; then
                kill -9 $pids 2>/dev/null || true
            fi
        fi
    done
    echo -e "\033[32mAll relays stopped.\033[0m"
}

restart() {
    stop
    sleep 1
    start
}

repair() {
    echo -e "\033[35m=== Repairing and restarting LLM Agent Relays ===\033[0m"
    stop
    sleep 1
    start
}

menu() {
    while true; do
        clear
        echo "================================================================"
        echo "           LLM Agent Relays - Management Console (Unix)"
        echo "================================================================"
        echo "  [1] Check Status & Health"
        echo "  [2] Start Relays (background)"
        echo "  [3] Stop Relays"
        echo "  [4] Repair & Restart"
        echo "  [5] Deep Diagnostic (__diag probe)"
        echo "  [0] Exit"
        echo "================================================================"
        read -p "Select option [0-5]: " choice
        case "$choice" in
            1) status; read -p "Press Enter to continue..." ;;
            2) start; read -p "Press Enter to continue..." ;;
            3) stop; read -p "Press Enter to continue..." ;;
            4) repair; read -p "Press Enter to continue..." ;;
            5) diag; read -p "Press Enter to continue..." ;;
            0) exit 0 ;;
            *) echo "Invalid choice"; sleep 1 ;;
        esac
    done
}

case "${1:-menu}" in
    status)  status ;;
    diag)    diag ;;
    start)   start ;;
    stop)    stop ;;
    restart) restart ;;
    repair)  repair ;;
    menu)    menu ;;
    *)       menu ;;
esac
