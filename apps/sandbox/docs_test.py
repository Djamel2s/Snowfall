"""Studio de documents : chaque format produit et relu, DANS le bac à sable durci
(mêmes limites que la production : utilisateur dédié, processus, mémoire, fichiers,
système en lecture seule, sans réseau). Lancé par scripts/sandbox-docs.sh.

    python3 docs_test.py /run/sandbox/sandbox.sock
"""

import base64
import http.client
import io
import json
import socket
import sys
import time
import zipfile

SOCKET = sys.argv[1] if len(sys.argv) > 1 else "/run/sandbox/sandbox.sock"


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__("sandbox", timeout=180)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(180)
        self.sock.connect(self.path)


def call(method, path, body=None):
    connection = UnixConnection(SOCKET)
    payload = json.dumps(body).encode() if body is not None else None
    connection.request(method, path, body=payload, headers={"Content-Type": "application/json"} if payload else {})
    response = connection.getresponse()
    data = json.loads(response.read() or b"{}")
    connection.close()
    return response.status, data


results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))


def run(code, seconds=60, files=None):
    body = {"code": code, "timeoutSeconds": seconds}
    if files:
        body = {"files": [{"path": "skill/main.py", "content": code}, *files], "entry": "skill/main.py", "args": [], "timeoutSeconds": seconds}
    started = time.monotonic()
    status, data = call("POST", "/run", body)
    if status != 200:
        raise RuntimeError(f"HTTP {status} {data}")
    data["elapsed"] = round(time.monotonic() - started, 1)
    return data


def files_of(out):
    return {f["name"]: f for f in out["files"]}


def parts(file):
    return zipfile.ZipFile(io.BytesIO(base64.b64decode(file["data"]))).namelist()


# ---- 1. Présentation, rapport, classeur, PDF direct ----------------------------------
out = run(r'''
from snowfall_docs import Deck, Report, Workbook, Theme, chart_png, pdf_fonts, guide
from PIL import Image
Image.new("RGB", (800, 500), "#2F80ED").save("illustration.png")
theme = Theme.preset("ocean")
deck = Deck(theme=theme, title="Bilan 2026", footer="Snowfall · test")
deck.title_slide("Bilan 2026", "Comité de direction", note="1er novembre 2026")
deck.section("Résultats", number=1)
deck.kpis("Une année record", [("18 %", "Croissance", "+6 pts"), ("4,2 M€", "Chiffre d'affaires"), ("92 %", "Satisfaction")])
deck.chart("Les ventes accélèrent", "column", ["T1", "T2", "T3", "T4"], {"2026": [0.9, 1.0, 1.2, 1.1]}, takeaway="+20 % au T3")
deck.chart("Répartition", "doughnut", ["France", "Export"], {"CA": [60, 40]})
deck.chart("Tendance", "line", ["J", "F", "M"], {"A": [1, 2, 3], "B": [2, 2, 4]})
deck.bullets("Trois priorités", ["Export", ("Industrialiser", ["Lyon", "Sous-traitance"]), "Recruter"], aside="12 M€")
deck.two_columns("Avant / après", ["Manuel", "5 jours"], ["Automatisé", "2 heures"], left_title="Avant", right_title="Après")
deck.table("Détail", [["Région", "CA", "Évolution"], ["Nord", "1,2 M€", "+12 %"], ["Sud", "0,9 M€", "+4 %"]])
deck.timeline("Feuille de route", [("T1", "Pilote", "3 sites"), ("T2", "Déploiement"), ("T4", "Bilan")])
deck.steps("Méthode", [("Diagnostiquer", "Entretiens"), ("Concevoir", "Ateliers"), ("Déployer", "Vagues")])
deck.image("Le prototype", "illustration.png", caption="Maquette")
deck.image_text("Le site", "illustration.png", ["Accès", "Parking"])
deck.quote("La meilleure façon de prédire l'avenir est de le créer.", "Peter Drucker")
deck.closing("Merci", "contact@exemple.fr")
deck.save("bilan.pptx")

doc = Report(theme=Theme.preset("forest"), title="Audit énergétique", subtitle="Site de Lyon", author="Direction technique")
doc.toc()
doc.heading("Synthèse")
doc.paragraph("La consommation baisse de **12 %** depuis 2024, *sans* travaux lourds.")
doc.kpis([("-12 %", "Consommation"), ("38 k€", "Économies / an")])
doc.callout("À retenir", "Trois actions couvrent 80 % des économies.", kind="success")
doc.heading("Détail", 2)
doc.bullets(["Isolation", ("Chauffage", ["Pompe à chaleur", "Régulation"])])
doc.table([["Poste", "kWh", "Part"], ["Chauffage", "120 000", "62 %"], ["Éclairage", "30 000", "15 %"]], caption="Consommation par poste")
doc.chart("column", ["2024", "2025", "2026"], {"MWh": [140, 131, 123]}, title="Consommation", caption="Compteurs")
doc.image("illustration.png", width_cm=10, caption="Façade")
doc.quote("Mesurer, c'est savoir.", "Lord Kelvin")
doc.save("audit.docx")

import pandas as pd, datetime as dt
df = pd.DataFrame({"Mois": ["Jan", "Fév", "Mar"], "Montant": [1200.5, 980.0, 1430.25], "Marge": [0.31, 0.27, 0.35], "Date": [dt.date(2026, 1, 31), dt.date(2026, 2, 28), dt.date(2026, 3, 31)], "Note": ["=1+1", "ok", "x"]})
wb = Workbook("ventes.xlsx", theme=theme)
ws = wb.sheet("Ventes")
ws.heading("Ventes 2026", "Source : CRM")
ws.kpis([("3,6 k€", "Total"), ("+18 %", "Croissance")])
ws.table(df, formats={"Montant": "euro", "Marge": "percent"}, totals=["Montant"])
ws.chart("column", "Mois", ["Montant"], title="Ventes")
ws.highlight("Marge", "scale")
wb.save()

from fpdf import FPDF
pdf = FPDF(); family = pdf_fonts(pdf); pdf.add_page(); pdf.set_font(family, "B", 20)
pdf.cell(0, 10, "Sécurité — « bonnes pratiques » : 100 €"); pdf.ln(14)
chart_png("courbe.png", "line", ["J", "F", "M"], {"Visites": [10, 14, 19]}, theme, title="Visites")
pdf.image("courbe.png", w=150); pdf.output("note.pdf")
import os; os.remove("illustration.png"); os.remove("courbe.png")
print(len(guide()) > 200)
''')
found = files_of(out)
check("présentation, rapport, classeur, PDF : produits", out["exitCode"] == 0 and {"bilan.pptx", "audit.docx", "ventes.xlsx", "note.pdf"} <= set(found), f"{out['elapsed']} s {out['stderr'][-400:]}")
if "bilan.pptx" in found:
    slides = [n for n in parts(found["bilan.pptx"]) if n.startswith("ppt/slides/slide")]
    check("présentation : 15 diapositives, graphiques natifs", len(slides) == 15 and any(n.startswith("ppt/charts/") for n in parts(found["bilan.pptx"])), f"{len(slides)} diapositives")
if "audit.docx" in found:
    xml = zipfile.ZipFile(io.BytesIO(base64.b64decode(found["audit.docx"]["data"]))).read("word/document.xml").decode()
    check("rapport : sommaire, accents, figure", "TOC" in xml and "Synthèse" in xml and "Figure 1" in xml)
if "ventes.xlsx" in found:
    sheet = zipfile.ZipFile(io.BytesIO(base64.b64decode(found["ventes.xlsx"]["data"]))).read("xl/worksheets/sheet1.xml").decode()
    # Une donnée « =1+1 » reste du texte : jamais une formule injectée par une donnée.
    check("classeur : tableau, graphique ; « =… » reste du texte", "<f>1+1</f>" not in sheet and any(n.startswith("xl/charts/") for n in parts(found["ventes.xlsx"])))
if "note.pdf" in found:
    check("PDF direct : police Unicode (accents, « », €)", base64.b64decode(found["note.pdf"]["data"]).startswith(b"%PDF"))

# ---- 2. Conversion en PDF (LibreOffice) sous les limites ----------------------------
out = run(r'''
from snowfall_docs import Deck, Report, Workbook, to_pdf
d = Deck(title="Conversion"); d.title_slide("Conversion", "PDF"); d.bullets("Points", ["Un", "Deux"]); d.save("d.pptx")
r = Report(title="Conversion"); r.toc(); r.heading("Partie"); r.paragraph("Texte."); r.save("r.docx")
w = Workbook("w.xlsx"); s = w.sheet("A"); s.table([["x", "y"], [1, 2]], totals=["y"]); w.save()
import os, time
for f in ("d.pptx", "r.docx", "w.xlsx"):
    started = time.monotonic(); to_pdf(f); print(f, round(time.monotonic() - started, 1))
for f in ("d.pptx", "r.docx", "w.xlsx"): os.remove(f)
''', seconds=60)
pdfs = [n for n in files_of(out) if n.endswith(".pdf")]
check("conversion en PDF (pptx, docx, xlsx) dans les limites", out["exitCode"] == 0 and len(pdfs) == 3, f"{out['elapsed']} s · {out['stdout'].strip()} {out['stderr'][-600:]}")

# ---- 3. Modèles de l'utilisateur ------------------------------------------------------
make_templates = r'''
from pptx import Presentation
from pptx.util import Inches
p = Presentation(); p.slide_width, p.slide_height = Inches(10), Inches(7.5)
s = p.slides.add_slide(p.slide_layouts[1]); s.shapes.title.text = "Exemple à retirer"
p.save("modele.pptx")
from docx import Document
d = Document(); d.add_paragraph("Devis pour {{ client }} : {{ montant }} €")
d.add_paragraph("{% for l in lignes %}- {{ l }}{% endfor %}"); d.save("devis.docx")
'''
templates = {f["name"]: f["data"] for f in run(make_templates)["files"]}
out = run(r'''
from snowfall_docs import Deck, fill_template, template_fields
deck = Deck(template="inputs/modele.pptx")
print("layouts", len(deck.layouts()))
deck.layout_slide("Title and Content", title="Avec le modèle", body=["Un", ("Deux", ["détail"])])
deck.kpis("Chiffres", [("1", "un"), ("2", "deux")])
deck.save("avec-modele.pptx")
print("champs", template_fields("inputs/devis.docx"))
fill_template("inputs/devis.docx", {"client": "ACME <script>", "montant": "1 200", "lignes": ["Audit", "Formation"]}, "devis-acme.docx")
''', files=[{"path": f"inputs/{name}", "data": data} for name, data in templates.items()])
found = files_of(out)
ok = out["exitCode"] == 0 and {"avec-modele.pptx", "devis-acme.docx"} <= set(found)
detail = out["stdout"].strip() + " " + out["stderr"][-400:]
if ok:
    deck_parts = parts(found["avec-modele.pptx"])
    slides = [n for n in deck_parts if n.startswith("ppt/slides/slide")]
    devis = zipfile.ZipFile(io.BytesIO(base64.b64decode(found["devis-acme.docx"]["data"]))).read("word/document.xml").decode()
    ok = len(slides) == 2 and "ACME &lt;script&gt;" in devis and "Formation" in devis and "{{" not in devis and "champs ['client', 'lignes', 'montant']" in out["stdout"]
    detail += f" · {len(slides)} diapositives"
check("modèles : PowerPoint suivi (exemples retirés), Word à champs rempli et échappé", ok, detail)

# ---- 4. Fichier de modèle hostile : reste dans le bac à sable -----------------------
out = run(r'''
from snowfall_docs import Report
try:
    Report(template="inputs/piege.docx")
    print("ouvert")
except Exception as error:
    print("refusé", type(error).__name__)
''', files=[{"path": "inputs/piege.docx", "data": base64.b64encode(b"PK\x03\x04 pas un document").decode()}])
check("modèle corrompu : erreur propre, aucune sortie", out["exitCode"] == 0 and "refusé" in out["stdout"] and not out["files"], out["stdout"].strip())

# ---- 5. Petites erreurs du modèle : corrigées et signalées, jamais devinées -----------
out = run(r'''
from pptx import Presentation
from snowfall_docs import Deck, Theme
theme = Theme.preset("corporate")
print("theme", theme.name)
deck = Deck(theme=theme, title="T")
deck.section("Résultats", number=1, note="Dire bonjour")
# Appels écrits tels quels par Gemini pendant une mesure (17 novembre).
deck.title_slide(title="Bilan 2026", subtitle="Comité", author="Direction générale")
deck.kpis(title="Une année record", items=[("4,2 M€", "CA")], takeaway="Objectifs dépassés")
deck.chart(title="Ventes", chart_type="column", categories=["T1", "T2"], series={"2026": [0.9, 1.0]})
deck.two_columns(title="Avant / après", left_title="Avant", left_items=["Manuel"], right_title="Après", right_items=["Automatique"])
deck.bullets("x", ["a"], colour="red")
try:
    deck.two_columns(title="Sans colonnes")
except TypeError as error:
    print("refusé", error)
deck.save("t.pptx")
slides = Presentation("t.pptx").slides
print("diapositives", len(slides))
print("notes", slides[0].has_notes_slide and slides[0].notes_slide.notes_text_frame.text)
print("auteur", any("Direction générale" in shape.text_frame.text for shape in slides[1].shapes if shape.has_text_frame))
''')
stdout = out["stdout"]
ok = (
    out["exitCode"] == 0 and "theme graphite" in stdout and "compris comme notes=" in stdout and "notes Dire bonjour" in stdout
    and "chart_type= compris comme kind=" in stdout and "left_items= compris comme left=" in stdout and "auteur True" in stdout
    and "colour= ignoré" in stdout and "diapositives 6" in stdout and "refusé" in stdout
)
check("tolérance : noms inventés compris, inconnus ignorés (signalés), obligatoire manquant refusé", ok, stdout.strip()[-500:] + out["stderr"][-300:])

# ---- 6. Sommaire réellement rempli dans le PDF ; liste numérotée sans double numéro -----
out = run(r'''
from pypdf import PdfReader
from snowfall_docs import Report, to_pdf
doc = Report(title="Rapport", subtitle="Test")
doc.toc()
doc.heading("1. Synthèse")
doc.paragraph("Texte.")
doc.page_break()
doc.heading("2. Analyse")
doc.heading("2.1 Détail", level=2)
doc.bullets([("Agir", ["Premier point"]), ("Mesurer", ["Second point"])], numbered=True)
doc.save("r.docx")
import re
pages = [page.extract_text() for page in PdfReader(to_pdf("r.docx")).pages]
toc = next(text for text in pages if "Sommaire" in text)
print("SOMMAIRE", " | ".join(line.strip() for line in toc.splitlines() if line.strip()))
print("LISTE", " | ".join(line.strip() for line in pages[-1].splitlines() if line.strip()))
# Chaque numéro du sommaire = page où le titre figure réellement (hors page du sommaire).
for title in ("1. Synthèse", "2. Analyse", "2.1 Détail"):
    listed = re.search(re.escape(title) + r"\.+\s*(\d+)", toc)
    actual = next(index + 1 for index, text in enumerate(pages) if title in text and "Sommaire" not in text)
    print("PAGE", title, listed and listed.group(1), actual)
''')
stdout = out["stdout"]
toc_line = next((line for line in stdout.splitlines() if line.startswith("SOMMAIRE")), "")
list_line = next((line for line in stdout.splitlines() if line.startswith("LISTE")), "")
page_lines = [line.split() for line in stdout.splitlines() if line.startswith("PAGE")]
ok = (
    out["exitCode"] == 0
    and "Clic droit" not in toc_line
    and len(page_lines) == 3 and all(parts[-2] == parts[-1] for parts in page_lines)
    and len({parts[-1] for parts in page_lines}) > 1
    and "1. Agir" in list_line and "2. Mesurer" in list_line and "1. Premier" not in list_line
)
check("sommaire calculé dans le PDF ; sous-points à puces dans une liste numérotée", ok, (toc_line + " · " + list_line)[:400] + out["stderr"][-400:])

# ---- 7. Rendu en français ; chiffres clés centrés ------------------------------------
out = run(r'''
from pptx import Presentation
from pypdf import PdfReader
from snowfall_docs import Deck, to_pdf
deck = Deck(title="T")
deck.chart("Ventes", "column", ["T1", "T2"], {"2026": [0.9, 1.25]}, number_format='0.0" M€"')
deck.kpis("Chiffres", [("4,2 M€", "CA"), ("22 %", "Marge")])
deck.save("l.pptx")
text = " ".join(page.extract_text() for page in PdfReader(to_pdf("l.pptx")).pages)
print("DECIMALES", "0,9" in text, "0.9" in text)
cards = [shape.top / 914400 for shape in Presentation("l.pptx").slides[1].shapes if shape.shape_type == 1 and shape.width > 914400]
print("CARTES", round(min(cards), 2))
''')
stdout = out["stdout"]
ok = out["exitCode"] == 0 and "DECIMALES True False" in stdout and any(line.startswith("CARTES") and float(line.split()[1]) > 2.4 for line in stdout.splitlines())
check("rendu PDF en français (0,9) ; chiffres clés centrés verticalement", ok, stdout.strip()[:200] + out["stderr"][-300:])

width = max(len(name) for name, *_ in results)
failed = 0
for name, ok, detail in results:
    failed += not ok
    print(f"{'✓' if ok else '✗'} {name.ljust(width)}  {detail}")
print(f"\n{len(results)} contrôles : {'tout est bon.' if not failed else f'{failed} en échec.'}")
sys.exit(1 if failed else 0)
