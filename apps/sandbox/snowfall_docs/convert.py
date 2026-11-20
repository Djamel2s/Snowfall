"""Conversion en PDF (LibreOffice, sans interface) et PDF directs avec des polices complètes."""

from __future__ import annotations

import os
import re
import shutil
import subprocess

FONTS = "/usr/share/fonts/truetype"


def to_pdf(path: str, timeout: int = 50, locale: str = "fr-FR") -> str:
    """Word, PowerPoint ou Excel → PDF à côté du fichier (même nom). Numéros de page, formules
    et sommaire (rapport snowfall_docs) sont calculés. locale : séparateur décimal et formats
    des nombres dans le rendu (fr-FR : « 0,9 »). Renvoie le chemin du PDF."""
    output = _convert(path, timeout, locale)
    # LibreOffice ne recalcule pas les renvois de page d'un sommaire Word : on lit la page
    # réelle de chaque titre dans le PDF, on l'inscrit dans le document, puis on reconvertit.
    if path.lower().endswith(".docx") and _number_toc(path, output):
        output = _convert(path, timeout, locale)
    return output


def _number_toc(docx: str, pdf: str) -> bool:
    """Écrit dans le sommaire la page où figure chaque titre. False : pas de sommaire à numéroter."""
    import re

    from docx import Document
    from docx.oxml.ns import qn
    from pypdf import PdfReader

    document = Document(docx)
    body = document.element.body
    titles = {}
    for start in body.iter(qn("w:bookmarkStart")):
        name = start.get(qn("w:name")) or ""
        if name.startswith("_Toc"):
            paragraph = start.getparent()
            titles[name] = "".join(t.text or "" for t in paragraph.iter(qn("w:t")))
    links = [link for link in body.iter(qn("w:hyperlink")) if link.get(qn("w:anchor")) in titles]
    if not links:
        return False
    squash = lambda text: re.sub(r"\s+", "", text)  # noqa: E731
    pages = [squash(page.extract_text() or "") for page in PdfReader(pdf).pages]
    # Le sommaire lui-même cite les titres : on cherche après sa dernière page.
    first_title = squash(titles[links[0].get(qn("w:anchor"))])
    cursor = max((index for index, text in enumerate(pages) if first_title in text and "....." in text), default=-1) + 1
    changed = False
    for link in links:
        title = squash(titles[link.get(qn("w:anchor"))])
        found = next((index for index in range(cursor, len(pages)) if title and title in pages[index]), None)
        if found is None:
            continue
        cursor = found
        # Résultat du champ PAGEREF : le texte entre « separate » et « end ».
        inside = False
        for element in link.iter(qn("w:fldChar"), qn("w:t")):
            if element.tag == qn("w:fldChar"):
                kind = element.get(qn("w:fldCharType"))
                inside = kind == "separate"
                if kind == "end":
                    break
            elif inside:
                element.text = str(found + 1)
                changed = True
                break
    if changed:
        document.save(docx)
    return changed


LOCALE_SETTINGS = """<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Setup/L10N"><prop oor:name="ooSetupSystemLocale" oor:op="fuse"><value>{locale}</value></prop></item>
<item oor:path="/org.openoffice.Setup/L10N"><prop oor:name="ooLocale" oor:op="fuse"><value>{locale}</value></prop></item>
</oor:items>
"""


def _convert(path: str, timeout: int, locale: str = "fr-FR") -> str:
    if not os.path.isfile(path):
        raise FileNotFoundError(path)
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice:
        raise RuntimeError("LibreOffice n'est pas installé dans ce bac à sable.")
    folder = os.path.dirname(os.path.abspath(path))
    # Profil LibreOffice dans le dossier de l'exécution (le système est en lecture seule).
    profile = os.path.join(os.getcwd(), ".libreoffice")
    os.makedirs(os.path.join(profile, "user"), exist_ok=True)
    # Langue du rendu (le système du bac à sable est en anglais) : « 0,9 M€ » et non « 0.9 M€ ».
    if re.fullmatch(r"[a-z]{2}-[A-Z]{2}", locale):
        with open(os.path.join(profile, "user", "registrymodifications.xcu"), "w", encoding="utf-8") as settings:
            settings.write(LOCALE_SETTINGS.format(locale=locale))
    result = subprocess.run(
        [soffice, f"-env:UserInstallation=file://{profile}", "--headless", "--norestore", "--nolockcheck", "--nodefault", "--nologo",
         "--convert-to", "pdf", "--outdir", folder, path],
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    output = os.path.join(folder, os.path.splitext(os.path.basename(path))[0] + ".pdf")
    if not os.path.isfile(output):
        raise RuntimeError(f"Conversion en PDF impossible : {(result.stderr or result.stdout).strip()[:500]}")
    return output


def pdf_fonts(pdf, family: str = "Carlito") -> str:
    """Enregistre une police Unicode dans un FPDF (accents, « », €, —) : pdf.set_font(nom) ensuite.
    family : Carlito (≈ Calibri), Caladea (≈ Cambria), DejaVuSans, Inter."""
    files = {
        "Carlito": ("crosextra/Carlito-Regular.ttf", "crosextra/Carlito-Bold.ttf", "crosextra/Carlito-Italic.ttf"),
        "Caladea": ("crosextra/Caladea-Regular.ttf", "crosextra/Caladea-Bold.ttf", "crosextra/Caladea-Italic.ttf"),
        "DejaVuSans": ("dejavu/DejaVuSans.ttf", "dejavu/DejaVuSans-Bold.ttf", "dejavu/DejaVuSans-Oblique.ttf"),
    }
    if family == "Inter":
        base = "/usr/share/fonts/opentype/inter/Inter-Regular.otf"
        candidates = [base, "/usr/share/fonts/truetype/inter/Inter-Regular.ttf"]
        regular = next((p for p in candidates if os.path.exists(p)), None)
        if not regular:
            return pdf_fonts(pdf, "Carlito")
        pdf.add_font("Inter", "", regular)
        bold = regular.replace("Regular", "Bold")
        pdf.add_font("Inter", "B", bold if os.path.exists(bold) else regular)
        return "Inter"
    regular, bold, italic = (os.path.join(FONTS, f) for f in files[family])
    pdf.add_font(family, "", regular)
    pdf.add_font(family, "B", bold)
    pdf.add_font(family, "I", italic)
    return family
