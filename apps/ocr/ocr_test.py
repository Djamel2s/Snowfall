"""Tests du service OCR, lancés DANS l'image (tesseract et poppler requis).

  docker run --rm --network none --tmpfs /work -v "$PWD/apps/ocr:/t:ro" snowfall-ocr python3 -I /t/ocr_test.py
"""

import os
import sys
import zlib

sys.path.insert(0, "/opt/ocr")
import server  # noqa: E402


def pdf_with_text(text):
    """PDF minimal d'une page ; rendu en image par pdftoppm, il joue le rôle d'un scan."""
    stream = f"BT /F1 36 Tf 72 700 Td ({text}) Tj ET".encode("latin-1")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = b"%PDF-1.4\n"
    offsets = []
    for index, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % index + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    out += b"".join(b"%010d 00000 n \n" % offset for offset in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    return out


def check(name, condition):
    print(("ok   " if condition else "ÉCHEC ") + name, flush=True)
    return condition


def main():
    os.makedirs(server.WORK_ROOT, exist_ok=True)
    results = []
    uid = server.RUNNER_UIDS[0]

    found = server.recognize(pdf_with_text("Facture 4512 Snowfall"), "application/pdf", uid)
    results.append(check("PDF numérisé : texte reconnu", "4512" in found["text"] and "Snowfall" in found["text"]))
    results.append(check("dossier de travail effacé", os.listdir(server.WORK_ROOT) == []))

    # Fichier piégé : PDF tronqué / corrompu → erreur propre, rien ne reste.
    try:
        outcome = server.recognize(b"%PDF-1.4\n" + zlib.compress(os.urandom(2000)), "application/pdf", uid)["text"] == ""
    except RuntimeError:
        outcome = True
    results.append(check("PDF corrompu : refus ou texte vide, rien ne reste", outcome and os.listdir(server.WORK_ROOT) == []))

    # Le type annoncé doit correspondre au contenu.
    results.append(check("signature vérifiée (PNG annoncé, PDF reçu)", not server.MAGIC["image/png"](b"%PDF-1.4")))

    # Les outils tournent sous l'utilisateur de lecture, jamais root.
    workdir = os.path.join(server.WORK_ROOT, "probe")
    os.makedirs(workdir, mode=0o700)
    os.chown(workdir, uid, uid)
    who = server.run_tool(["/usr/bin/id", "-u"], 5, uid, workdir).decode().strip()
    results.append(check("exécution sous un utilisateur dédié", who == str(uid)))
    env = server.run_tool(["/usr/bin/env"], 5, uid, workdir).decode()
    results.append(check("environnement nettoyé", "OCR_SOCKET" not in env and "PYTHON" not in env))
    try:
        server.run_tool(["/bin/sh", "-c", "sleep 30"], 1, uid, workdir)
        stopped = False
    except TimeoutError:
        stopped = True
    results.append(check("délai : processus tué", stopped))
    os.rmdir(workdir)

    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main()
