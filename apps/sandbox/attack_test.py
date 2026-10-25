"""Batterie d'attaques contre le bac à sable : chaque ligne doit rester « bloqué ».

Lancée contre le VRAI conteneur, durci comme en production (voir
scripts/sandbox-attack.sh et la CI). Elle parle au serveur par son socket Unix,
comme l'API, et envoie du code hostile. Code de sortie 1 si une attaque passe.

    python3 attack_test.py /run/sandbox/sandbox.sock
"""

import base64
import http.client
import json
import socket
import sys

SOCKET = sys.argv[1] if len(sys.argv) > 1 else "/run/sandbox/sandbox.sock"


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__("sandbox", timeout=120)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(120)
        self.sock.connect(self.path)


def call(method, path, body=None):
    connection = UnixConnection(SOCKET)
    payload = json.dumps(body).encode() if body is not None else None
    connection.request(method, path, body=payload, headers={"Content-Type": "application/json"} if payload else {})
    response = connection.getresponse()
    data = json.loads(response.read() or b"{}")
    connection.close()
    return response.status, data


def run(code, seconds=10):
    status, data = call("POST", "/run", {"code": code, "timeoutSeconds": seconds})
    if status != 200:
        raise RuntimeError(f"HTTP {status} {data}")
    return data


results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))


# ---- Fonctionnement normal ---------------------------------------------------------
health = call("GET", "/health")[1]
out = run(
    "import pandas as pd, matplotlib.pyplot as plt\n"
    "df = pd.DataFrame({'mois': [1, 2, 3], 'loyer': [310, 322, 330]})\n"
    "print(round(df.loyer.mean(), 2))\n"
    "df.plot(x='mois', y='loyer'); plt.savefig('loyer.png')\n"
    "df.to_csv('loyer.csv', index=False)\n"
)
check("calcul et graphique", out["stdout"].strip() == "320.67" and sorted(f["name"] for f in out["files"]) == ["loyer.csv", "loyer.png"], out["stdout"][:80])

# ---- Réseau ------------------------------------------------------------------------
out = run(
    "import socket\n"
    "for target in [('1.1.1.1', 80), ('8.8.8.8', 53)]:\n"
    "    try:\n"
    "        socket.create_connection(target, timeout=2); print('OUVERT', target)\n"
    "    except OSError as e: print('bloqué', type(e).__name__)\n"
    "try:\n"
    "    socket.getaddrinfo('example.com', 443); print('DNS OUVERT')\n"
    "except OSError as e: print('dns bloqué')\n"
)
check("réseau Internet et DNS", "OUVERT" not in out["stdout"], out["stdout"].strip().replace("\n", " | "))

# ---- Identité, environnement, secrets ---------------------------------------------
out = run("import os, json\nprint(json.dumps({'uid': os.getuid(), 'gid': os.getgid(), 'groups': os.getgroups(), 'env': sorted(os.environ)}))")
identity = json.loads(out["stdout"])
expected_env = {"PATH", "HOME", "TMPDIR", "LANG", "MPLBACKEND", "MPLCONFIGDIR", "PYTHONDONTWRITEBYTECODE", "PYTHONUNBUFFERED", "OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS", "LC_CTYPE"}
check("utilisateur dédié, sans groupe", identity["uid"] in (10001, 10002) and identity["groups"] == [], str(identity["uid"]))
check("environnement minimal (aucun secret)", set(identity["env"]) <= expected_env, ",".join(sorted(set(identity["env"]) - expected_env)))

out = run("try:\n    open('/etc/shadow').read(); print('LU')\nexcept OSError as e: print('refusé')")
check("lecture de /etc/shadow", "LU" not in out["stdout"], out["stdout"].strip())

# ---- Socket de l'API ------------------------------------------------------------------
out = run(
    "import socket\n"
    "s = socket.socket(socket.AF_UNIX)\n"
    "try:\n"
    "    s.connect('/run/sandbox/sandbox.sock'); print('CONNECTÉ')\n"
    "except OSError as e: print('refusé', type(e).__name__)\n"
)
check("socket de l'API (lancer d'autres exécutions)", "CONNECTÉ" not in out["stdout"], out["stdout"].strip())

# ---- Écriture hors du dossier ---------------------------------------------------------
out = run(
    "import os\n"
    "for path in ['/x', '/etc/x', '/opt/sandbox/x', '/tmp/x', '/dev/shm/x', '/usr/local/lib/x', '/work/x']:\n"
    "    try:\n"
    "        open(path, 'w').write('x'); print('ÉCRIT', path)\n"
    "    except OSError: pass\n"
    "print('fin')\n"
)
check("écriture hors du dossier", "ÉCRIT" not in out["stdout"], out["stdout"].strip().replace("\n", " "))

out = run("import os\ntry:\n    print('LISTE', os.listdir('/work'))\nexcept OSError: print('refusé')")
check("lister les autres exécutions (/work)", "LISTE" not in out["stdout"], out["stdout"].strip())

# ---- Ressources ----------------------------------------------------------------------
out = run("try:\n    x = bytearray(4 * 1024**3); print('ALLOUÉ')\nexcept MemoryError: print('MemoryError')", 15)
check("bombe mémoire", "ALLOUÉ" not in out["stdout"], out["stdout"].strip() or out["stderr"][-80:])

out = run(
    "import os, time\n"
    "n = 0\n"
    "try:\n"
    "    for _ in range(500):\n"
    "        if os.fork() == 0:\n"
    "            time.sleep(30); os._exit(0)\n"
    "        n += 1\n"
    "except OSError: pass\n"
    "print(n)\n",
    10,
)
forks = int((out["stdout"].strip() or "0").splitlines()[-1])
check("bombe de processus", forks < 100, f"{forks} processus")

out = run("while True: pass", 3)
check("boucle infinie coupée", out["timedOut"] or out["exitCode"] != 0, f"{out['durationMs']} ms")
check("boucle infinie : délai respecté", out["durationMs"] < 8_000, f"{out['durationMs']} ms")

# ---- Survie et fuite entre exécutions ----------------------------------------------
run(
    "import os, time\n"
    "if os.fork() == 0:\n"
    "    os.setsid()\n"
    "    if os.fork() == 0:\n"
    "        time.sleep(120); os._exit(0)\n"
    "    os._exit(0)\n"
    "open(os.path.join(os.environ['HOME'], 'secret.txt'), 'w').write('donnée de la victime')\n"
    "print(os.environ['HOME'])\n"
)
out = run(
    "import os\n"
    "alive = []\n"
    "for pid in os.listdir('/proc'):\n"
    "    if pid.isdigit():\n"
    "        try:\n"
    "            uid = [l.split()[1] for l in open(f'/proc/{pid}/status') if l.startswith('Uid:')][0]\n"
    "            if uid in ('10001', '10002') and int(pid) != os.getpid() and int(pid) != os.getppid(): alive.append(pid)\n"
    "        except OSError: pass\n"
    "print(len(alive))\n"
)
check("processus détaché tué à la fin", out["stdout"].strip() in ("0", ""), out["stdout"].strip() + " restant(s)")

out = run(
    "import glob\n"
    "found = [p for p in glob.glob('/work/*/secret.txt') + glob.glob('/tmp/*') + glob.glob('/dev/shm/*')]\n"
    "print('FUITE' if found else 'rien')\n"
)
check("fuite vers l'exécution suivante", "FUITE" not in out["stdout"], out["stdout"].strip())

out = run("import os\nos.symlink('/etc/passwd', 'passwd.txt')\nos.symlink('/etc/shadow', 'shadow.csv')\nprint('liens créés')")
check("lien symbolique vers un fichier du système", out["files"] == [], ",".join(f["name"] for f in out["files"]))

# ---- Scripts d'une compétence ---------------------------------------------------------
def run_skill(files, entry, args=(), seconds=10):
    return call("POST", "/run", {"files": files, "entry": entry, "args": list(args), "timeoutSeconds": seconds})


skill_files = [
    {"path": "scripts/fill.py", "content": "import sys, helpers\nprint(helpers.title(sys.argv[1:]))\nopen('note.md', 'w').write(open(helpers.HERE + '/../references/plan.md').read())\n"},
    {"path": "scripts/helpers.py", "content": "import os\nHERE = os.path.dirname(os.path.abspath(__file__))\ndef title(args): return ' | '.join(args)\n"},
    {"path": "references/plan.md", "content": "# Plan\nI. Faits\n"},
]
status, out = run_skill(skill_files, "scripts/fill.py", ["Dossier Orion", "; touch PWNED", "$(id)"])
check(
    "compétence : script, module voisin, référence, arguments",
    status == 200 and out["stdout"].strip() == "Dossier Orion | ; touch PWNED | $(id)" and [f["name"] for f in out["files"]] == ["note.md"],
    f"{status} {out.get('stdout', '')[:60]!r} {[f['name'] for f in out.get('files', [])]}",
)

status, out = run_skill(skill_files + [{"path": "scripts/probe.py", "content": "import os\nprint('PWNED' if os.path.exists('PWNED') else 'rien')\nprint(sorted(os.listdir('.')))\n"}], "scripts/probe.py")
check("compétence : arguments jamais passés à un shell", status == 200 and out["stdout"].startswith("rien"), out.get("stdout", "")[:80])

bad_paths = ["../evil.py", "/etc/evil.py", "scripts/../../evil.py", ".hidden.py", "scripts//evil.py", "scripts/.git/x.py", "a/b/c/d/e/f.py", "évil.py", "C:\\evil.py"]
accepted = []
for path in bad_paths:
    status, _ = run_skill([{"path": path, "content": "print('x')"}], path)
    if status != 400:
        accepted.append(path)
check("compétence : chemins piégés refusés", not accepted, ", ".join(accepted))

status, _ = run_skill([{"path": "a.py", "content": "print(1)"}], "b.py")
check("compétence : script absent des fichiers refusé", status == 400, str(status))
status, _ = run_skill([{"path": "a.py", "content": "print(1)"}, {"path": "a.py/b.py", "content": "print(2)"}], "a.py")
check("compétence : fichier et dossier de même nom refusés", status == 400, str(status))
status, _ = run_skill([{"path": "a.py", "content": "x" * (3 * 1024 * 1024)}], "a.py")
check("compétence : fichiers trop gros refusés", status in (400, 413), str(status))
status, _ = run_skill([{"path": "a.py", "content": "print(1)"}], "a.py", ["x"] * 50)
check("compétence : trop d'arguments refusés", status == 400, str(status))

status, out = run_skill([{"path": "net.py", "content": "import socket\ntry:\n    socket.create_connection(('1.1.1.1', 80), timeout=2); print('OUVERT')\nexcept OSError: print('bloqué')\n"}], "net.py")
check("compétence : réseau fermé aussi", status == 200 and "OUVERT" not in out["stdout"], out.get("stdout", "").strip())

# ---- Rapport -------------------------------------------------------------------------
print(f"Isolation : {health.get('isolation', '?')}")
width = max(len(name) for name, _, _ in results)
for name, ok, detail in results:
    print(f"{'✓' if ok else '✗'} {name.ljust(width)}  {detail}")
failed = [name for name, ok, _ in results if not ok]
if failed:
    print(f"\n{len(failed)} attaque(s) NON bloquée(s) : {', '.join(failed)}")
    sys.exit(1)
print(f"\n{len(results)} contrôles : tout est bloqué.")
