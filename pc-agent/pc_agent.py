#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PC Remote Agent — управление ПК из приложения «ПК Пульт».

Агент слушает локальную сеть и выполняет команды только при наличии токена.
Никаких сторонних библиотек не требуется: Python 3.8+ и стандартная библиотека.
"""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import hmac
import ipaddress
import json
import logging
import logging.handlers
import os
import platform
import re
import secrets
import socket
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import Request, urlopen

APP_VERSION = "1.1.1"
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
LOG_PATH = os.path.join(BASE_DIR, "pc_agent.log")
DRY_RUN = os.environ.get("PCREMOTE_DRY_RUN", "") == "1"
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
IS_WINDOWS = os.name == "nt"


def detect_system_account():
    """Проверяет, запущен ли процесс от имени SYSTEM (SID S-1-5-18)."""
    if not IS_WINDOWS:
        return False
    system_root = os.environ.get("SystemRoot", r"C:\Windows")
    whoami = os.path.join(system_root, "System32", "whoami.exe")
    if not os.path.exists(whoami):
        whoami = "whoami.exe"
    try:
        result = subprocess.run(
            [whoami, "/user", "/fo", "csv", "/nh"],
            capture_output=True,
            text=True,
            timeout=6,
            creationflags=CREATE_NO_WINDOW,
        )
        return "S-1-5-18" in (result.stdout or "")
    except Exception:  # noqa: BLE001 — определение учётной записи не должно ронять агент
        return False


IS_SYSTEM = detect_system_account()

DEFAULT_CONFIG = {
    "port": 8765,
    "discovery_port": 8766,
    "session_port": 8767,
    "token": "",
}

ACTIONS = {
    "shutdown": {
        "args": ["shutdown.exe", "/s", "/t", "0"],
        "message": "ПК выключается",
        "delay": 1.0,
    },
    "restart": {
        "args": ["shutdown.exe", "/r", "/t", "0"],
        "message": "ПК перезагружается",
        "delay": 1.0,
    },
    "sleep": {
        "args": ["rundll32.exe", "powrprof.dll,SetSuspendState", "0,1,0"],
        "message": "ПК уходит в сон",
        "delay": 1.0,
    },
    "lock": {
        "args": ["rundll32.exe", "user32.dll,LockWorkStation"],
        "message": "Экран заблокирован",
        "delay": 0,
    },
    "abort": {
        "args": ["shutdown.exe", "/a"],
        "message": "Запланированное выключение отменено",
        "delay": 0,
    },
}

CONFIG = {}
MACHINE = {"ip": "", "mac": ""}
FAILURES = {}
FAILURES_LOCK = threading.Lock()
MAX_FAILURES = 10
FAILURE_WINDOW = 60

log = logging.getLogger("pcremote")


# --------------------------------------------------------------------------
# Служебные функции
# --------------------------------------------------------------------------


def setup_logging():
    log.setLevel(logging.INFO)
    log.handlers.clear()
    formatter = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
    try:
        file_handler = logging.handlers.RotatingFileHandler(
            LOG_PATH, maxBytes=512 * 1024, backupCount=3, encoding="utf-8"
        )
        file_handler.setFormatter(formatter)
        log.addHandler(file_handler)
    except OSError:
        pass
    if sys.stderr is not None and sys.stderr.isatty():
        console_handler = logging.StreamHandler()
        console_handler.setFormatter(formatter)
        log.addHandler(console_handler)


def generate_token():
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    raw = "".join(secrets.choice(alphabet) for _ in range(10))
    return raw[:5] + "-" + raw[5:]


def normalize_token(value):
    return re.sub(r"[^A-Z0-9]", "", (value or "").upper())


def save_config(config):
    temp_path = CONFIG_PATH + ".tmp"
    with open(temp_path, "w", encoding="utf-8") as handle:
        json.dump(config, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.replace(temp_path, CONFIG_PATH)


def load_config():
    config = dict(DEFAULT_CONFIG)
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8-sig") as handle:
                loaded = json.load(handle)
            if isinstance(loaded, dict):
                config.update(loaded)
        except (OSError, ValueError) as error:
            log.error("Не удалось прочитать config.json: %s", error)
    try:
        config["port"] = int(config.get("port") or 8765)
    except (TypeError, ValueError):
        config["port"] = 8765
    try:
        config["discovery_port"] = int(config.get("discovery_port") or 8766)
    except (TypeError, ValueError):
        config["discovery_port"] = 8766
    try:
        config["session_port"] = int(config.get("session_port") or 8767)
    except (TypeError, ValueError):
        config["session_port"] = 8767
    if not str(config.get("token") or "").strip():
        config["token"] = generate_token()
        save_config(config)
    return config


def detect_primary_ip():
    # UDP-трюк с 8.8.8.8 выбирает маршрут по умолчанию и может вернуть адрес
    # VPN-туннеля. Для телефона нужен адрес физического LAN-адаптера.
    if IS_WINDOWS:
        command = (
            "$a = Get-NetAdapter -Physical -ErrorAction SilentlyContinue | "
            "Where-Object { $_.Status -eq 'Up' -and "
            "$_.InterfaceDescription -notmatch 'Bluetooth|Wintun|Virtual|VPN' } | "
            "Sort-Object ifIndex | Select-Object -First 1; "
            "if ($a) { Get-NetIPAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4 "
            "-ErrorAction SilentlyContinue | "
            "Where-Object { $_.IPAddress -notlike '169.254.*' -and $_.IPAddress -ne '127.0.0.1' } | "
            "Select-Object -First 1 -ExpandProperty IPAddress }"
        )
        try:
            result = subprocess.run(
                ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
                capture_output=True,
                text=True,
                timeout=12,
                creationflags=CREATE_NO_WINDOW,
            )
            lines = [line.strip() for line in (result.stdout or "").splitlines() if line.strip()]
            ip = lines[-1] if lines else ""
            if re.fullmatch(r"(\d{1,3}\.){3}\d{1,3}", ip) and not ip.startswith("127."):
                return ip
        except Exception as error:  # noqa: BLE001 — диагностика не должна ронять агент
            log.debug("Не удалось определить IP через PowerShell: %s", error)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()


def detect_primary_mac():
    if IS_WINDOWS:
        command = (
            "$a = Get-NetAdapter -Physical -ErrorAction SilentlyContinue | "
            "Where-Object { $_.Status -eq 'Up' -and "
            "$_.InterfaceDescription -notmatch 'Bluetooth|Wintun|Virtual|VPN' } | "
            "Sort-Object ifIndex | Select-Object -First 1; "
            "if ($a) { $a.MacAddress }"
        )
        try:
            result = subprocess.run(
                ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
                capture_output=True,
                text=True,
                timeout=12,
                creationflags=CREATE_NO_WINDOW,
            )
            lines = [line.strip() for line in (result.stdout or "").splitlines() if line.strip()]
            mac = lines[-1] if lines else ""
            if re.fullmatch(r"([0-9A-Fa-f]{2}[-:]){5}[0-9A-Fa-f]{2}", mac):
                return mac.replace("-", ":").upper()
        except Exception as error:  # noqa: BLE001 — диагностика не должна ронять агент
            log.debug("Не удалось определить MAC через PowerShell: %s", error)
    node = uuid.getnode()
    return ":".join(f"{(node >> shift) & 0xFF:02X}" for shift in range(40, -1, -8))


def system_uptime():
    if not IS_WINDOWS:
        return 0
    try:
        return int(ctypes.windll.kernel32.GetTickCount64() / 1000)
    except Exception:  # noqa: BLE001
        return 0


# --------------------------------------------------------------------------
# Помощник в сессии пользователя
# --------------------------------------------------------------------------

SESSION_HEALTH_CACHE = {"at": 0.0, "data": None}
SESSION_HEALTH_LOCK = threading.Lock()


def session_secret():
    token = normalize_token(CONFIG.get("token", ""))
    return hmac.new(
        token.encode("ascii", "ignore"), b"pcremote-session-v1", hashlib.sha256
    ).hexdigest()


def session_url(path):
    port = int(CONFIG.get("session_port", 8767))
    return "http://127.0.0.1:{0}{1}".format(port, path)


def session_request(method, path, payload=None, timeout=35):
    """Выполняет запрос к помощнику в сессии пользователя."""
    data = None
    headers = {
        "Accept": "application/json",
        "X-Session-Secret": session_secret(),
    }
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    request = Request(session_url(path), data=data, headers=headers, method=method)
    try:
        with urlopen(request, timeout=timeout) as response:
            status = response.status
            raw = response.read()
    except HTTPError as error:
        status = error.code
        raw = error.read()
    except (URLError, socket.timeout, TimeoutError) as error:
        log.warning("Помощник сессии недоступен: %s", error)
        return 503, {
            "ok": False,
            "error": "Помощник сессии не запущен. Переустановите агент или войдите в Windows",
        }
    except Exception as error:  # noqa: BLE001
        log.error("Ошибка запроса к помощнику: %s", error)
        return 500, {"ok": False, "error": "Не удалось связаться с помощником сессии"}

    try:
        result = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        log.error("Помощник вернул не JSON: %s", raw[:200])
        return 502, {"ok": False, "error": "Помощник вернул некорректный ответ"}
    if not isinstance(result, dict):
        return 502, {"ok": False, "error": "Помощник вернул некорректный ответ"}
    if status == 401:
        result["error"] = "Помощник сессии отклонил запрос. Проверьте токен в config.json"
    return status, result


def session_health(force=False):
    now = time.time()
    with SESSION_HEALTH_LOCK:
        cached = SESSION_HEALTH_CACHE.get("data")
        if not force and cached and now - SESSION_HEALTH_CACHE["at"] < 4.0:
            return dict(cached)
    request = Request(session_url("/health"), headers={"Accept": "application/json"})
    try:
        with urlopen(request, timeout=1.5) as response:
            result = json.loads(response.read().decode("utf-8"))
        if not isinstance(result, dict):
            raise ValueError("bad health payload")
        data = {
            "ok": bool(result.get("ok")),
            "version": result.get("version", ""),
            "user": result.get("user", ""),
            "session_id": result.get("session_id", -1),
        }
    except Exception as error:  # noqa: BLE001
        data = {
            "ok": False,
            "error": "Помощник сессии не запущен",
            "detail": str(error),
        }
    with SESSION_HEALTH_LOCK:
        SESSION_HEALTH_CACHE["at"] = now
        SESSION_HEALTH_CACHE["data"] = data
    return dict(data)


def status_payload():
    return {
        "ok": True,
        "app": "pcremote",
        "agent_version": APP_VERSION,
        "hostname": socket.gethostname(),
        "os": platform.platform(),
        "uptime_sec": system_uptime(),
        "ip": MACHINE["ip"],
        "mac": MACHINE["mac"],
        "port": int(CONFIG.get("port", 8765)),
        "dry_run": DRY_RUN,
        "session": session_health(),
    }


def is_lan(ip_text):
    try:
        address = ipaddress.ip_address(ip_text)
    except ValueError:
        return False
    return address.is_private or address.is_loopback or address.is_link_local


def token_ok(provided):
    expected = normalize_token(CONFIG.get("token", ""))
    if not expected:
        return False
    return hmac.compare_digest(normalize_token(provided), expected)


def too_many_failures(ip_text):
    now = time.time()
    with FAILURES_LOCK:
        attempts = [stamp for stamp in FAILURES.get(ip_text, []) if now - stamp < FAILURE_WINDOW]
        FAILURES[ip_text] = attempts
        return len(attempts) >= MAX_FAILURES


def note_failure(ip_text):
    with FAILURES_LOCK:
        FAILURES.setdefault(ip_text, []).append(time.time())


def clear_failures(ip_text):
    with FAILURES_LOCK:
        FAILURES.pop(ip_text, None)


# --------------------------------------------------------------------------
# Выполнение команд
# --------------------------------------------------------------------------


def perform(action):
    spec = ACTIONS.get(action)
    if not spec:
        return False, "Неизвестная команда"
    if DRY_RUN:
        log.info("[dry-run] команда %s: %s", action, spec["args"])
        return True, spec["message"]
    if action == "lock" and IS_SYSTEM:
        # Агент работает как SYSTEM и не может заблокировать сессию пользователя
        # напрямую, поэтому запускаем заранее созданную задачу в сессии пользователя.
        try:
            result = subprocess.run(
                ["schtasks.exe", "/run", "/tn", "PCRemoteLock"],
                capture_output=True,
                text=True,
                timeout=15,
                creationflags=CREATE_NO_WINDOW,
            )
            if result.returncode == 0:
                return True, spec["message"]
            detail = (result.stderr or result.stdout or "").strip()
            log.warning("Задача блокировки не запустилась: %s", detail)
            return False, "Не удалось заблокировать экран. Переустановите агент"
        except Exception as error:  # noqa: BLE001
            log.error("Ошибка запуска задачи блокировки: %s", error)
            return False, "Не удалось заблокировать экран"
    try:
        subprocess.Popen(
            spec["args"],
            close_fds=True,
            creationflags=CREATE_NO_WINDOW,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return True, spec["message"]
    except Exception as error:  # noqa: BLE001
        log.error("Команда %s не выполнилась: %s", action, error)
        return False, f"Не удалось выполнить: {error}"


# --------------------------------------------------------------------------
# Поиск агента в сети (UDP broadcast)
# --------------------------------------------------------------------------


def discovery_loop():
    port = int(CONFIG.get("discovery_port", 8766))
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("0.0.0.0", port))
    except OSError as error:
        log.error("Поиск в сети отключён: не удалось занять UDP %s: %s", port, error)
        return
    log.info("Поиск в сети слушает UDP %s", port)
    while True:
        try:
            data, address = sock.recvfrom(2048)
        except OSError as error:
            log.error("Ошибка UDP-сокета поиска: %s", error)
            time.sleep(1)
            continue
        if not data.startswith(b"PCREMOTE_DISCOVER"):
            continue
        reply = {
            "app": "pcremote",
            "name": socket.gethostname(),
            "mac": MACHINE["mac"],
            "ip": MACHINE["ip"],
            "port": int(CONFIG.get("port", 8765)),
            "version": APP_VERSION,
        }
        try:
            sock.sendto(json.dumps(reply).encode("utf-8"), address)
        except OSError as error:
            log.debug("Не удалось ответить на поиск: %s", error)


# --------------------------------------------------------------------------
# HTTP-сервер
# --------------------------------------------------------------------------


class AgentHandler(BaseHTTPRequestHandler):
    server_version = "PCRemote/" + APP_VERSION
    sys_version = ""

    def do_OPTIONS(self):  # noqa: N802 — имя задано стандартной библиотекой
        self.send_response(204)
        self.send_cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):  # noqa: N802
        self.handle_request("GET")

    def do_POST(self):  # noqa: N802
        self.handle_request("POST")

    def send_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Auth-Token")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-store")

    def send_json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(code)
            self.send_cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def read_json_body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length > 262144:
            raise ValueError("Слишком большой запрос")
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        if not raw:
            return {}
        try:
            data = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as error:
            raise ValueError("Неверный JSON") from error
        return data if isinstance(data, dict) else {}

    def proxy(self, method, path, payload=None, timeout=35):
        code, result = session_request(method, path, payload=payload, timeout=timeout)
        self.send_json(code, result)

    def handle_request(self, method):
        client = self.client_address[0]
        parsed = urlsplit(self.path)
        path = parsed.path.rstrip("/") or "/"
        query = parse_qs(parsed.query)

        if not is_lan(client):
            self.send_json(403, {"ok": False, "error": "Доступ разрешён только из локальной сети"})
            return

        if path == "/health":
            self.send_json(200, {"ok": True, "app": "pcremote", "version": APP_VERSION})
            return

        if too_many_failures(client):
            self.send_json(429, {"ok": False, "error": "Слишком много попыток. Подождите минуту"})
            return

        if not token_ok(self.headers.get("X-Auth-Token")):
            note_failure(client)
            log.warning("Неверный токен с %s (%s %s)", client, method, path)
            self.send_json(401, {"ok": False, "error": "Неверный токен доступа"})
            return

        clear_failures(client)

        if path == "/status" and method == "GET":
            self.send_json(200, status_payload())
            return

        if path == "/session" and method == "GET":
            self.send_json(200, {"ok": True, "session": session_health(force=True)})
            return

        if method == "POST" and path.lstrip("/") in ACTIONS:
            action = path.lstrip("/")
            log.info("Команда «%s» с %s", action, client)
            spec = ACTIONS[action]
            if action in ("shutdown", "restart", "sleep"):
                # Сначала отвечаем телефону, потом выполняем команду,
                # чтобы приложение успело показать результат.
                self.send_json(
                    200, {"ok": True, "action": action, "message": spec["message"]}
                )
                threading.Thread(
                    target=self.perform_delayed, args=(action,), daemon=True
                ).start()
                return
            ok, message = perform(action)
            self.send_json(
                200 if ok else 500,
                {"ok": ok, "action": action, "message": message, "error": None if ok else message},
            )
            return

        # --- Команды в интерактивной сессии пользователя ------------------

        if path == "/screenshot" and method == "GET":
            log.info("Скриншот экрана с %s", client)
            self.proxy("GET", "/screenshot", timeout=45)
            return

        if path == "/apps" and method == "GET":
            search = (query.get("q") or [""])[0]
            force = (query.get("refresh") or ["0"])[0] in ("1", "true", "yes")
            suffix = urlencode({"q": search, "refresh": "1" if force else "0"})
            self.proxy("GET", "/apps?" + suffix, timeout=30)
            return

        if method == "POST" and path in (
            "/volume",
            "/media",
            "/hotkey",
            "/monitor_off",
            "/launch",
            "/bt",
        ):
            try:
                payload = self.read_json_body()
            except ValueError as error:
                self.send_json(400, {"ok": False, "error": str(error)})
                return
            timeouts = {
                "/volume": 12,
                "/media": 12,
                "/hotkey": 12,
                "/monitor_off": 12,
                "/launch": 20,
                "/bt": 40,
            }
            log.info("Команда %s с %s", path, client)
            self.proxy("POST", path, payload=payload, timeout=timeouts[path])
            return

        if path == "/":
            self.send_json(200, {"ok": True, "app": "pcremote", "version": APP_VERSION})
            return

        self.send_json(404, {"ok": False, "error": "Неизвестная команда"})

    def perform_delayed(self, action):
        delay = float(ACTIONS[action].get("delay", 1.0))
        if delay:
            time.sleep(delay)
        perform(action)

    def log_message(self, fmt, *args):
        log.info("%s - %s", self.client_address[0], fmt % args)


# --------------------------------------------------------------------------
# Запуск
# --------------------------------------------------------------------------


def serve():
    MACHINE["ip"] = detect_primary_ip()
    MACHINE["mac"] = detect_primary_mac()
    log.info(
        "Запуск агента: IP=%s MAC=%s TCP=%s UDP=%s dry_run=%s system=%s",
        MACHINE["ip"],
        MACHINE["mac"],
        CONFIG["port"],
        CONFIG["discovery_port"],
        DRY_RUN,
        IS_SYSTEM,
    )

    threading.Thread(target=discovery_loop, daemon=True).start()

    try:
        server = ThreadingHTTPServer(("0.0.0.0", int(CONFIG["port"])), AgentHandler)
    except OSError as error:
        log.error("Не удалось занять TCP %s: %s", CONFIG["port"], error)
        return 1
    server.daemon_threads = True
    log.info("HTTP-сервер слушает TCP %s", CONFIG["port"])
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("Остановлено пользователем")
    finally:
        server.server_close()
    return 0


def main():
    parser = argparse.ArgumentParser(description="PC Remote Agent")
    parser.add_argument("--init", action="store_true", help="создать config.json и показать данные")
    parser.add_argument("--info", action="store_true", help="показать данные подключения и выйти")
    parser.add_argument("--port", type=int, help="изменить порт агента")
    args = parser.parse_args()

    setup_logging()
    global CONFIG
    CONFIG = load_config()
    if args.port:
        CONFIG["port"] = args.port
        save_config(CONFIG)

    if args.init or args.info:
        MACHINE["ip"] = detect_primary_ip()
        MACHINE["mac"] = detect_primary_mac()
        if args.init:
            save_config(CONFIG)
        print(json.dumps(status_payload(), ensure_ascii=True, indent=2))
        return 0

    return serve()


if __name__ == "__main__":
    raise SystemExit(main())
