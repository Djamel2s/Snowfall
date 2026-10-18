"""Reconnaissance de texte (OCR) locale pour Snowfall.

Les documents numérisés (PDF sans couche texte, images) sont lus ici, sans
jamais quitter l'infrastructure : aucun service tiers, aucun réseau.

Le conteneur n'a AUCUN réseau (network_mode: none) : l'API lui parle par un
socket Unix sur un volume partagé, réservé à son groupe. Tesseract et Poppler
analysent des fichiers non fiables ; chaque lecture :

- tourne sous un utilisateur dédié, non privilégié, distinct de ce serveur ;
- dans un dossier neuf (tmpfs), effacé ensuite ;
- avec des limites : temps CPU, mémoire, processus, taille des fichiers ;
- bornée en pages, en résolution et en durée totale ;
- sans variables d'environnement héritées.

Bibliothèque standard uniquement : rien à installer pour le serveur lui-même.
"""

import grp
import json
import os
import resource
import shutil
import signal
import socketserver
import subprocess
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler

SOCKET_PATH = os.environ.get("OCR_SOCKET", "/run/ocr/ocr.sock")
SOCKET_GROUP = os.environ.get("OCR_SOCKET_GROUP", "ocrapi")
WORK_ROOT = os.environ.get("OCR_WORK", "/work")
RUNNER_UIDS = [int(uid) for uid in os.environ.get("OCR_RUNNER_UIDS", "10101,10102").split(",")]
LANGUAGES = os.environ.get("OCR_LANGUAGES", "fra+eng")

MAX_BYTES = 25 * 1024 * 1024
MAX_PAGES = 30
# Plus grand côté d'une page rendue (pixels) : borne la mémoire de Tesseract.
MAX_SIDE = 2480
PAGE_SECONDS = 30
TOTAL_SECONDS = 180
MAX_CHARS = 400_000
MEMORY_BYTES = 1024 * 1024 * 1024

MEDIA_TYPES = {
    "application/pdf": ".pdf",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
}
# Signatures : le type annoncé doit correspondre au contenu.
MAGIC = {
    "application/pdf": lambda data: data.startswith(b"%PDF-"),
    "image/png": lambda data: data.startswith(b"\x89PNG\r\n\x1a\n"),
    "image/jpeg": lambda data: data.startswith(b"\xff\xd8\xff"),
    "image/webp": lambda data: data[:4] == b"RIFF" and data[8:12] == b"WEBP",
}

FREE = list(RUNNER_UIDS)
FREE_LOCK = threading.Lock()


def take_slot():
    with FREE_LOCK:
        return FREE.pop() if FREE else None


def release_slot(uid):
    with FREE_LOCK:
        FREE.append(uid)


def kill_user(uid):
    """Tue tous les processus d'un utilisateur de lecture (lecture de /proc)."""
    for _ in range(5):
        found = False
        for entry in os.listdir("/proc"):
            if not entry.isdigit():
                continue
            try:
                with open(f"/proc/{entry}/status", encoding="ascii", errors="replace") as handle:
                    owner = next((line.split()[1] for line in handle if line.startswith("Uid:")), None)
            except OSError:
                continue
            if owner == str(uid):
                found = True
                try:
                    os.kill(int(entry), signal.SIGKILL)
                except ProcessLookupError:
                    pass
        if not found:
            return
        time.sleep(0.05)


def limits(seconds, uid, workdir):
    def apply():
        os.setsid()
        resource.setrlimit(resource.RLIMIT_CPU, (seconds, seconds + 1))
        resource.setrlimit(resource.RLIMIT_AS, (MEMORY_BYTES, MEMORY_BYTES))
        resource.setrlimit(resource.RLIMIT_NPROC, (32, 32))
        resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024 * 1024, 64 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        os.setgroups([])
        os.setgid(uid)
        os.setuid(uid)
        os.umask(0o077)
        os.chdir(workdir)

    return apply


def clean_env(workdir):
    return {
        "PATH": "/usr/bin:/bin",
        "HOME": workdir,
        "TMPDIR": workdir,
        "LANG": "C.UTF-8",
        # Un seul fil par lecture : la charge reste prévisible.
        "OMP_THREAD_LIMIT": "1",
    }


def run_tool(args, seconds, uid, workdir):
    """Lance un outil sous l'utilisateur de l'emplacement ; tué au-delà du délai."""
    process = subprocess.Popen(
        args,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env=clean_env(workdir),
        preexec_fn=limits(seconds, uid, workdir),
        close_fds=True,
    )
    try:
        out, _ = process.communicate(timeout=seconds + 2)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.communicate()
        raise TimeoutError("tool_timeout")
    finally:
        kill_user(uid)
    if process.returncode != 0:
        raise RuntimeError("tool_failed")
    return out


def recognize(data, media_type, uid):
    workdir = os.path.join(WORK_ROOT, uuid.uuid4().hex)
    os.makedirs(workdir, mode=0o700)
    os.chown(workdir, uid, uid)
    started = time.monotonic()
    try:
        source = os.path.join(workdir, "source" + MEDIA_TYPES[media_type])
        with open(source, "wb") as handle:
            handle.write(data)
        os.chown(source, uid, uid)

        if media_type == "application/pdf":
            # Pages rendues en niveaux de gris, côté le plus long borné.
            run_tool(
                ["pdftoppm", "-gray", "-png", "-r", "200", "-scale-to", str(MAX_SIDE), "-f", "1", "-l", str(MAX_PAGES), source, "page"],
                90,
                uid,
                workdir,
            )
            pages = sorted(name for name in os.listdir(workdir) if name.startswith("page") and name.endswith(".png"))
        else:
            pages = [os.path.basename(source)]

        texts = []
        for page in pages[:MAX_PAGES]:
            remaining = TOTAL_SECONDS - (time.monotonic() - started)
            if remaining < 5:
                break
            out = run_tool(["tesseract", page, "stdout", "-l", LANGUAGES, "--psm", "3"], int(min(PAGE_SECONDS, remaining)), uid, workdir)
            texts.append(out.decode("utf-8", errors="replace").replace("\x00", "").strip())
            if sum(len(text) for text in texts) > MAX_CHARS:
                break
        text = "\n\n".join(text for text in texts if text)[:MAX_CHARS]
        return {"text": text, "pages": len(texts)}
    finally:
        kill_user(uid)
        shutil.rmtree(workdir, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "snowfall-ocr"
    sys_version = ""

    def reply(self, status, body):
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self.reply(200, {"status": "ok"})
        return self.reply(404, {"error": "not_found"})

    def do_POST(self):
        if self.path != "/ocr":
            return self.reply(404, {"error": "not_found"})
        media_type = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if media_type not in MEDIA_TYPES:
            return self.reply(415, {"error": "unsupported"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.reply(400, {"error": "invalid_request"})
        if length <= 0 or length > MAX_BYTES:
            return self.reply(413, {"error": "too_large"})
        data = self.rfile.read(length)
        if len(data) != length or not MAGIC[media_type](data):
            return self.reply(400, {"error": "invalid_request"})
        uid = take_slot()
        if uid is None:
            return self.reply(429, {"error": "busy"})
        try:
            return self.reply(200, recognize(data, media_type, uid))
        except TimeoutError:
            return self.reply(504, {"error": "timeout"})
        except Exception as error:  # noqa: BLE001 - le détail reste dans le journal du conteneur
            print(f"Échec de lecture : {type(error).__name__}", flush=True)
            return self.reply(422, {"error": "unreadable"})
        finally:
            release_slot(uid)

    def log_message(self, format, *args):
        # Journal minimal : jamais le contenu lu.
        print(f"{self.command} {self.path} {args[1] if len(args) > 1 else ''}", flush=True)


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def main():
    os.makedirs(os.path.dirname(SOCKET_PATH), exist_ok=True)
    if os.path.exists(SOCKET_PATH):
        os.unlink(SOCKET_PATH)
    server = Server(SOCKET_PATH, Handler)
    os.chown(SOCKET_PATH, 0, grp.getgrnam(SOCKET_GROUP).gr_gid)
    os.chmod(SOCKET_PATH, 0o660)
    print(f"OCR prêt sur {SOCKET_PATH} (langues : {LANGUAGES})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
