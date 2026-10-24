# -*- coding: utf-8 -*-
"""Pet Health Tracker - EvanHome 家用宠物健康纪录 App.

纯 Python 标准库 + SQLite,零外部依赖。
启动: python server.py  (预设 port 8790,可用环境变量 PET_PORT 覆盖)
"""
import json
import os
import re
import sqlite3
import sys
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs, unquote

BASE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE, "data")
PHOTO_ROOT = os.path.join(DATA_DIR, "photos")
DB_PATH = os.path.join(DATA_DIR, "pet.db")
PORT = int(os.environ.get("PET_PORT", "8790"))

SAFE_NAME = re.compile(r"^[A-Za-z0-9._-]{1,80}$")
UNSAFE_CHARS = re.compile(r"[^A-Za-z0-9._-]+")
ALLOWED_EXT = {"jpg", "jpeg", "png", "webp", "gif"}
CTYPES = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
          "webp": "image/webp", "gif": "image/gif"}
MAX_PHOTO_BYTES = 20 * 1024 * 1024


def now_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M")


def db():
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=8000")
    return conn


def init_db():
    os.makedirs(PHOTO_ROOT, exist_ok=True)
    conn = db()
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS pets(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        species TEXT DEFAULT 'other',
        birthday TEXT DEFAULT '',
        unit TEXT DEFAULT 'kg',
        note TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS logs(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pet_id INTEGER NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        weight REAL,
        food TEXT DEFAULT '',
        poop TEXT DEFAULT '',
        temp REAL,
        note TEXT DEFAULT '',
        dt TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS medical(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pet_id INTEGER NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        date TEXT DEFAULT '',
        next_date TEXT DEFAULT '',
        done INTEGER DEFAULT 0,
        note TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS photos(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pet_id INTEGER NOT NULL,
        log_id INTEGER,
        med_id INTEGER,
        filename TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_logs_pet ON logs(pet_id, dt);
    CREATE INDEX IF NOT EXISTS idx_med_pet ON medical(pet_id);
    CREATE INDEX IF NOT EXISTS idx_photos_log ON photos(log_id);
    CREATE INDEX IF NOT EXISTS idx_photos_med ON photos(med_id);
    """)
    conn.commit()
    conn.close()


def rows_to_list(rows):
    return [dict(r) for r in rows]


class Handler(BaseHTTPRequestHandler):
    server_version = "PetHealth/1.0"

    # ---------- helpers ----------
    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

    def send_json(self, obj, code=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        pairs = parse_qs(raw.decode("utf-8"))
        return {k: v[0] for k, v in pairs.items()}

    def read_json_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw.decode("utf-8") or "{}")
        except ValueError:
            return {}

    def to_float(self, s):
        s = (s or "").strip()
        if not s:
            return None
        try:
            return float(s)
        except ValueError:
            return None

    def to_int_list(self, s):
        out = []
        for part in re.split(r"[,\s]+", (s or "")):
            if part.isdigit():
                out.append(int(part))
        return out

    # ---------- routes ----------
    def do_GET(self):
        parts = urlsplit(self.path)
        path = parts.path
        q = {k: v[0] for k, v in parse_qs(parts.query).items()}
        conn = db()
        try:
            if path == "/api/pets":
                return self.send_json(rows_to_list(
                    conn.execute("SELECT * FROM pets ORDER BY id")))
            m = re.match(r"^/api/pets/(\d+)/logs$", path)
            if m:
                return self.send_json({
                    "logs": rows_to_list(conn.execute(
                        "SELECT * FROM logs WHERE pet_id=? ORDER BY dt DESC, id DESC LIMIT 500",
                        (int(m.group(1)),))),
                    "medical": rows_to_list(conn.execute(
                        "SELECT * FROM medical WHERE pet_id=? ORDER BY COALESCE(next_date,'9999'), date DESC, id DESC",
                        (int(m.group(1)),))),
                    "photos": rows_to_list(conn.execute(
                        "SELECT id,pet_id,log_id,med_id,filename FROM photos WHERE pet_id=?",
                        (int(m.group(1)),))),
                })
            m = re.match(r"^/photos/(\d+)/(\d+)$", path)
            if m:
                pet_id, ph_id = int(m.group(1)), int(m.group(2))
                row = conn.execute(
                    "SELECT filename FROM photos WHERE id=? AND pet_id=?",
                    (ph_id, pet_id)).fetchone()
                if not row:
                    return self.send_json({"error": "not found"}, 404)
                fpath = os.path.join(PHOTO_ROOT, row["filename"])
                if not os.path.isfile(fpath):
                    return self.send_json({"error": "file missing"}, 404)
                ext = row["filename"].rsplit(".", 1)[-1].lower()
                ctype = CTYPES.get(ext, "application/octet-stream")
                with open(fpath, "rb") as f:
                    data = f.read()
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "public, max-age=86400")
                self.end_headers()
                self.wfile.write(data)
                return
            return self.send_json({"error": "no such api"}, 404)
        finally:
            conn.close()

    def do_POST(self):
        parts = urlsplit(self.path)
        path = parts.path
        conn = db()
        try:
            if path == "/api/pets":
                b = self.read_body()
                name = (b.get("name") or "").strip()
                if not name:
                    return self.send_json({"error": "name required"}, 400)
                cur = conn.execute(
                    "INSERT INTO pets(name,species,birthday,unit,note) VALUES(?,?,?,?,?)",
                    (name, b.get("species") or "other", b.get("birthday") or "",
                     b.get("unit") or "kg", b.get("note") or ""))
                conn.commit()
                row = conn.execute("SELECT * FROM pets WHERE id=?", (cur.lastrowid,)).fetchone()
                return self.send_json(dict(row))

            m = re.match(r"^/api/pets/(\d+)/logs$", path)
            if m:
                pet_id = int(m.group(1))
                b = self.read_body()
                kind = b.get("kind") or "note"
                dt = (b.get("date") or "") + " " + (b.get("time") or "")
                dt = dt.strip() or now_str()
                cur = conn.execute(
                    "INSERT INTO logs(pet_id,kind,weight,food,poop,temp,note,dt) VALUES(?,?,?,?,?,?,?,?)",
                    (pet_id, kind, self.to_float(b.get("weight")),
                     b.get("food") or "", b.get("poop") or "",
                     self.to_float(b.get("temp")), b.get("note") or "", dt))
                conn.commit()
                # 把刚上传的待用照片挂到这笔纪录
                ids = self.to_int_list(b.get("photo_ids"))
                for pid in ids:
                    self.attach_photo(conn, pid, pet_id, "log", cur.lastrowid)
                row = conn.execute("SELECT * FROM logs WHERE id=?", (cur.lastrowid,)).fetchone()
                return self.send_json(dict(row))

            m = re.match(r"^/api/pets/(\d+)/medical$", path)
            if m:
                pet_id = int(m.group(1))
                b = self.read_body()
                title = (b.get("title") or "").strip()
                if not title:
                    return self.send_json({"error": "title required"}, 400)
                cur = conn.execute(
                    "INSERT INTO medical(pet_id,type,title,date,next_date,done,note) VALUES(?,?,?,?,?,?,?)",
                    (pet_id, b.get("type") or "other", title,
                     b.get("date") or "", b.get("next_date") or "",
                     1 if b.get("done") == "1" else 0, b.get("note") or ""))
                conn.commit()
                ids = self.to_int_list(b.get("photo_ids"))
                for pid in ids:
                    self.attach_photo(conn, pid, pet_id, "med", cur.lastrowid)
                row = conn.execute("SELECT * FROM medical WHERE id=?", (cur.lastrowid,)).fetchone()
                return self.send_json(dict(row))

            return self.send_json({"error": "no such api"}, 404)
        finally:
            conn.close()

    def attach_photo(self, conn, photo_id, pet_id, owner_kind, owner_id):
        row = conn.execute("SELECT filename FROM photos WHERE id=? AND pet_id=?",
                           (photo_id, pet_id)).fetchone()
        if not row:
            return
        old = row["filename"]
        sub = "log-%d" % owner_id if owner_kind == "log" else "med-%d" % owner_id
        petdir = "p%d" % pet_id
        newname = os.path.join(petdir, sub, os.path.basename(old))
        src = os.path.join(PHOTO_ROOT, old)
        dst = os.path.join(PHOTO_ROOT, newname)
        if not os.path.isfile(src):
            conn.execute("DELETE FROM photos WHERE id=?", (photo_id,))
            conn.commit()
            return
        try:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            os.replace(src, dst)
            conn.execute("UPDATE photos SET filename=?, %s_id=? WHERE id=?" % owner_kind,
                         (newname, owner_id, photo_id))
            conn.commit()
        except OSError:
            pass

    def do_PUT(self):
        parts = urlsplit(self.path)
        if parts.path != "/api/upload":
            return self.send_json({"error": "no such api"}, 404)
        q = {k: v[0] for k, v in parse_qs(parts.query).items()}
        pet_id = int(q.get("pet", "0"))
        fname = unquote(q.get("name", ""))
        base = os.path.basename(fname).replace(" ", "_")
        stem, _, ext = base.rpartition(".")
        ext = ext.lower()
        if ext not in ALLOWED_EXT or not SAFE_NAME.match(base):
            return self.send_json({"error": "bad filename"}, 400)
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_PHOTO_BYTES:
            return self.send_json({"error": "bad size"}, 413)
        data = self.rfile.read(length)
        pending = os.path.join(PHOTO_ROOT, "pending")
        os.makedirs(pending, exist_ok=True)
        unique = datetime.now().strftime("%Y%m%d%H%M%S%f")
        rel = os.path.join("pending", "%s_%s.%s" % (unique, UNSAFE_CHARS.sub("_", stem)[:40], ext))
        with open(os.path.join(PHOTO_ROOT, rel), "wb") as f:
            f.write(data)
        conn = db()
        try:
            cur = conn.execute("INSERT INTO photos(pet_id,filename) VALUES(?,?)", (pet_id, rel))
            conn.commit()
            return self.send_json({"id": cur.lastrowid})
        finally:
            conn.close()

    def do_PATCH(self):
        parts = urlsplit(self.path)
        path = parts.path
        body = self.read_json_body()
        conn = db()
        try:
            m = re.match(r"^/api/pets/(\d+)$", path)
            if m:
                pet_id = int(m.group(1))
                cols, vals = [], []
                for k in ("name", "species", "birthday", "unit", "note"):
                    if k in body:
                        cols.append(k + "=?")
                        vals.append(body[k])
                if cols:
                    vals.append(pet_id)
                    conn.execute("UPDATE pets SET %s WHERE id=?" % ",".join(cols), vals)
                    conn.commit()
                return self.send_json({"ok": True})
            m = re.match(r"^/api/medical/(\d+)$", path)
            if m:
                med_id = int(m.group(1))
                cols, vals = [], []
                for k in ("type", "title", "date", "next_date", "note"):
                    if k in body:
                        cols.append(k + "=?")
                        vals.append(body[k])
                if "done" in body:
                    cols.append("done=?")
                    vals.append(1 if body["done"] else 0)
                if cols:
                    vals.append(med_id)
                    conn.execute("UPDATE medical SET %s WHERE id=?" % ",".join(cols), vals)
                    conn.commit()
                return self.send_json({"ok": True})
            return self.send_json({"error": "no such api"}, 404)
        finally:
            conn.close()

    def do_DELETE(self):
        parts = urlsplit(self.path)
        path = parts.path
        conn = db()
        try:
            m = re.match(r"^/api/logs/(\d+)$", path)
            if m:
                log_id = int(m.group(1))
                self.delete_photos_for(conn, "log_id", log_id)
                conn.execute("DELETE FROM logs WHERE id=?", (log_id,))
                conn.commit()
                return self.send_json({"ok": True})
            m = re.match(r"^/api/medical/(\d+)$", path)
            if m:
                med_id = int(m.group(1))
                self.delete_photos_for(conn, "med_id", med_id)
                conn.execute("DELETE FROM medical WHERE id=?", (med_id,))
                conn.commit()
                return self.send_json({"ok": True})
            m = re.match(r"^/api/pets/(\d+)$", path)
            if m:
                pet_id = int(m.group(1))
                for r in conn.execute("SELECT filename FROM photos WHERE pet_id=?", (pet_id,)):
                    fp = os.path.join(PHOTO_ROOT, r["filename"])
                    if os.path.isfile(fp):
                        try:
                            os.remove(fp)
                        except OSError:
                            pass
                conn.execute("DELETE FROM photos WHERE pet_id=?", (pet_id,))
                conn.execute("DELETE FROM logs WHERE pet_id=?", (pet_id,))
                conn.execute("DELETE FROM medical WHERE pet_id=?", (pet_id,))
                conn.execute("DELETE FROM pets WHERE id=?", (pet_id,))
                conn.commit()
                return self.send_json({"ok": True})
            return self.send_json({"error": "no such api"}, 404)
        finally:
            conn.close()

    def delete_photos_for(self, conn, col, owner_id):
        for r in conn.execute("SELECT filename FROM photos WHERE %s=?" % col, (owner_id,)):
            fp = os.path.join(PHOTO_ROOT, r["filename"])
            if os.path.isfile(fp):
                try:
                    os.remove(fp)
                except OSError:
                    pass
        conn.execute("DELETE FROM photos WHERE %s=?" % col, (owner_id,))

    # ---------- static ----------
    def serve_static(self):
        path = urlsplit(self.path).path
        if path == "/":
            path = "/index.html"
        fpath = os.path.normpath(os.path.join(BASE, "static", path.lstrip("/")))
        if not fpath.startswith(os.path.join(BASE, "static")) or not os.path.isfile(fpath):
            self.send_json({"error": "not found"}, 404)
            return
        ext = fpath.rsplit(".", 1)[-1].lower()
        ctypes = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
                  ".js": "application/javascript; charset=utf-8", ".png": "image/png",
                  ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8"}
        ctype = ctypes.get("." + ext, "application/octet-stream")
        with open(fpath, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)


class PetHandler(Handler):
    def do_GET(self):
        path = urlsplit(self.path).path
        if path.startswith("/api") or path.startswith("/photos"):
            return Handler.do_GET(self)
        return self.serve_static()


def main():
    init_db()
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), PetHandler)
    print("Pet Health Tracker listening on http://0.0.0.0:%d" % PORT)
    sys.stdout.flush()
    httpd.serve_forever()


if __name__ == "__main__":
    main()
