#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Annihilation Masters — локальный сервер регламента.

Отдаёт страницу и принимает правки из админки. Только стандартная библиотека.

  python server.py                    запустить (пароль создастся при первом запуске)
  python server.py --port 8080        другой порт
  python server.py --set-password     сменить пароль админки
  python server.py --host 127.0.0.1   только с этой машины (без планшета)

API:
  GET  /api/ping      — жив ли сервер
  POST /api/auth      — {"password": "..."} → проверка пароля
  GET  /api/content   — текущий content.json
  PUT  /api/content   — сохранить документ (заголовок X-AM-Pass)
  POST /api/upload    — загрузить картинку (X-AM-Pass, X-File-Name)
  GET  /api/uploads   — список загруженных картинок (X-AM-Pass)
  DELETE /api/uploads?name=…  — удалить картинку (X-AM-Pass)
  GET  /api/history   — список версий страницы (X-AM-Pass)
  GET  /api/history/<файл>    — содержимое версии (X-AM-Pass)
  POST /api/restore   — {"name": "..."} вернуть версию в публикацию (X-AM-Pass)

Каждое сохранение кладёт предыдущую версию в history/ (последние 40).
Картинки лежат в assets/uploads/ — они часть сайта, их видно на странице.
"""
import argparse
import getpass
import hashlib
import hmac
import json
import os
import secrets
import socket
import sys
import time
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

BASE = os.path.dirname(os.path.abspath(__file__))
CONTENT = os.path.join(BASE, "content.json")
CONFIG = os.path.join(BASE, "server.config.json")
HISTORY = os.path.join(BASE, "history")
UPLOADS = os.path.join(BASE, "assets", "uploads")
UPLOAD_URL = "assets/uploads/"

DENY_FILES = {"server.py", "server.config.json", "README.md", ".gitignore"}
BLOCK_TYPES = {"p", "h3", "clauses", "note", "table", "specs", "tags",
               "stages", "podium", "faq", "links", "img"}
ITERATIONS = 210_000
MAX_BODY = 4 * 1024 * 1024
MAX_UPLOAD = 8 * 1024 * 1024
MAX_HISTORY = 40
FAIL_WINDOW = 600
FAIL_LIMIT = 8

# тип файла определяем по содержимому, а не по расширению из браузера
MAGIC = [
    (b"\x89PNG\r\n\x1a\n", "png", "image/png"),
    (b"\xff\xd8\xff", "jpg", "image/jpeg"),
    (b"GIF87a", "gif", "image/gif"),
    (b"GIF89a", "gif", "image/gif"),
]
RIFF = b"RIFF"
WEBP = b"WEBP"
FTYP = b"ftyp"
AVIF = b"avif"
HEIC = b"heic"

FAILS = {}  # ip -> [timestamp, ...]


# ── пароль ───────────────────────────────────────────────────────────────────
def hash_pw(password, salt, iterations=ITERATIONS):
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations).hex()


def load_config():
    try:
        with open(CONFIG, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def save_config(password):
    salt = secrets.token_bytes(16)
    cfg = {
        "algo": "pbkdf2_sha256",
        "iterations": ITERATIONS,
        "salt": salt.hex(),
        "hash": hash_pw(password, salt),
        "created": datetime.now().isoformat(timespec="seconds"),
    }
    with open(CONFIG, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    os.chmod(CONFIG, 0o600)
    return cfg


def check_pw(password, cfg):
    if not cfg:
        return False
    try:
        salt = bytes.fromhex(cfg["salt"])
        iterations = int(cfg.get("iterations", ITERATIONS))
        expected = cfg["hash"]
    except (KeyError, ValueError):
        return False
    got = hash_pw(password or "", salt, iterations)
    return hmac.compare_digest(got, expected)


def new_password():
    words = ["anni", "draft", "boss", "pick", "ban", "arena", "master", "rift"]
    return "-".join(secrets.choice(words) for _ in range(2)) + "-" + str(secrets.randbelow(9000) + 1000)


# ── документ ─────────────────────────────────────────────────────────────────
def validate_doc(doc):
    if not isinstance(doc, dict):
        raise ValueError("документ должен быть объектом")
    if not isinstance(doc.get("meta"), dict):
        raise ValueError("нет блока meta")
    sections = doc.get("sections")
    if not isinstance(sections, list) or not sections:
        raise ValueError("нет ни одного раздела")
    for si, sec in enumerate(sections):
        if not isinstance(sec, dict):
            raise ValueError("раздел %d — не объект" % (si + 1))
        if not isinstance(sec.get("blocks"), list):
            raise ValueError("раздел %d без списка блоков" % (si + 1))
        for block in sec["blocks"]:
            if not isinstance(block, dict):
                raise ValueError("раздел %d: блок — не объект" % (si + 1))
            if block.get("type") not in BLOCK_TYPES:
                raise ValueError("неизвестный тип блока: %r" % (block.get("type"),))
    return doc


def read_content():
    with open(CONTENT, "rb") as f:
        return f.read()


def write_content(raw):
    """Атомарно: временный файл рядом, потом замена. Плюс снимок предыдущей версии."""
    os.makedirs(HISTORY, exist_ok=True)
    if os.path.exists(CONTENT):
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        name = "content-%s.json" % stamp
        n = 2
        while os.path.exists(os.path.join(HISTORY, name)):
            name = "content-%s-%d.json" % (stamp, n)
            n += 1
        try:
            os.replace(CONTENT, os.path.join(HISTORY, name))
        except OSError:
            pass
    tmp = CONTENT + ".tmp"
    with open(tmp, "wb") as f:
        f.write(raw)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, CONTENT)

    snaps = sorted(f for f in os.listdir(HISTORY) if f.startswith("content-"))
    for old in snaps[:-MAX_HISTORY]:
        try:
            os.remove(os.path.join(HISTORY, old))
        except OSError:
            pass


# ── картинки ─────────────────────────────────────────────────────────────────
def sniff(data):
    """(ext, mime) по первым байтам или (None, None)."""
    for magic, ext, mime in MAGIC:
        if data.startswith(magic):
            return ext, mime
    if len(data) > 16 and data.startswith(RIFF) and data[8:12] == WEBP:
        return "webp", "image/webp"
    if len(data) > 16 and data[4:8] == FTYP:
        brand = data[8:12]
        if brand in (AVIF, HEIC):
            return ("avif" if brand == AVIF else "heic"), "image/" + brand.decode()
    return None, None


RU = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e",
    "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "h", "ц": "c", "ч": "ch", "ш": "sh", "щ": "sch", "ъ": "",
    "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
}


def img_size(data):
    """(ширина, высота) по заголовку файла; (0, 0), если не разобрал."""
    try:
        if data[:8] == b"\x89PNG\r\n\x1a\n" and data[12:16] == b"IHDR":
            return (int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big"))
        if data[:6] in (b"GIF87a", b"GIF89a"):
            return (int.from_bytes(data[6:8], "little"), int.from_bytes(data[8:10], "little"))
        if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            chunk = data[12:16]
            if chunk == b"VP8X":
                return (int.from_bytes(data[24:27], "little") + 1,
                        int.from_bytes(data[27:30], "little") + 1)
            if chunk == b"VP8 ":
                return (int.from_bytes(data[26:28], "little") & 0x3FFF,
                        int.from_bytes(data[28:30], "little") & 0x3FFF)
            if chunk == b"VP8L":
                bits = int.from_bytes(data[21:25], "little")
                return ((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1)
        if data[:2] == b"\xff\xd8":
            i = 2
            while i < len(data) - 9:
                if data[i] != 0xFF:
                    i += 1
                    continue
                marker = data[i + 1]
                if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
                    i += 2
                    continue
                length = int.from_bytes(data[i + 2:i + 4], "big")
                if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                    return (int.from_bytes(data[i + 7:i + 9], "big"),
                            int.from_bytes(data[i + 5:i + 7], "big"))
                i += 2 + length
    except (IndexError, ValueError):
        pass
    return 0, 0


def file_size(full):
    try:
        with open(full, "rb") as f:
            return img_size(f.read(65536))
    except OSError:
        return 0, 0


def slug(text):
    keep = []
    for ch in (text or "").lower():
        if ch in RU:
            keep.append(RU[ch])
        elif ch.isalnum() and ch.isascii():
            keep.append(ch)
        elif ch in " -_.":
            keep.append("-")
    out = "".join(keep).strip("-")
    while "--" in out:
        out = out.replace("--", "-")
    return out[:40] or "img"


def upload_path(name):
    return os.path.join(UPLOADS, os.path.basename(name))


def list_uploads():
    if not os.path.isdir(UPLOADS):
        return []
    items = []
    for name in sorted(os.listdir(UPLOADS)):
        if name.startswith("."):
            continue
        full = os.path.join(UPLOADS, name)
        if not os.path.isfile(full):
            continue
        try:
            st = os.stat(full)
        except OSError:
            continue
        w, h = file_size(full)
        items.append({
            "name": name,
            "url": UPLOAD_URL + name,
            "bytes": st.st_size,
            "w": w,
            "h": h,
            "at": datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"),
        })
    items.sort(key=lambda x: x["at"], reverse=True)
    return items


def history_list():
    if not os.path.isdir(HISTORY):
        return []
    items = []
    for name in sorted(os.listdir(HISTORY), reverse=True):
        if not (name.startswith("content-") and name.endswith(".json")):
            continue
        full = os.path.join(HISTORY, name)
        info = {"name": name, "bytes": 0, "at": "", "title": "", "sections": 0}
        try:
            st = os.stat(full)
            info["bytes"] = st.st_size
            info["at"] = datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds")
        except OSError:
            continue
        try:
            with open(full, "r", encoding="utf-8") as f:
                doc = json.load(f)
            info["title"] = (doc.get("meta") or {}).get("title", "")
            info["sections"] = len(doc.get("sections") or [])
        except (OSError, ValueError):
            pass
        items.append(info)
    return items


# ── HTTP ─────────────────────────────────────────────────────────────────────
class Handler(SimpleHTTPRequestHandler):
    server_version = "AM-Reglament/1.0"
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE, **kwargs)

    # логирование: только ошибки, без простыни на каждый файл
    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def fail(self, status, message):
        self.send_json({"ok": False, "error": message}, status)

    def blocked(self, path):
        name = os.path.basename(path)
        return name.startswith(".") or name in DENY_FILES or path.startswith("/history/")

    # ── GET ──────────────────────────────────────────────────────────────────
    def do_GET(self):
        path = unquote(self.path.split("?")[0])
        if path == "/api/ping":
            return self.send_json({"ok": True, "hasContent": os.path.exists(CONTENT)})
        if path == "/api/content":
            if not os.path.exists(CONTENT):
                return self.fail(404, "content.json не найден")
            raw = read_content()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            return self.wfile.write(raw)
        if path == "/api/uploads":
            if not self.authorized():
                return self.fail(401, "нужен пароль администратора")
            return self.send_json({"ok": True, "items": list_uploads()})
        if path == "/api/history":
            if not self.authorized():
                return self.fail(401, "нужен пароль администратора")
            return self.send_json({"ok": True, "items": history_list()})
        if path.startswith("/api/history/"):
            if not self.authorized():
                return self.fail(401, "нужен пароль администратора")
            name = os.path.basename(path[len("/api/history/"):])
            full = os.path.join(HISTORY, name)
            if not (name.startswith("content-") and name.endswith(".json")) or not os.path.isfile(full):
                return self.fail(404, "такой версии нет")
            with open(full, "rb") as f:
                raw = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            return self.wfile.write(raw)
        if path.startswith("/api/"):
            return self.fail(404, "неизвестный метод API")
        if self.blocked(path):
            self.send_response(404)
            self.send_header("Content-Length", "0")
            return self.end_headers()
        if path == "/":
            self.path = "/index.html"
        return super().do_GET()

    # ── POST ─────────────────────────────────────────────────────────────────
    def do_POST(self):
        path = unquote(self.path.split("?")[0])
        if path == "/api/auth":
            return self.api_auth()
        if path == "/api/upload":
            return self.api_upload()
        if path == "/api/restore":
            return self.api_restore()
        return self.fail(404, "неизвестный метод API")

    def do_DELETE(self):
        path = unquote(self.path.split("?")[0])
        if path != "/api/uploads":
            return self.fail(404, "неизвестный метод API")
        if not self.authorized():
            return self.fail(401, "нужен пароль администратора")
        query = self.path.split("?")[1] if "?" in self.path else ""
        name = ""
        for part in query.split("&"):
            if part.startswith("name="):
                name = unquote(part[5:])
        name = os.path.basename(name)
        full = upload_path(name)
        if not name or not os.path.isfile(full):
            return self.fail(404, "такой картинки нет")
        try:
            os.remove(full)
        except OSError as e:
            return self.fail(500, "не смог удалить: %s" % e)
        return self.send_json({"ok": True})

    def authorized(self):
        return check_pw(self.headers.get("X-AM-Pass", ""), load_config())

    # ── POST /api/auth ───────────────────────────────────────────────────────
    def api_auth(self):
        ip = self.client_address[0]
        now = time.time()
        fails = [t for t in FAILS.get(ip, []) if now - t < FAIL_WINDOW]
        if len(fails) >= FAIL_LIMIT:
            return self.fail(429, "слишком много попыток — подождите пару минут")

        body = self.read_body()
        if body is None:
            return
        try:
            data = json.loads(body or b"{}")
        except ValueError:
            return self.fail(400, "битый JSON")
        if not isinstance(data, dict):
            return self.fail(400, "ожидался объект")

        if check_pw(str(data.get("password", "")), load_config()):
            FAILS.pop(ip, None)
            return self.send_json({"ok": True})
        FAILS.setdefault(ip, []).append(now)
        time.sleep(0.4)
        return self.fail(401, "Пароль не подошёл")

    # ── POST /api/upload ─────────────────────────────────────────────────────
    def api_upload(self):
        if not self.authorized():
            return self.fail(401, "нужен пароль администратора")
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self.fail(411, "нужен Content-Length")
        if not length:
            return self.fail(400, "пустой файл")
        if length > MAX_UPLOAD:
            return self.fail(413, "файл больше %d МБ" % (MAX_UPLOAD // (1024 * 1024)))
        try:
            data = self.rfile.read(length)
        except OSError:
            return self.fail(400, "не смог прочитать файл")

        ext, mime = sniff(data)
        if not ext:
            return self.fail(415, "это не картинка (png, jpg, webp, gif)")

        raw_name = unquote(self.headers.get("X-File-Name", ""))
        base = os.path.splitext(os.path.basename(raw_name))[0]
        os.makedirs(UPLOADS, exist_ok=True)
        name = "%s-%s.%s" % (datetime.now().strftime("%Y%m%d"), slug(base), ext)
        n = 2
        while os.path.exists(upload_path(name)):
            name = "%s-%s-%d.%s" % (datetime.now().strftime("%Y%m%d"), slug(base), n, ext)
            n += 1
        try:
            with open(upload_path(name), "wb") as f:
                f.write(data)
        except OSError as e:
            return self.fail(500, "не смог сохранить: %s" % e)
        w, h = img_size(data)
        return self.send_json({
            "ok": True, "name": name, "url": UPLOAD_URL + name,
            "bytes": len(data), "mime": mime, "w": w, "h": h,
        })

    # ── POST /api/restore ────────────────────────────────────────────────────
    def api_restore(self):
        if not self.authorized():
            return self.fail(401, "нужен пароль администратора")
        body = self.read_body()
        if body is None:
            return
        try:
            data = json.loads(body or b"{}")
        except ValueError:
            return self.fail(400, "битый JSON")
        name = os.path.basename(str(data.get("name", "")))
        full = os.path.join(HISTORY, name)
        if not (name.startswith("content-") and name.endswith(".json")) or not os.path.isfile(full):
            return self.fail(404, "такой версии нет")
        with open(full, "rb") as f:
            raw = f.read()
        try:
            doc = json.loads(raw.decode("utf-8"))
            validate_doc(doc)
        except (ValueError, UnicodeDecodeError) as e:
            return self.fail(400, "версия повреждена: %s" % e)
        try:
            write_content(json.dumps(doc, ensure_ascii=False, indent=2).encode("utf-8"))
        except OSError as e:
            return self.fail(500, "не смог записать: %s" % e)
        return self.send_json({
            "ok": True, "restored": name,
            "savedAt": datetime.now().isoformat(timespec="seconds"),
        })

    # ── PUT /api/content ─────────────────────────────────────────────────────
    def do_PUT(self):
        path = unquote(self.path.split("?")[0])
        if path != "/api/content":
            return self.fail(404, "неизвестный метод API")
        if not check_pw(self.headers.get("X-AM-Pass", ""), load_config()):
            return self.fail(401, "нужен пароль администратора")

        body = self.read_body()
        if body is None:
            return
        try:
            doc = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as e:
            return self.fail(400, "битый JSON: %s" % e)
        try:
            validate_doc(doc)
        except ValueError as e:
            return self.fail(400, str(e))

        raw = json.dumps(doc, ensure_ascii=False, indent=2).encode("utf-8")
        try:
            write_content(raw)
        except OSError as e:
            return self.fail(500, "не смог записать файл: %s" % e)

        self.send_json({
            "ok": True,
            "bytes": len(raw),
            "savedAt": datetime.now().isoformat(timespec="seconds"),
        })

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Allow", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ── общее ────────────────────────────────────────────────────────────────
    def read_body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self.fail(411, "нужен Content-Length")
            return None
        if length > MAX_BODY:
            self.fail(413, "слишком большой документ")
            return None
        try:
            return self.rfile.read(length) if length else b""
        except OSError:
            self.fail(400, "не смог прочитать тело запроса")
            return None


# ── запуск ───────────────────────────────────────────────────────────────────
def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.4)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return None


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    except (AttributeError, ValueError):
        pass

    ap = argparse.ArgumentParser(description="Сервер регламента Annihilation Masters")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--set-password", action="store_true", help="сменить пароль админки")
    args = ap.parse_args()

    if args.set_password:
        first = getpass.getpass("Новый пароль админки: ").strip()
        if len(first) < 5:
            print("Слишком короткий пароль — нужно минимум 5 символов.")
            return 1
        if first != getpass.getpass("Повторите: ").strip():
            print("Пароли не совпали.")
            return 1
        save_config(first)
        print("Пароль обновлён: %s" % CONFIG)
        return 0

    if not os.path.exists(CONTENT):
        print("Рядом нет content.json — серверу нечего отдавать.")
        return 1

    cfg = load_config()
    if not cfg:
        pw = new_password()
        save_config(pw)
        print("┌──────────────────────────────────────────────┐")
        print("  Пароль админки создан:  %s" % pw)
        print("  Запомните его. Сменить: python server.py --set-password")
        print("└──────────────────────────────────────────────┘")
        print()

    host = args.host
    try:
        httpd = ThreadingHTTPServer((host, args.port), Handler)
    except OSError as e:
        print("Не смог занять порт %d: %s" % (args.port, e))
        return 1

    print("Регламент запущен:")
    print("  страница  http://127.0.0.1:%d/" % args.port)
    print("  редактор  http://127.0.0.1:%d/admin.html" % args.port)
    if host == "0.0.0.0":
        ip = lan_ip()
        if ip:
            print("  планшет   http://%s:%d/admin.html  (та же сеть Wi-Fi)" % (ip, args.port))
    print("  файл      %s" % CONTENT)
    print("Остановить — Ctrl+C")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nОстановлено.")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())