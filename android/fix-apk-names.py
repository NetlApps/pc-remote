#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Нормализует пути внутри APK: обратные слеши заменяются на прямые.

aapt2 в Windows иногда записывает в local file header имена с '\\',
из-за чего AssetManager не может открыть assets. Длина имени не меняется,
поэтому файл можно править на месте, не ломая выравнивание.
"""

from __future__ import annotations

import struct
import sys

EOCD_SIG = b"PK\x05\x06"
CENTRAL_SIG = b"PK\x01\x02"
LOCAL_SIG = b"PK\x03\x04"


def parse_names(data: bytes):
    eocd = data.rfind(EOCD_SIG)
    if eocd < 0:
        raise ValueError("не найден EOCD")
    total = struct.unpack_from("<H", data, eocd + 10)[0]
    central_offset = struct.unpack_from("<I", data, eocd + 16)[0]
    pos = central_offset
    entries = []
    for _ in range(total):
        if data[pos : pos + 4] != CENTRAL_SIG:
            raise ValueError(f"повреждён central directory на смещении {pos}")
        name_len = struct.unpack_from("<H", data, pos + 28)[0]
        extra_len = struct.unpack_from("<H", data, pos + 30)[0]
        comment_len = struct.unpack_from("<H", data, pos + 32)[0]
        local_offset = struct.unpack_from("<I", data, pos + 42)[0]
        central_name = data[pos + 46 : pos + 46 + name_len]
        if data[local_offset : local_offset + 4] != LOCAL_SIG:
            raise ValueError(f"повреждён local header на смещении {local_offset}")
        local_name_len = struct.unpack_from("<H", data, local_offset + 26)[0]
        local_name = data[local_offset + 30 : local_offset + 30 + local_name_len]
        entries.append((pos + 46, central_name, local_offset + 30, local_name))
        pos += 46 + name_len + extra_len + comment_len
    return entries


def patch(path: str) -> int:
    with open(path, "rb") as handle:
        data = handle.read()
    entries = parse_names(data)
    fixed_central = 0
    fixed_local = 0
    with open(path, "r+b") as handle:
        for central_pos, central_name, local_pos, local_name in entries:
            if b"\\" in central_name:
                handle.seek(central_pos)
                handle.write(central_name.replace(b"\\", b"/"))
                fixed_central += 1
            if b"\\" in local_name:
                handle.seek(local_pos)
                handle.write(local_name.replace(b"\\", b"/"))
                fixed_local += 1
    with open(path, "rb") as handle:
        check = handle.read()
    bad = [
        (central, local)
        for _, central, _, local in parse_names(check)
        if b"\\" in central or b"\\" in local
    ]
    if bad:
        print(f"остались обратные слеши: {bad[:5]}", file=sys.stderr)
        return 1
    print(f"пути APK нормализованы: local={fixed_local}, central={fixed_central}")
    return 0


def main() -> int:
    if len(sys.argv) != 2:
        print("использование: fix-apk-names.py <apk>", file=sys.stderr)
        return 2
    try:
        return patch(sys.argv[1])
    except (OSError, ValueError) as error:
        print(f"ошибка: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
