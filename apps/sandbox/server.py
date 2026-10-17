"""Bac à sable d'exécution de code pour les agents Snowfall.

Le conteneur n'a AUCUN réseau (network_mode: none) : l'API lui parle par un
socket Unix sur un volume partagé, réservé à un groupe dont le code exécuté ne
fait pas partie. Chaque exécution :

- tourne sous un utilisateur dédié, non privilégié, distinct de ce serveur ;
- dans un dossier neuf (tmpfs), effacé ensuite ;
- avec des limites : temps CPU, mémoire, processus, taille et nombre de fichiers ;
- tuée avec tout son groupe de processus au-delà du délai ;
- sans variables d'environnement héritées (aucun secret à voler).

Bibliothèque standard uniquement : rien à installer pour le serveur lui-même.
"""

import base64
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

SOCKET_PATH = os.environ.get("SANDBOX_SOCKET", "/run/sandbox/sandbox.sock")
SOCKET_GROUP = os.environ.get("SANDBOX_SOCKET_GROUP", "sandboxapi")
WORK_ROOT = os.environ.get("SANDBOX_WORK", "/work")
# Un utilisateur par emplacement d'exécution : à la fin, TOUS ses processus sont
# tués (même un processus qui s'est détaché de son groupe avec setsid).
RUNNER_UIDS = [int(uid) for uid in os.environ.get("SANDBOX_RUNNER_UIDS", "10001,10002").split(",")]

MAX_CODE_CHARS = 50_000
MAX_SECONDS = 60
OUTPUT_CHARS = 20_000
MAX_FILES = 8
MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_TOTAL_BYTES = 12 * 1024 * 1024
MEMORY_BYTES = 1536 * 1024 * 1024

# Fichiers rendus à l'utilisateur : types connus seulement, jamais d'exécutable.
MEDIA_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".csv": "text/csv",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pdf": "application/pdf",
}

# gVisor (runtime « runsc ») intercepte les appels système : le code exécuté ne
# parle jamais directement au noyau de l'hôte. Son noyau simulé se reconnaît à
# une version fixe. En production, le serveur refuse de démarrer sans lui.
GVISOR_KERNEL = "#1 SMP Sun Jan 10 15:06:54 PST 2016"
REQUIRE_GVISOR = os.environ.get("SANDBOX_REQUIRE_GVISOR", "false").lower() == "true"


def isolation():
    try:
        with open("/proc/version", encoding="ascii", errors="replace") as handle:
            return "gvisor" if GVISOR_KERNEL in handle.read() else "native"
    except OSError:
        return "native"


# Emplacements libres (un utilisateur chacun) ; tous pris : refus immédiat.
FREE = list(RUNNER_UIDS)
FREE_LOCK = threading.Lock()


def take_slot():
    with FREE_LOCK:
        return FREE.pop() if FREE else None


def release_slot(uid):
    with FREE_LOCK:
        FREE.append(uid)


def kill_user(uid):
    """Tue tous les processus d'un utilisateur d'exécution (lecture de /proc)."""
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


def limits(seconds, uid, workdir=None):
    """Appelé dans le processus enfant, avant exec : il devient l'utilisateur de l'emplacement."""

    def apply():
        os.setsid()
        resource.setrlimit(resource.RLIMIT_CPU, (seconds, seconds + 1))
        resource.setrlimit(resource.RLIMIT_AS, (MEMORY_BYTES, MEMORY_BYTES))
        resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))
        resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_FILE_BYTES * 2, MAX_FILE_BYTES * 2))
        resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        os.setgroups([])
        os.setgid(uid)
        os.setuid(uid)
        # Tout fichier créé est privé : rien n'est lisible d'une exécution à l'autre.
        os.umask(0o077)
        # Après le changement d'utilisateur : le dossier n'est ouvert qu'à lui.
        if workdir:
            os.chdir(workdir)

    return apply


def clean_env(workdir):
    # Environnement minimal : aucune variable du conteneur (ni secret, ni configuration).
    return {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": workdir,
        # Fichiers temporaires dans le dossier de l'exécution (/tmp est fermé aux exécutions).
        "TMPDIR": workdir,
        "LANG": "C.UTF-8",
        "MPLBACKEND": "Agg",
        "MPLCONFIGDIR": os.path.join(workdir, ".matplotlib"),
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONUNBUFFERED": "1",
        "OPENBLAS_NUM_THREADS": "1",
        "OMP_NUM_THREADS": "1",
        "MKL_NUM_THREADS": "1",
    }


# Relecture des résultats par l'utilisateur de l'emplacement lui-même (les fichiers
# sont privés) : sorties bornées et fichiers autorisés, en JSON sur sa sortie standard.
COLLECTOR = r"""
import base64, json, os, sys
workdir, chars, max_files, max_file, max_total = sys.argv[1], *map(int, sys.argv[2:6])
types = json.loads(sys.argv[6])
def text(name):
    try:
        with open(os.path.join(workdir, name), "rb") as handle:
            data = handle.read(chars * 4)
    except OSError:
        return ""
    value = data.decode("utf-8", errors="replace")
    return value if len(value) <= chars else value[:chars] + "\n[… sortie tronquée]"
files, total = [], 0
for entry in sorted(os.scandir(workdir), key=lambda item: item.name):
    if len(files) >= max_files:
        break
    # Ni lien symbolique (fichier hors du dossier), ni fichier caché, ni fichiers internes.
    if entry.name.startswith(".") or entry.name in ("main.py", "stdout.txt", "stderr.txt"):
        continue
    if entry.is_symlink() or not entry.is_file(follow_symlinks=False):
        continue
    media = types.get(os.path.splitext(entry.name)[1].lower())
    size = entry.stat(follow_symlinks=False).st_size
    if not media or size == 0 or size > max_file or total + size > max_total:
        continue
    with open(entry.path, "rb") as handle:
        data = handle.read(max_file + 1)
    total += len(data)
    files.append({"name": entry.name[:120], "mediaType": media, "size": len(data), "data": base64.b64encode(data).decode("ascii")})
json.dump({"stdout": text("stdout.txt"), "stderr": text("stderr.txt"), "files": files}, sys.stdout)
"""


def collect(workdir, uid):
    result = subprocess.run(
        ["python3", "-I", "-c", COLLECTOR, workdir, str(OUTPUT_CHARS), str(MAX_FILES), str(MAX_FILE_BYTES), str(MAX_TOTAL_BYTES), json.dumps(MEDIA_TYPES)],
        preexec_fn=limits(20, uid),
        env={"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"},
        capture_output=True,
        timeout=30,
        check=False,
    )
    try:
        return json.loads(result.stdout)
    except ValueError:
        return {"stdout": "", "stderr": "", "files": []}

def remove_as_runner(workdir, uid):
    # Le serveur n'a pas le droit de passer outre les permissions : l'utilisateur
    # de l'emplacement vide son dossier, puis le serveur retire le dossier vide.
    subprocess.run(["find", workdir, "-mindepth", "1", "-delete"], preexec_fn=limits(10, uid), env={"PATH": "/usr/bin:/bin"}, timeout=20, check=False)
    try:
        os.rmdir(workdir)
    except OSError:
        shutil.rmtree(workdir, ignore_errors=True)


def run(code, seconds, uid):
    workdir = os.path.join(WORK_ROOT, uuid.uuid4().hex)
    os.mkdir(workdir, 0o700)
    # Fichiers internes privés eux aussi.
    os.umask(0o077)
    started = time.monotonic()
    timed_out = False
    try:
        # Fichiers préparés AVANT de céder le dossier : ensuite, ce serveur n'a
        # plus le droit d'y écrire (pas de contournement des permissions).
        with open(os.path.join(workdir, "main.py"), "w", encoding="utf-8") as handle:
            handle.write(code)
        stdout = open(os.path.join(workdir, "stdout.txt"), "wb")
        stderr = open(os.path.join(workdir, "stderr.txt"), "wb")
        for path in ("main.py", "stdout.txt", "stderr.txt"):
            os.chown(os.path.join(workdir, path), uid, uid)
        # Dossier cédé à l'utilisateur de l'emplacement, fermé à tous les autres
        # (ce serveur compris : il relit les résultats par collect()).
        os.chown(workdir, uid, uid)
        process = subprocess.Popen(
            ["python3", "-I", "-X", "utf8", os.path.join(workdir, "main.py")],
            env=clean_env(workdir),
            stdin=subprocess.DEVNULL,
            stdout=stdout,
            stderr=stderr,
            preexec_fn=limits(seconds, uid, workdir),
            close_fds=True,
        )
        try:
            exit_code = process.wait(timeout=seconds + 2)
        except subprocess.TimeoutExpired:
            timed_out = True
            exit_code = -9
        finally:
            # Tout ce que l'exécution a lancé, même détaché : rien ne survit.
            kill_user(uid)
            process.wait()
            stdout.close()
            stderr.close()
        kill_user(uid)
        return {
            "exitCode": exit_code,
            "timedOut": timed_out,
            "durationMs": int((time.monotonic() - started) * 1000),
            **collect(workdir, uid),
        }
    finally:
        kill_user(uid)
        remove_as_runner(workdir, uid)
        kill_user(uid)


class Handler(BaseHTTPRequestHandler):
    server_version = "snowfall-sandbox"
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
            return self.reply(200, {"status": "ok", "isolation": ISOLATION})
        return self.reply(404, {"error": "not_found"})

    def do_POST(self):
        if self.path != "/run":
            return self.reply(404, {"error": "not_found"})
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_CODE_CHARS * 4:
            return self.reply(413, {"error": "too_large"})
        try:
            body = json.loads(self.rfile.read(length))
            code = body["code"]
            seconds = int(body.get("timeoutSeconds", 30))
        except (ValueError, KeyError, TypeError):
            return self.reply(400, {"error": "invalid_request"})
        if not isinstance(code, str) or not code.strip() or len(code) > MAX_CODE_CHARS:
            return self.reply(400, {"error": "invalid_request"})
        uid = take_slot()
        if uid is None:
            return self.reply(429, {"error": "busy"})
        try:
            return self.reply(200, run(code, max(1, min(seconds, MAX_SECONDS)), uid))
        except Exception as error:  # noqa: BLE001 - le détail reste dans le journal du conteneur
            print(f"Échec d'exécution : {type(error).__name__}", flush=True)
            return self.reply(500, {"error": "internal"})
        finally:
            release_slot(uid)

    def log_message(self, format, *args):
        # Journal minimal : jamais le code ni ses sorties.
        print(f"{self.command} {self.path} {args[1] if len(args) > 1 else ''}", flush=True)


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


ISOLATION = isolation()


def main():
    if REQUIRE_GVISOR and ISOLATION != "gvisor":
        print("Refus de démarrer : gVisor exigé (SANDBOX_REQUIRE_GVISOR=true) mais absent. Lancer le conteneur avec le runtime runsc.", flush=True)
        raise SystemExit(1)
    os.makedirs(os.path.dirname(SOCKET_PATH), exist_ok=True)
    if os.path.exists(SOCKET_PATH):
        os.unlink(SOCKET_PATH)
    server = Server(SOCKET_PATH, Handler)
    # Socket réservé au groupe de l'API : le code exécuté (autre utilisateur) ne peut pas s'y connecter.
    os.chown(SOCKET_PATH, 0, grp.getgrnam(SOCKET_GROUP).gr_gid)
    os.chmod(SOCKET_PATH, 0o660)
    print(f"Bac à sable prêt sur {SOCKET_PATH} (isolation : {ISOLATION})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
