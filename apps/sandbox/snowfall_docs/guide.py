"""Mode d'emploi lu par l'agent : print(guide()) (tout) ou print(guide("deck", "pdf"))."""

GENERAL = """snowfall_docs — documents soignés en quelques lignes (pptx, docx, xlsx, pdf).

Principes de qualité (à suivre) :
- N'invente rien : seulement les chiffres, noms, dates et sources donnés (demande, pièces jointes, résultats d'outils).
  Pas de détail inventé pour remplir (répartition, délai, source, pourcentage) : une diapositive plus courte vaut mieux.
- Un message par diapositive ou par section ; le titre dit la conclusion (« Les ventes ont progressé de 18 % »), pas le sujet (« Ventes »).
- Chiffres : unité, période, source. Peu de mots : 3 à 6 puces, 12 mots chacune au plus.
- Varier les mises en page (chiffres clés, graphique, deux colonnes, frise) plutôt qu'enchaîner des puces.
- Même thème partout ; Theme.from_color("#E11D48") pour une couleur de marque, Theme.from_template(fichier) pour un modèle.
- Toujours enregistrer dans le dossier courant (pas inputs/) ; to_pdf(chemin) si l'utilisateur veut un PDF.

Thèmes : Theme.preset(nom) — snowfall, ocean, graphite, forest, sunset, royal, minimal.
guide() donne tout ; guide("deck", "pdf") seulement ces rubriques (deck, report, workbook, pdf, template).
Un argument inconnu est ignoré (signalé dans la sortie) : relis la sortie avant de répondre."""

TOPICS = {
    "deck": """Deck — présentation 16:9 (graphiques natifs, modifiables) :
from snowfall_docs import Deck, Theme
deck = Deck(theme=Theme.preset("ocean"), title="Bilan 2026", footer="Direction financière")
deck.title_slide("Bilan 2026", "Comité de direction", "12 novembre 2026")
deck.section("Résultats", number=1)
deck.kpis("Une année record", [("18 %", "Croissance", "+6 pts vs 2025"), ("4,2 M€", "Chiffre d'affaires"), ("92 %", "Clients satisfaits")])
deck.chart("Les ventes accélèrent au T3", "column", ["T1", "T2", "T3", "T4"], {"2026": [0.9, 1.0, 1.2, 1.1]}, number_format='0.0" M€"', takeaway="+20 % au T3, porté par l'export")
deck.bullets("Trois priorités", ["Export", ("Industrialiser", ["Usine de Lyon", "Sous-traitance"]), "Recruter 12 personnes"], aside="12 M€ d'investissement")
deck.two_columns("Avant / après", ["Saisie manuelle", "5 jours"], ["Automatisé", "2 heures"], left_title="Avant", right_title="Après")
deck.table("Détail par région", [["Région", "CA", "Évolution"], ["Nord", "1,2 M€", "+12 %"]])
deck.timeline("Feuille de route", [("T1", "Lancement", "Pilote 3 sites"), ("T2", "Déploiement"), ("T4", "Bilan")])
deck.steps("Notre méthode", [("Diagnostiquer", "Entretiens, données"), ("Concevoir", "Ateliers"), ("Déployer", "Par vagues")])
deck.image("Le prototype", "inputs/image-1.png", caption="Maquette V2") ; deck.image_text("Le site", "inputs/photo.png", ["…"])
deck.quote("La meilleure façon de prédire l'avenir est de le créer.", "Peter Drucker")
deck.closing("Merci", "contact@exemple.fr")
deck.save("bilan.pptx")
Chaque méthode accepte notes="…" (notes de l'orateur). Types de graphique : column, stacked, bar, line, area, pie, doughnut.""",
    "report": """Report — rapport Word A4 (couverture, sommaire, pagination automatiques) :
from snowfall_docs import Report, Theme
doc = Report(theme=Theme.preset("forest"), title="Audit énergétique", subtitle="Site de Lyon", author="Direction technique")
doc.toc()
doc.heading("1. Synthèse")            # level=2 ou 3 pour les sous-parties
doc.paragraph("La consommation baisse de **12 %** depuis 2024.")   # **gras**, *italique*, `code`
doc.kpis([("-12 %", "Consommation"), ("38 k€", "Économies / an")])
doc.callout("À retenir", "Trois actions couvrent 80 % des économies.", kind="success")   # info, success, warning, danger
doc.bullets(["Isolation", ("Chauffage", ["Pompe à chaleur", "Régulation"])]) ; doc.bullets([...], numbered=True)
doc.table([["Poste", "kWh", "Part"], ["Chauffage", "120 000", "62 %"]], caption="Consommation par poste")
doc.chart("column", ["2024", "2025", "2026"], {"MWh": [140, 131, 123]}, title="Consommation annuelle", caption="Source : compteurs")
doc.image("inputs/image-1.png", width_cm=12, caption="Façade nord")
doc.quote("…", "Auteur") ; doc.page_break()
doc.save("audit.docx")      # puis to_pdf("audit.docx") pour un PDF (sommaire calculé)""",
    "workbook": """Workbook — classeur Excel (tableaux filtrables, totaux, graphiques natifs) :
from snowfall_docs import Workbook, Theme
wb = Workbook("ventes.xlsx", theme=Theme.preset("ocean"))
ws = wb.sheet("Ventes")
ws.heading("Ventes 2026", "Source : CRM, au 31 octobre")
ws.kpis([("4,2 M€", "Chiffre d'affaires"), ("+18 %", "Croissance")])
ws.table(df_ou_lignes, formats={"Montant": "euro", "Marge": "percent", "Date": "date"}, totals=["Montant"])
ws.chart("column", "Mois", ["Montant"], title="Ventes par mois")     # line, bar, stacked, area, pie, doughnut
ws.highlight("Marge", "scale")      # data_bar, scale, top, negative
ws.note("Montants hors taxes.")
wb.save()
Formats : text, int, number, euro, euro0, percent, date, datetime (ou un motif Excel). Les lignes peuvent être un DataFrame pandas.
Les cellules commençant par « = » restent du texte (aucune formule injectée par une donnée).""",
    "pdf": """PDF :
- À partir d'un document : to_pdf("rapport.docx") / to_pdf("bilan.pptx") / to_pdf("ventes.xlsx") → même nom en .pdf.
- PDF direct (fpdf2) avec accents et symboles : from fpdf import FPDF ; from snowfall_docs import pdf_fonts
  pdf = FPDF() ; family = pdf_fonts(pdf) ; pdf.add_page() ; pdf.set_font(family, "B", 20) ; pdf.cell(0, 10, "Titre")
  pdf.image("inputs/image-1.png", w=80) ; pdf.output("document.pdf")
- Graphique en image : from snowfall_docs import chart_png ; chart_png("g.png", "line", cats, {"Série": vals}, theme)""",
    "template": """Modèles de l'utilisateur (pièce jointe passée dans « files ») :
- PowerPoint : deck = Deck(template="inputs/modele.pptx") — reprend taille, masque, couleurs et polices ; ses diapositives d'exemple sont retirées.
  deck.layouts() liste ses mises en page ; deck.layout_slide("Titre et contenu", title="…", body=["…", "…"]) les remplit (picture="…" pour une image).
  Les méthodes typées (kpis, chart, …) utilisent alors les couleurs du modèle.
- Word à styles : doc = Report(template="inputs/modele.docx") — garde styles, en-têtes et pieds de page, contenu retiré.
- Word à champs {{ client }}, {% for l in lignes %}…{% endfor %} : template_fields("inputs/devis.docx") liste les champs ;
  fill_template("inputs/devis.docx", {"client": "ACME", "lignes": [...]}, "devis-acme.docx").
- Couleurs d'un modèle pour un autre document : Theme.from_template("inputs/charte.pptx").""",
}


def guide(*topics: str) -> str:
    """Sans argument : tout le mode d'emploi, en une fois (une seule exécution d'agent).
    Avec des rubriques : seulement celles-ci, ex. guide("deck", "pdf")."""
    if not topics:
        return "\n\n".join([GENERAL, *TOPICS.values()])
    unknown = [topic for topic in topics if topic not in TOPICS]
    if unknown:
        return f"Rubrique inconnue : {unknown[0]!r}. Rubriques : {', '.join(TOPICS)}"
    return "\n\n".join(TOPICS[topic] for topic in topics)
