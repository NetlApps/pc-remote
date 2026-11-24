#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PC Remote Session Helper — действия в интерактивной сессии пользователя.

Агент PCRemoteAgent работает от SYSTEM в сессии 0 и не может управлять
громкостью, экраном и окнами пользователя. Этот помощник запускается при
входе пользователя в его сессии и слушает только 127.0.0.1.

Запросы принимаются только с секретом, производным от токена агента.
Сторонние библиотеки не нужны: Python 3.8+, стандартная библиотека и
встроенные средства Windows (PowerShell/.NET, user32.dll).
"""

from __future__ import annotations

import base64
import ctypes
import hashlib
import hmac
import json
import logging
import logging.handlers
import os
import re
import struct
import subprocess
import sys
import threading
import time
import uuid
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

APP_VERSION = "1.1.2"
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
LOG_PATH = os.path.join(BASE_DIR, "session_helper.log")
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
IS_WINDOWS = os.name == "nt"

DEFAULT_SESSION_PORT = 8767
BT_APP_NAME = "Bluetooth Audio Receiver"
BT_APP_ID_FALLBACK = "55746MarkSmirnov.BluetoothAudioReveicer_xwrbx6997tsfc!App"
BT_OPEN_BUTTON_ID = "OpenAudioPlaybackConnectionButtonButton"
BT_CLOSE_BUTTON_ID = "CloseAudioPlaybackConnectionButtonButton"

CONFIG = {}
CATALOG_LOCK = threading.Lock()
CATALOG_CACHE = {"at": 0.0, "apps": []}
CATALOG_TTL = 300.0

log = logging.getLogger("pcremote.session")


# --------------------------------------------------------------------------
# Конфигурация и журнал
# --------------------------------------------------------------------------


def normalize_token(value):
    return re.sub(r"[^A-Z0-9]", "", (value or "").upper())


def load_config():
    config = {
        "port": 8765,
        "session_port": DEFAULT_SESSION_PORT,
        "discovery_port": 8766,
        "token": "",
    }
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8-sig") as handle:
            loaded = json.load(handle)
        if isinstance(loaded, dict):
            config.update(loaded)
    except (OSError, ValueError):
        pass
    try:
        config["session_port"] = int(config.get("session_port") or DEFAULT_SESSION_PORT)
    except (TypeError, ValueError):
        config["session_port"] = DEFAULT_SESSION_PORT
    return config


def session_secret():
    token = normalize_token(CONFIG.get("token", ""))
    return hmac.new(
        token.encode("ascii", "ignore"), b"pcremote-session-v1", hashlib.sha256
    ).hexdigest()


def setup_logging():
    log.setLevel(logging.INFO)
    log.handlers.clear()
    formatter = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
    try:
        handler = logging.handlers.RotatingFileHandler(
            LOG_PATH, maxBytes=512 * 1024, backupCount=2, encoding="utf-8"
        )
        handler.setFormatter(formatter)
        log.addHandler(handler)
    except OSError:
        pass
    if sys.stderr is not None and sys.stderr.isatty():
        console = logging.StreamHandler()
        console.setFormatter(formatter)
        log.addHandler(console)


def current_session_id():
    try:
        session_id = ctypes.c_uint()
        ctypes.windll.kernel32.ProcessIdToSessionId(
            ctypes.windll.kernel32.GetCurrentProcessId(), ctypes.byref(session_id)
        )
        return int(session_id.value)
    except Exception:  # noqa: BLE001
        return -1


# --------------------------------------------------------------------------
# Ввод: клавиши, громкость, медиа
# --------------------------------------------------------------------------

user32 = ctypes.windll.user32 if IS_WINDOWS else None

KEYEVENTF_EXTENDEDKEY = 0x0001
KEYEVENTF_KEYUP = 0x0002

VK_MEDIA_NEXT = 0xB0
VK_MEDIA_PREV = 0xB1
VK_MEDIA_STOP = 0xB2
VK_MEDIA_PLAY_PAUSE = 0xB3
VK_VOLUME_MUTE = 0xAD
VK_VOLUME_DOWN = 0xAE
VK_VOLUME_UP = 0xAF

MEDIA_KEYS = {
    "next": (VK_MEDIA_NEXT, True),
    "prev": (VK_MEDIA_PREV, True),
    "previous": (VK_MEDIA_PREV, True),
    "stop": (VK_MEDIA_STOP, True),
    "play": (VK_MEDIA_PLAY_PAUSE, True),
    "pause": (VK_MEDIA_PLAY_PAUSE, True),
    "play_pause": (VK_MEDIA_PLAY_PAUSE, True),
    "toggle": (VK_MEDIA_PLAY_PAUSE, True),
}

MODIFIERS = {
    "ctrl": 0x11,
    "control": 0x11,
    "alt": 0x12,
    "shift": 0x10,
    "win": 0x5B,
    "windows": 0x5B,
    "meta": 0x5B,
}

SPECIAL_KEYS = {
    "enter": (0x0D, False),
    "return": (0x0D, False),
    "esc": (0x1B, False),
    "escape": (0x1B, False),
    "tab": (0x09, False),
    "space": (0x20, False),
    "backspace": (0x08, False),
    "delete": (0x2E, True),
    "del": (0x2E, True),
    "insert": (0x2D, True),
    "ins": (0x2D, True),
    "home": (0x24, True),
    "end": (0x23, True),
    "pageup": (0x21, True),
    "pgup": (0x21, True),
    "pagedown": (0x22, True),
    "pgdn": (0x22, True),
    "up": (0x26, True),
    "down": (0x28, True),
    "left": (0x25, True),
    "right": (0x27, True),
    "printscreen": (0x2C, True),
    "prtsc": (0x2C, True),
    "pause": (0x13, False),
    "capslock": (0x14, False),
    "numlock": (0x90, True),
    "scrolllock": (0x91, False),
    "minus": (0xBD, False),
    "-": (0xBD, False),
    "plus": (0xBB, False),
    "=": (0xBB, False),
    "comma": (0xBC, False),
    ",": (0xBC, False),
    "period": (0xBE, False),
    ".": (0xBE, False),
    "slash": (0xBF, False),
    "/": (0xBF, False),
    "backslash": (0xDC, False),
    "\\": (0xDC, False),
    "semicolon": (0xBA, False),
    ";": (0xBA, False),
    "quote": (0xDE, False),
    "'": (0xDE, False),
    "bracketleft": (0xDB, False),
    "[": (0xDB, False),
    "bracketright": (0xDD, False),
    "]": (0xDD, False),
    "grave": (0xC0, False),
    "`": (0xC0, False),
}


def key_event(vk, extended=False, up=False):
    if not user32:
        return
    flags = (KEYEVENTF_EXTENDEDKEY if extended else 0) | (
        KEYEVENTF_KEYUP if up else 0
    )
    user32.keybd_event(int(vk), 0, flags, 0)


def tap_key(vk, extended=False, delay=0.025):
    key_event(vk, extended, False)
    time.sleep(delay)
    key_event(vk, extended, True)


def send_media(key):
    spec = MEDIA_KEYS.get(str(key or "").strip().lower())
    if not spec:
        return False, "Неизвестная медиа-клавиша"
    tap_key(spec[0], spec[1], 0.03)
    return True, "Медиа-клавиша отправлена"


def send_volume(steps, mute=False):
    if mute:
        tap_key(VK_VOLUME_MUTE, True, 0.03)
        return True, "Звук переключён"
    try:
        count = int(steps)
    except (TypeError, ValueError):
        return False, "Неверное число шагов громкости"
    count = max(-20, min(20, count))
    if count == 0:
        return False, "Укажите шаг громкости"
    vk = VK_VOLUME_UP if count > 0 else VK_VOLUME_DOWN
    for _ in range(abs(count)):
        tap_key(vk, True, 0.02)
        time.sleep(0.03)
    return True, "Громкость " + ("увеличена" if count > 0 else "уменьшена")


def parse_combo(combo):
    text = str(combo or "").strip()
    if not text:
        raise ValueError("Пустое сочетание клавиш")
    parts = [part.strip().lower() for part in re.split(r"\s*\+\s*", text) if part.strip()]
    if not parts:
        raise ValueError("Пустое сочетание клавиш")
    if len(parts) > 5:
        raise ValueError("Слишком много клавиш в сочетании")

    modifiers = []
    key_vk = None
    key_extended = False
    for part in parts:
        if part in MODIFIERS:
            modifiers.append(MODIFIERS[part])
            continue
        if part in SPECIAL_KEYS:
            key_vk, key_extended = SPECIAL_KEYS[part]
            continue
        match = re.fullmatch(r"f([1-9]|1[0-9]|2[0-4])", part)
        if match:
            key_vk, key_extended = 0x70 + int(match.group(1)) - 1, False
            continue
        if len(part) == 1 and part.isascii() and part.isalnum():
            key_vk, key_extended = ord(part.upper()), False
            continue
        raise ValueError("Неизвестная клавиша: " + part)

    if key_vk is None:
        raise ValueError("В сочетании нет основной клавиши")
    if not modifiers and not (0x70 <= key_vk <= 0x87):
        raise ValueError("Добавьте Ctrl, Alt, Shift или Win")
    return modifiers, key_vk, key_extended


def send_hotkey(combo):
    try:
        modifiers, key_vk, key_extended = parse_combo(combo)
    except ValueError as error:
        return False, str(error)
    for modifier in modifiers:
        key_event(modifier, False, False)
        time.sleep(0.02)
    tap_key(key_vk, key_extended, 0.03)
    for modifier in reversed(modifiers):
        key_event(modifier, False, True)
        time.sleep(0.02)
    return True, "Горячие клавиши отправлены"


HWND_BROADCAST = 0xFFFF
WM_SYSCOMMAND = 0x0112
SC_MONITORPOWER = 0xF170
MOUSEEVENTF_MOVE = 0x0001
ES_CONTINUOUS = 0x80000000
ES_DISPLAY_REQUIRED = 0x00000002

MONITOR_LOCK = threading.Lock()
MONITOR_STATE = {
    "off_at": 0.0,
    "on_at": 0.0,
    "timeout": 900,
    "timeout_at": 0.0,
}


class _GUID(ctypes.Structure):
    _fields_ = [
        ("Data1", ctypes.c_ulong),
        ("Data2", ctypes.c_ushort),
        ("Data3", ctypes.c_ushort),
        ("Data4", ctypes.c_ubyte * 8),
    ]


class _LASTINPUTINFO(ctypes.Structure):
    _fields_ = [("cbSize", ctypes.c_uint), ("dwTime", ctypes.c_uint)]


def _guid(value):
    return _GUID.from_buffer_copy(uuid.UUID(value).bytes_le)


POWER_VIDEO_SUBGROUP = _guid("7516b95f-f776-4464-8c53-06167f40cc99")
POWER_VIDEO_TIMEOUT = _guid("3c0bc021-c8a8-4e07-a973-6b14cbcb2b7e")


def monitor_idle_seconds():
    """Сколько секунд прошло с последнего ввода пользователя."""
    if not user32:
        return 0.0
    try:
        info = _LASTINPUTINFO()
        info.cbSize = ctypes.sizeof(info)
        if not user32.GetLastInputInfo(ctypes.byref(info)):
            return 0.0
        kernel32 = ctypes.windll.kernel32
        kernel32.GetTickCount64.restype = ctypes.c_ulonglong
        current = int(kernel32.GetTickCount64()) & 0xFFFFFFFF
        elapsed = (current - int(info.dwTime)) & 0xFFFFFFFF
        return elapsed / 1000.0
    except Exception:  # noqa: BLE001
        return 0.0


def monitor_timeout_seconds():
    """Таймаут отключения экрана из активной схемы питания (или 15 минут)."""
    now = time.time()
    with MONITOR_LOCK:
        cached_at = float(MONITOR_STATE["timeout_at"])
        cached = int(MONITOR_STATE["timeout"])
    if cached_at and now - cached_at < 120:
        return cached

    timeout = 900
    scheme = ctypes.POINTER(_GUID)()
    try:
        powr = ctypes.windll.powrprof
        powr.PowerGetActiveScheme.restype = ctypes.c_ulong
        powr.PowerGetActiveScheme.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.POINTER(_GUID)),
        ]
        for reader in (powr.PowerReadACValue, powr.PowerReadDCValue):
            reader.restype = ctypes.c_ulong
            reader.argtypes = [
                ctypes.c_void_p,
                ctypes.POINTER(_GUID),
                ctypes.POINTER(_GUID),
                ctypes.POINTER(_GUID),
                ctypes.POINTER(ctypes.c_ulong),
                ctypes.c_void_p,
                ctypes.POINTER(ctypes.c_ulong),
            ]
        if powr.PowerGetActiveScheme(None, ctypes.byref(scheme)) == 0 and scheme:
            for reader in (powr.PowerReadACValue, powr.PowerReadDCValue):
                value_type = ctypes.c_ulong()
                size = ctypes.c_ulong(4)
                value = ctypes.c_ulong(0)
                rc = reader(
                    None,
                    scheme,
                    ctypes.byref(POWER_VIDEO_SUBGROUP),
                    ctypes.byref(POWER_VIDEO_TIMEOUT),
                    ctypes.byref(value_type),
                    ctypes.byref(value),
                    ctypes.byref(size),
                )
                if rc == 0 and size.value == 4 and 0 <= int(value.value) <= 86400:
                    timeout = int(value.value)
                    break
    except Exception:  # noqa: BLE001
        pass
    finally:
        if scheme:
            try:
                ctypes.windll.kernel32.LocalFree(ctypes.cast(scheme, ctypes.c_void_p))
            except Exception:  # noqa: BLE001
                pass

    with MONITOR_LOCK:
        MONITOR_STATE["timeout"] = timeout
        MONITOR_STATE["timeout_at"] = now
    return timeout


def monitor_off():
    if not user32:
        return False, "Только для Windows"
    try:
        user32.SendMessageW(HWND_BROADCAST, WM_SYSCOMMAND, SC_MONITORPOWER, 2)
        with MONITOR_LOCK:
            MONITOR_STATE["off_at"] = time.time()
            MONITOR_STATE["on_at"] = 0.0
        return True, "Монитор выключен"
    except Exception as error:  # noqa: BLE001
        log.error("Не удалось выключить монитор: %s", error)
        return False, "Не удалось выключить монитор"


def monitor_on():
    if not user32:
        return False, "Только для Windows"
    try:
        user32.SendMessageW(HWND_BROADCAST, WM_SYSCOMMAND, SC_MONITORPOWER, -1)
        try:
            user32.mouse_event.argtypes = [
                ctypes.c_ulong,
                ctypes.c_long,
                ctypes.c_long,
                ctypes.c_ulong,
                ctypes.c_void_p,
            ]
            user32.mouse_event(MOUSEEVENTF_MOVE, 1, 0, 0, None)
            time.sleep(0.05)
            user32.mouse_event(MOUSEEVENTF_MOVE, -1, 0, 0, None)
        except Exception:  # noqa: BLE001
            pass
        try:
            kernel32 = ctypes.windll.kernel32
            kernel32.SetThreadExecutionState.restype = ctypes.c_ulong
            kernel32.SetThreadExecutionState.argtypes = [ctypes.c_ulong]
            kernel32.SetThreadExecutionState(ES_CONTINUOUS | ES_DISPLAY_REQUIRED)
            time.sleep(0.15)
            kernel32.SetThreadExecutionState(ES_CONTINUOUS)
        except Exception:  # noqa: BLE001
            pass
        with MONITOR_LOCK:
            MONITOR_STATE["on_at"] = time.time()
            MONITOR_STATE["off_at"] = 0.0
        return True, "Монитор включён"
    except Exception as error:  # noqa: BLE001
        log.error("Не удалось включить монитор: %s", error)
        return False, "Не удалось включить монитор"


def monitor_state():
    now = time.time()
    idle = monitor_idle_seconds()
    timeout = monitor_timeout_seconds()
    last_input_at = now - idle
    with MONITOR_LOCK:
        off_at = float(MONITOR_STATE["off_at"])
        on_at = float(MONITOR_STATE["on_at"])
    if off_at and last_input_at > off_at + 0.75:
        # Пользователь снова коснулся клавиатуры/мыши — экран уже горит.
        off_at = 0.0
        with MONITOR_LOCK:
            MONITOR_STATE["off_at"] = 0.0
    if off_at:
        is_on = False
    else:
        since = max(last_input_at, on_at)
        is_on = timeout <= 0 or (now - since) < timeout
    return {
        "monitor_on": bool(is_on),
        "explicit_off": bool(off_at),
        "idle_seconds": round(max(0.0, idle), 1),
        "timeout_seconds": int(timeout),
    }


# --------------------------------------------------------------------------
# Запуск PowerShell
# --------------------------------------------------------------------------


def run_powershell(script, timeout=25):
    encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    command = [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encoded,
    ]
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            creationflags=CREATE_NO_WINDOW,
        )
    except subprocess.TimeoutExpired:
        return None, "PowerShell не ответил вовремя"
    except Exception as error:  # noqa: BLE001
        return None, "Не удалось запустить PowerShell: " + str(error)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        if len(detail) > 600:
            detail = detail[-600:]
        return None, detail or "PowerShell завершился с ошибкой"
    return (result.stdout or "").strip(), None


def parse_last_json(text):
    if not text:
        return None
    for line in reversed(text.splitlines()):
        line = line.strip()
        if line.startswith("{") and line.endswith("}"):
            try:
                return json.loads(line)
            except ValueError:
                continue
    return None


# --------------------------------------------------------------------------
# Скриншот экрана (GDI + PNG, без PowerShell)
# --------------------------------------------------------------------------


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", ctypes.c_uint32),
        ("biWidth", ctypes.c_int32),
        ("biHeight", ctypes.c_int32),
        ("biPlanes", ctypes.c_uint16),
        ("biBitCount", ctypes.c_uint16),
        ("biCompression", ctypes.c_uint32),
        ("biSizeImage", ctypes.c_uint32),
        ("biXPelsPerMeter", ctypes.c_int32),
        ("biYPelsPerMeter", ctypes.c_int32),
        ("biClrUsed", ctypes.c_uint32),
        ("biClrImportant", ctypes.c_uint32),
    ]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", ctypes.c_uint32 * 3)]


def png_chunk(tag, data):
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def encode_png(width, height, rgb):
    stride = width * 3
    raw = bytearray((stride + 1) * height)
    for row in range(height):
        target = row * (stride + 1)
        raw[target] = 0
        raw[target + 1 : target + 1 + stride] = rgb[row * stride : (row + 1) * stride]
    compressed = zlib.compress(bytes(raw), 6)
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", header)
        + png_chunk(b"IDAT", compressed)
        + png_chunk(b"IEND", b"")
    )


def capture_screen_png(max_side=1600):
    if not IS_WINDOWS:
        return False, "Только для Windows"

    user32 = ctypes.windll.user32
    gdi32 = ctypes.windll.gdi32
    try:
        user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    except Exception:  # noqa: BLE001
        try:
            user32.SetProcessDPIAware()
        except Exception:  # noqa: BLE001
            pass

    user32.GetDC.restype = ctypes.c_void_p
    user32.GetDC.argtypes = [ctypes.c_void_p]
    user32.ReleaseDC.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    gdi32.CreateCompatibleDC.restype = ctypes.c_void_p
    gdi32.CreateCompatibleDC.argtypes = [ctypes.c_void_p]
    gdi32.CreateCompatibleBitmap.restype = ctypes.c_void_p
    gdi32.CreateCompatibleBitmap.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int]
    gdi32.SelectObject.restype = ctypes.c_void_p
    gdi32.SelectObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    gdi32.BitBlt.argtypes = [
        ctypes.c_void_p,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_void_p,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_uint32,
    ]
    gdi32.StretchBlt.argtypes = [
        ctypes.c_void_p,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_void_p,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_uint32,
    ]
    gdi32.SetStretchBltMode.argtypes = [ctypes.c_void_p, ctypes.c_int]
    gdi32.GetDIBits.argtypes = [
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_uint,
        ctypes.c_uint,
        ctypes.c_void_p,
        ctypes.POINTER(BITMAPINFO),
        ctypes.c_uint,
    ]
    gdi32.DeleteObject.argtypes = [ctypes.c_void_p]
    gdi32.DeleteDC.argtypes = [ctypes.c_void_p]

    vx = user32.GetSystemMetrics(76)
    vy = user32.GetSystemMetrics(77)
    vw = user32.GetSystemMetrics(78)
    vh = user32.GetSystemMetrics(79)
    if vw <= 0 or vh <= 0:
        vx, vy = 0, 0
        vw = user32.GetSystemMetrics(0)
        vh = user32.GetSystemMetrics(1)
    if vw <= 0 or vh <= 0:
        return False, "Не удалось определить размер экрана"

    scale = min(1.0, float(max_side) / float(max(vw, vh)))
    tw = max(1, int(vw * scale))
    th = max(1, int(vh * scale))

    src_dc = user32.GetDC(0)
    mem_dc = gdi32.CreateCompatibleDC(src_dc)
    bmp = gdi32.CreateCompatibleBitmap(src_dc, vw, vh)
    old_bmp = gdi32.SelectObject(mem_dc, bmp)
    gdi32.BitBlt(mem_dc, 0, 0, vw, vh, src_dc, vx, vy, 0x00CC0020)

    target_dc = mem_dc
    target_bmp = bmp
    old_target = old_bmp
    small_dc = None
    small_bmp = None
    if tw != vw or th != vh:
        small_dc = gdi32.CreateCompatibleDC(src_dc)
        small_bmp = gdi32.CreateCompatibleBitmap(src_dc, tw, th)
        old_small = gdi32.SelectObject(small_dc, small_bmp)
        gdi32.SetStretchBltMode(small_dc, 4)  # HALFTONE
        gdi32.StretchBlt(
            small_dc, 0, 0, tw, th, mem_dc, 0, 0, vw, vh, 0x00CC0020
        )
        target_dc = small_dc
        target_bmp = small_bmp
        old_target = old_small

    gdi32.SelectObject(target_dc, old_target)
    info = BITMAPINFO()
    info.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    info.bmiHeader.biWidth = tw
    info.bmiHeader.biHeight = -th
    info.bmiHeader.biPlanes = 1
    info.bmiHeader.biBitCount = 32
    info.bmiHeader.biCompression = 0
    buffer = ctypes.create_string_buffer(tw * th * 4)
    copied = gdi32.GetDIBits(
        target_dc, target_bmp, 0, th, buffer, ctypes.byref(info), 0
    )

    gdi32.DeleteObject(target_bmp)
    if small_dc is not None:
        gdi32.DeleteDC(small_dc)
    gdi32.DeleteObject(bmp)
    gdi32.DeleteDC(mem_dc)
    user32.ReleaseDC(0, src_dc)

    if not copied:
        return False, "GetDIBits не смог прочитать изображение"

    bgra = buffer.raw
    rgb = bytearray(tw * th * 3)
    source = 0
    target = 0
    for _ in range(tw * th):
        rgb[target] = bgra[source + 2]
        rgb[target + 1] = bgra[source + 1]
        rgb[target + 2] = bgra[source]
        source += 4
        target += 3

    data = encode_png(tw, th, rgb)
    log.info("Скриншот создан: %sx%s, %s байт", tw, th, len(data))
    return True, {
        "ok": True,
        "mime": "image/png",
        "size": len(data),
        "dimensions": f"{tw}x{th}",
        "image": base64.b64encode(data).decode("ascii"),
    }


# --------------------------------------------------------------------------
# Каталог программ
# --------------------------------------------------------------------------

SKIP_NAME = re.compile(
    r"^(uninstall|удалить|readme|read me|help|справка|website|сайт|документация|documentation)",
    re.IGNORECASE,
)


def normalize_name(value):
    return re.sub(r"\s+", " ", str(value or "").replace("ё", "е").replace("Ё", "Е")).strip().lower()


def shortcut_roots():
    roots = []
    program_data = os.environ.get("ProgramData", r"C:\ProgramData")
    app_data = os.environ.get("APPDATA", "")
    roots.append(os.path.join(program_data, "Microsoft", "Windows", "Start Menu", "Programs"))
    if app_data:
        roots.append(os.path.join(app_data, "Microsoft", "Windows", "Start Menu", "Programs"))
    return [root for root in roots if root and os.path.isdir(root)]


def collect_shortcuts():
    apps = []
    for root in shortcut_roots():
        for dirpath, _dirnames, filenames in os.walk(root):
            for filename in filenames:
                extension = os.path.splitext(filename)[1].lower()
                if extension not in (".lnk", ".url", ".appref-ms"):
                    continue
                name = os.path.splitext(filename)[0].strip()
                if not name or SKIP_NAME.match(name):
                    continue
                target = os.path.join(dirpath, filename)
                apps.append({"name": name, "kind": "shortcut", "target": target})
    return apps


def start_menu_apps():
    script = (
        "$ErrorActionPreference='SilentlyContinue'; "
        "Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress"
    )
    output, error = run_powershell(script, timeout=20)
    if error or not output:
        return []
    text = output.strip()
    if not text.startswith("["):
        text = "[" + text + "]"
    try:
        data = json.loads(text)
    except ValueError:
        return []
    apps = []
    for item in data:
        if not isinstance(item, dict):
            continue
        name = str(item.get("Name") or "").strip()
        app_id = str(item.get("AppID") or "").strip()
        if not name or not app_id or SKIP_NAME.match(name):
            continue
        apps.append({"name": name, "kind": "uwp", "target": app_id})
    return apps


def build_catalog(force=False):
    now = time.time()
    with CATALOG_LOCK:
        if not force and CATALOG_CACHE["apps"] and now - CATALOG_CACHE["at"] < CATALOG_TTL:
            return CATALOG_CACHE["apps"]

    combined = collect_shortcuts() + start_menu_apps()
    unique = {}
    for app in combined:
        key = normalize_name(app["name"])
        if not key:
            continue
        # UWP-приложения важнее ярлыков с тем же именем.
        if key not in unique or app["kind"] == "uwp":
            app_id = hashlib.sha1(
                (app["kind"] + "|" + app["target"]).encode("utf-8", "ignore")
            ).hexdigest()[:16]
            unique[key] = {
                "id": app_id,
                "name": app["name"],
                "kind": app["kind"],
                "target": app["target"],
            }
    apps = sorted(unique.values(), key=lambda item: normalize_name(item["name"]))
    with CATALOG_LOCK:
        CATALOG_CACHE["apps"] = apps
        CATALOG_CACHE["at"] = now
    log.info("Каталог программ: %s", len(apps))
    return apps


def score_app(name, query):
    normalized = normalize_name(name)
    if not query:
        return 1
    if normalized == query:
        return 100
    if normalized.startswith(query):
        return 80
    if any(word.startswith(query) for word in normalized.split()):
        return 60
    if query in normalized:
        return 40
    # Простой поиск по подпоследовательности: "хром" найдёт "Google Chrome".
    position = 0
    for character in query:
        position = normalized.find(character, position)
        if position < 0:
            return 0
        position += 1
    return 10


def search_apps(query, force=False, limit=60):
    apps = build_catalog(force=force)
    normalized = normalize_name(query)
    if not normalized:
        return apps[:limit]
    scored = []
    for app in apps:
        score = score_app(app["name"], normalized)
        if score > 0:
            scored.append((score, app))
    scored.sort(key=lambda item: (-item[0], normalize_name(item[1]["name"])))
    return [
        {key: app[key] for key in ("id", "name", "kind")}
        for _score, app in scored[:limit]
    ]


def launch_app(app_id):
    apps = build_catalog()
    app = next((item for item in apps if item["id"] == app_id), None)
    if app is None:
        apps = build_catalog(force=True)
        app = next((item for item in apps if item["id"] == app_id), None)
    if app is None:
        return False, "Программа не найдена. Обновите список"
    try:
        if app["kind"] == "uwp":
            subprocess.Popen(
                ["explorer.exe", "shell:AppsFolder\\" + app["target"]],
                close_fds=True,
                creationflags=CREATE_NO_WINDOW,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        else:
            os.startfile(app["target"])
        log.info("Запуск программы: %s (%s)", app["name"], app["kind"])
        return True, "Запускаю: " + app["name"]
    except Exception as error:  # noqa: BLE001
        log.error("Не удалось запустить %s: %s", app["name"], error)
        return False, "Не удалось запустить: " + str(error)


# --------------------------------------------------------------------------
# Bluetooth Audio Receiver (UWP)
# --------------------------------------------------------------------------


def find_bt_app_id():
    for app in build_catalog():
        if normalize_name(app["name"]) == normalize_name(BT_APP_NAME):
            return app["target"]
    return BT_APP_ID_FALLBACK


BT_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class PcRemoteWin32 {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
'@
$action = '__ACTION__'
$appId = '__APPID__'
$windowName = 'Bluetooth Audio Receiver'

function Find-CoreWindow {
  $hwnd = [PcRemoteWin32]::FindWindow('Windows.UI.Core.CoreWindow', $windowName)
  if ($hwnd -eq [IntPtr]::Zero) {
    $hwnd = [PcRemoteWin32]::FindWindow('ApplicationFrameWindow', $windowName)
  }
  return $hwnd
}

$hwnd = Find-CoreWindow
if ($hwnd -eq [IntPtr]::Zero -and $action -ne 'status') {
  Start-Process explorer.exe -ArgumentList ('shell:AppsFolder\' + $appId)
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 400
    $hwnd = Find-CoreWindow
    if ($hwnd -ne [IntPtr]::Zero) { break }
  }
}

if ($hwnd -eq [IntPtr]::Zero) {
  [pscustomobject]@{ ok = $true; running = $false; state = 'Приложение не запущено'; button = ''; enabled = $false } | ConvertTo-Json -Compress
  exit 0
}

$isMinimized = [PcRemoteWin32]::IsIconic($hwnd)
if ($action -eq 'status' -and $isMinimized) {
  [pscustomobject]@{
    ok = $true
    running = $true
    state = 'Свёрнуто'
    minimized = $true
    openEnabled = $true
    closeEnabled = $true
    button = ''
    enabled = $false
  } | ConvertTo-Json -Compress
  exit 0
}

if ($action -ne 'status') {
  [PcRemoteWin32]::ShowWindow($hwnd, 9) | Out-Null
  [PcRemoteWin32]::SetForegroundWindow($hwnd) | Out-Null
  Start-Sleep -Milliseconds 700
}

$win = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
$stateElement = $win.FindFirst(
  [System.Windows.Automation.TreeScope]::Descendants,
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'ConnectionState'))
)
$state = if ($stateElement) { $stateElement.Current.Name } else { '' }

if ($action -eq 'status') {
  $openButton = $win.FindFirst(
    [System.Windows.Automation.TreeScope]::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, '__OPENID__'))
  )
  $closeButton = $win.FindFirst(
    [System.Windows.Automation.TreeScope]::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, '__CLOSEID__'))
  )
  [pscustomobject]@{
    ok = $true
    running = $true
    state = $state
    openEnabled = if ($openButton) { $openButton.Current.IsEnabled } else { $false }
    closeEnabled = if ($closeButton) { $closeButton.Current.IsEnabled } else { $false }
    button = ''
    enabled = $false
  } | ConvertTo-Json -Compress
  exit 0
}

$buttonId = if ($action -eq 'open') { '__OPENID__' } else { '__CLOSEID__' }
$button = $win.FindFirst(
  [System.Windows.Automation.TreeScope]::Descendants,
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $buttonId))
)
if (-not $button) {
  [pscustomobject]@{ ok = $false; running = $true; state = $state; button = ''; enabled = $false; error = 'Кнопка не найдена' } | ConvertTo-Json -Compress
  exit 0
}

$enabled = $button.Current.IsEnabled
$buttonName = $button.Current.Name
if (-not $enabled) {
  [pscustomobject]@{ ok = $false; running = $true; state = $state; button = $buttonName; enabled = $false; error = 'Кнопка недоступна: сначала выберите устройство в приложении' } | ConvertTo-Json -Compress
  exit 0
}

$pattern = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
$pattern.Invoke()
Start-Sleep -Milliseconds 900

$stateElement = $win.FindFirst(
  [System.Windows.Automation.TreeScope]::Descendants,
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'ConnectionState'))
)
$newState = if ($stateElement) { $stateElement.Current.Name } else { $state }
[pscustomobject]@{ ok = $true; running = $true; state = $newState; button = $buttonName; enabled = $true; error = '' } | ConvertTo-Json -Compress
"""


def bluetooth_control(action):
    action = str(action or "status").strip().lower()
    if action not in ("open", "close", "status"):
        return False, "Неизвестное действие Bluetooth"
    script = (
        BT_SCRIPT.replace("__ACTION__", action)
        .replace("__APPID__", find_bt_app_id())
        .replace("__OPENID__", BT_OPEN_BUTTON_ID)
        .replace("__CLOSEID__", BT_CLOSE_BUTTON_ID)
    )
    output, error = run_powershell(script, timeout=30)
    if error:
        return False, "Не удалось управлять Bluetooth-приёмником: " + error
    data = parse_last_json(output)
    if not data:
        return False, "Не удалось разобрать ответ Bluetooth-приёмника"
    if not data.get("ok"):
        return False, data.get("error") or "Команда не выполнена"
    if action == "status":
        return True, data
    state = data.get("state") or ""
    message = "Соединение открыто" if action == "open" else "Соединение закрыто"
    if state:
        message += ": " + state
    return True, {"message": message, "state": state, "running": data.get("running")}


# --------------------------------------------------------------------------
# HTTP-сервер
# --------------------------------------------------------------------------


class SessionHandler(BaseHTTPRequestHandler):
    server_version = "PCRemoteSession/" + APP_VERSION
    sys_version = ""

    def do_GET(self):  # noqa: N802
        self.handle_request("GET")

    def do_POST(self):  # noqa: N802
        self.handle_request("POST")

    def send_json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length > 65536:
            raise ValueError("Слишком большой запрос")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as error:
            raise ValueError("Неверный JSON") from error
        return data if isinstance(data, dict) else {}

    def handle_request(self, method):
        client = self.client_address[0]
        if client not in ("127.0.0.1", "::1"):
            self.send_json(403, {"ok": False, "error": "Только локальный доступ"})
            return

        parsed = urlsplit(self.path)
        path = parsed.path.rstrip("/") or "/"
        query = parse_qs(parsed.query)

        if path == "/health" and method == "GET":
            self.send_json(
                200,
                {
                    "ok": True,
                    "app": "pcremote-session",
                    "version": APP_VERSION,
                    "user": os.environ.get("USERNAME", ""),
                    "session_id": current_session_id(),
                },
            )
            return

        provided = self.headers.get("X-Session-Secret") or ""
        if not hmac.compare_digest(provided, session_secret()):
            self.send_json(401, {"ok": False, "error": "Неверный секрет сессии"})
            return

        try:
            if path == "/volume" and method == "POST":
                data = self.read_json()
                ok, message = send_volume(data.get("steps", 0), bool(data.get("mute")))
                self.send_json(200 if ok else 400, {"ok": ok, "message": message, "error": None if ok else message})
                return

            if path == "/media" and method == "POST":
                data = self.read_json()
                ok, message = send_media(data.get("key"))
                self.send_json(200 if ok else 400, {"ok": ok, "message": message, "error": None if ok else message})
                return

            if path == "/hotkey" and method == "POST":
                data = self.read_json()
                ok, message = send_hotkey(data.get("combo"))
                self.send_json(200 if ok else 400, {"ok": ok, "message": message, "error": None if ok else message})
                return

            if path == "/monitor_off" and method == "POST":
                ok, message = monitor_off()
                self.send_json(200 if ok else 500, {"ok": ok, "message": message, "error": None if ok else message})
                return

            if path == "/monitor_on" and method == "POST":
                ok, message = monitor_on()
                self.send_json(200 if ok else 500, {"ok": ok, "message": message, "error": None if ok else message})
                return

            if path == "/monitor_state" and method == "GET":
                self.send_json(200, {"ok": True, **monitor_state()})
                return

            if path == "/screenshot" and method == "GET":
                ok, result = capture_screen_png()
                if ok:
                    self.send_json(200, result)
                else:
                    self.send_json(500, {"ok": False, "error": result})
                return

            if path == "/apps" and method == "GET":
                query_text = (query.get("q") or [""])[0]
                force = (query.get("refresh") or ["0"])[0] in ("1", "true", "yes")
                apps = search_apps(query_text, force=force)
                self.send_json(200, {"ok": True, "apps": apps, "count": len(apps)})
                return

            if path == "/launch" and method == "POST":
                data = self.read_json()
                ok, message = launch_app(str(data.get("id") or ""))
                self.send_json(200 if ok else 400, {"ok": ok, "message": message, "error": None if ok else message})
                return

            if path == "/bt" and method == "POST":
                data = self.read_json()
                ok, result = bluetooth_control(data.get("action"))
                if ok and isinstance(result, dict):
                    self.send_json(200, {"ok": True, **result})
                elif ok:
                    self.send_json(200, {"ok": True, "message": result})
                else:
                    self.send_json(400, {"ok": False, "error": result})
                return

            self.send_json(404, {"ok": False, "error": "Неизвестная команда"})
        except ValueError as error:
            self.send_json(400, {"ok": False, "error": str(error)})
        except Exception as error:  # noqa: BLE001
            log.exception("Ошибка обработки %s %s", method, path)
            self.send_json(500, {"ok": False, "error": "Внутренняя ошибка: " + str(error)})

    def log_message(self, fmt, *args):
        log.info("%s - %s", self.client_address[0], fmt % args)


def serve():
    global CONFIG
    CONFIG = load_config()
    secret = session_secret()
    if not secret or len(secret) < 32:
        log.error("В config.json нет токена — помощник не запущен")
        return 1
    port = int(CONFIG.get("session_port", DEFAULT_SESSION_PORT))
    log.info(
        "Помощник сессии запускается: user=%s session=%s TCP=%s",
        os.environ.get("USERNAME", ""),
        current_session_id(),
        port,
    )
    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), SessionHandler)
    except OSError as error:
        log.error("Не удалось занять TCP %s: %s", port, error)
        return 1
    server.daemon_threads = True
    log.info("Помощник сессии слушает 127.0.0.1:%s", port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


def main():
    setup_logging()
    if not IS_WINDOWS:
        print("Помощник сессии работает только в Windows", file=sys.stderr)
        return 1
    return serve()


if __name__ == "__main__":
    raise SystemExit(main())
