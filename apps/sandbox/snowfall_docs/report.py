"""Rapports Word (.docx) : couverture, sommaire, titres, encadrés, tableaux, figures, modèles."""

from __future__ import annotations

import os
import re
import uuid
from datetime import date

from docx import Document
from docx.enum.section import WD_ORIENT
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK, WD_TAB_ALIGNMENT, WD_TAB_LEADER
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor, Twips

from .charts import chart_png
from .theme import Theme, hex_color, lighten, on
from .tolerant import tolerant

INLINE = re.compile(r"(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)")


def _rgb(color: str) -> RGBColor:
    return RGBColor.from_string(hex_color(color))


def _shade(element, color: str):
    properties = element.get_or_add_tcPr() if hasattr(element, "get_or_add_tcPr") else element.get_or_add_pPr()
    shading = OxmlElement("w:shd")
    shading.set(qn("w:val"), "clear")
    shading.set(qn("w:color"), "auto")
    shading.set(qn("w:fill"), hex_color(color))
    properties.append(shading)


def _borders(cell, color: str, sides=("top", "bottom", "left", "right"), size=4, left: tuple[str, int] | None = None):
    properties = cell._tc.get_or_add_tcPr()  # noqa: SLF001
    borders = OxmlElement("w:tcBorders")
    for side in ("top", "left", "bottom", "right"):
        edge = OxmlElement(f"w:{side}")
        if side == "left" and left:
            edge.set(qn("w:val"), "single")
            edge.set(qn("w:sz"), str(left[1]))
            edge.set(qn("w:color"), hex_color(left[0]))
        elif side in sides:
            edge.set(qn("w:val"), "single")
            edge.set(qn("w:sz"), str(size))
            edge.set(qn("w:color"), hex_color(color))
        else:
            edge.set(qn("w:val"), "nil")
        borders.append(edge)
    properties.append(borders)


def _field(paragraph, code: str, placeholder: str = ""):
    """Champ Word (numéro de page, sommaire…) : calculé à l'ouverture."""
    run = paragraph.add_run()
    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    begin.set(qn("w:dirty"), "true")
    instruction = OxmlElement("w:instrText")
    instruction.set(qn("xml:space"), "preserve")
    instruction.text = code
    separate = OxmlElement("w:fldChar")
    separate.set(qn("w:fldCharType"), "separate")
    text = OxmlElement("w:t")
    text.text = placeholder
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    for element in (begin, instruction, separate, text, end):
        run._r.append(element)  # noqa: SLF001
    return run


@tolerant
class Report:
    """Rapport A4.

    doc = Report(theme=Theme.preset("forest"), title="Audit énergétique", subtitle="Site de Lyon", author="Direction technique")
    doc.toc()
    doc.heading("Synthèse")
    doc.paragraph("La consommation baisse de **12 %** grâce à…")
    doc.callout("À retenir", "Trois actions couvrent 80 % des économies.", kind="success")
    doc.table([["Poste", "kWh"], ["Chauffage", "120 000"]])
    doc.chart("column", ["2024", "2025"], {"kWh": [140000, 123000]}, title="Consommation")
    doc.save("audit.docx")

    Avec un modèle de l'utilisateur : Report(template="inputs/modele.docx") garde ses
    styles, en-têtes et pieds de page (son contenu est retiré ; keep_content=True pour
    le garder). Pour un modèle à champs {{ nom }} : fill_template().
    """

    def __init__(self, theme: Theme | None = None, title: str = "", subtitle: str = "", author: str = "", when: str | None = None, template: str | None = None, keep_content: bool = False, cover: bool = True, landscape: bool = False, header: bool = True):
        self.template = template
        if template:
            self.doc = Document(template)
            self.theme = theme or Theme.from_template(template)
            if not keep_content:
                body = self.doc.element.body
                for child in list(body):
                    if child.tag != qn("w:sectPr"):
                        body.remove(child)
        else:
            self.doc = Document()
            self.theme = theme or Theme()
            self._styles()
            section = self.doc.sections[0]
            section.page_width, section.page_height = Cm(21), Cm(29.7)
            if landscape:
                section.orientation = WD_ORIENT.LANDSCAPE
                section.page_width, section.page_height = Cm(29.7), Cm(21)
            for side in ("left_margin", "right_margin"):
                setattr(section, side, Cm(2.2))
            section.top_margin, section.bottom_margin = Cm(2.2), Cm(2)
        self.title = title
        self.figures = 0
        self.tables = 0
        # Champs (sommaire, numéros de page) mis à jour à l'ouverture dans Word.
        settings = self.doc.settings.element
        if settings.find(qn("w:updateFields")) is None:
            update = OxmlElement("w:updateFields")
            update.set(qn("w:val"), "true")
            settings.append(update)
        self.doc.core_properties.title = title
        self.doc.core_properties.author = author or "Snowfall"
        if not template:
            if header:
                self._header_footer()
            if title and cover:
                self.cover(title, subtitle, author, when)

    # ---- mise en forme ----------------------------------------------------------

    def _styles(self):
        t = self.theme
        styles = self.doc.styles
        normal = styles["Normal"]
        normal.font.name = t.font
        normal.font.size = Pt(11)
        normal.font.color.rgb = _rgb(t.text)
        normal.element.rPr.rFonts.set(qn("w:eastAsia"), t.font)
        normal.paragraph_format.space_after = Pt(6)
        normal.paragraph_format.line_spacing = 1.15
        for level, (size, color, before) in {1: (20, t.primary, 18), 2: (15, t.primary, 14), 3: (12.5, t.accent, 10)}.items():
            style = styles[f"Heading {level}"]
            style.font.name = t.headings
            style.font.size = Pt(size)
            style.font.bold = True
            style.font.color.rgb = _rgb(color)
            style.element.rPr.rFonts.set(qn("w:eastAsia"), t.headings)
            style.paragraph_format.space_before = Pt(before)
            style.paragraph_format.space_after = Pt(6)
            style.paragraph_format.keep_with_next = True
        for name in ("List Bullet", "List Number"):
            styles[name].font.name = t.font
            styles[name].paragraph_format.space_after = Pt(3)
        caption = styles["Caption"] if "Caption" in [s.name for s in styles] else styles.add_style("Caption", 1)
        caption.font.size = Pt(9.5)
        caption.font.italic = True
        caption.font.color.rgb = _rgb(t.muted)

    def _header_footer(self):
        t = self.theme
        section = self.doc.sections[0]
        section.different_first_page_header_footer = True
        header = section.header.paragraphs[0]
        header.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        run = header.add_run(self.title or "")
        run.font.size = Pt(9)
        run.font.color.rgb = _rgb(t.muted)
        footer = section.footer.paragraphs[0]
        footer.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        for part in ("Page ", None, " / ", "NUMPAGES"):
            if part is None:
                run = _field(footer, "PAGE", "1")
            elif part == "NUMPAGES":
                run = _field(footer, "NUMPAGES", "1")
            else:
                run = footer.add_run(part)
            run.font.size = Pt(9)
            run.font.color.rgb = _rgb(t.muted)

    def _runs(self, paragraph, text: str, size: float | None = None, color: str | None = None, bold: bool = False):
        """Texte avec **gras**, *italique* et `code`."""
        for part in INLINE.split(str(text)):
            if not part:
                continue
            if part.startswith("**") and part.endswith("**"):
                run = paragraph.add_run(part[2:-2])
                run.bold = True
            elif part.startswith("`") and part.endswith("`"):
                run = paragraph.add_run(part[1:-1])
                run.font.name = "Consolas"
            elif part.startswith("*") and part.endswith("*"):
                run = paragraph.add_run(part[1:-1])
                run.italic = True
            else:
                run = paragraph.add_run(part)
            if bold:
                run.bold = True
            if size:
                run.font.size = Pt(size)
            if color:
                run.font.color.rgb = _rgb(color)
        return paragraph

    # ---- contenu ----------------------------------------------------------------

    def cover(self, title: str, subtitle: str = "", author: str = "", when: str | None = None):
        """Page de garde : bandeau de couleur, titre, sous-titre, auteur et date."""
        t = self.theme
        band = self.doc.add_table(rows=1, cols=1)
        band.alignment = WD_TABLE_ALIGNMENT.CENTER
        cell = band.cell(0, 0)
        _shade(cell._tc, t.primary)  # noqa: SLF001
        _borders(cell, t.primary, sides=())
        cell.width = Cm(16.6)
        paragraph = cell.paragraphs[0]
        paragraph.paragraph_format.space_before = Pt(70)
        paragraph.paragraph_format.space_after = Pt(4)
        self._runs(paragraph, title, size=32 if len(title) < 50 else 26, color=on(t.primary), bold=True)
        if subtitle:
            sub = cell.add_paragraph()
            sub.paragraph_format.space_after = Pt(70)
            self._runs(sub, subtitle, size=15, color=lighten(t.primary, 0.7) if on(t.primary) == "#FFFFFF" else t.muted)
        else:
            paragraph.paragraph_format.space_after = Pt(70)
        accent = self.doc.add_paragraph()
        accent.paragraph_format.space_before = Pt(18)
        bar = accent.add_run("▬▬▬▬")
        bar.font.color.rgb = _rgb(t.accent)
        meta = self.doc.add_paragraph()
        self._runs(meta, " · ".join(part for part in (author, when or date.today().strftime("%d/%m/%Y")) if part), size=11, color=t.muted)
        self.page_break()

    def toc(self, title: str = "Sommaire", levels: int = 2):
        """Sommaire : ses entrées sont écrites à l'enregistrement, d'après les titres (renvois de
        page calculés par Word à l'ouverture, et par LibreOffice lors de to_pdf)."""
        heading = self.doc.add_paragraph()
        self._runs(heading, title, size=18, color=self.theme.primary, bold=True)
        self._toc = (self.doc.add_paragraph(), max(1, min(levels, 3)))
        self.page_break()

    def heading(self, text: str, level: int = 1):
        return self.doc.add_heading(str(text), level=max(1, min(level, 3)))

    def paragraph(self, text: str, align: str = "justify", size: float | None = None, color: str | None = None):
        """Paragraphe (**gras**, *italique*, `code`) ; align : left, center, right, justify."""
        paragraph = self.doc.add_paragraph()
        paragraph.alignment = {"left": WD_ALIGN_PARAGRAPH.LEFT, "center": WD_ALIGN_PARAGRAPH.CENTER, "right": WD_ALIGN_PARAGRAPH.RIGHT, "justify": WD_ALIGN_PARAGRAPH.JUSTIFY}[align]
        return self._runs(paragraph, text, size=size, color=color)

    def bullets(self, items: list, numbered: bool = False):
        """Liste ; un élément peut être (texte, [sous-points]). Numérotée : les sous-points restent à puces."""
        style = "List Number" if numbered else "List Bullet"
        names = [s.name for s in self.doc.styles]
        for item in items:
            text, children = item if isinstance(item, tuple) else (item, [])
            self._runs(self.doc.add_paragraph(style=style), text)
            for child in children:
                sub = self.doc.add_paragraph(style="List Bullet 2" if "List Bullet 2" in names else "List Bullet")
                self._runs(sub, child)

    def callout(self, title: str, text: str, kind: str = "info"):
        """Encadré : info, success, warning, danger (ou une couleur #RRGGBB)."""
        t = self.theme
        color = {"info": t.accent, "success": "#27AE60", "warning": "#F2994A", "danger": "#EB5757"}.get(kind, kind)
        box = self.doc.add_table(rows=1, cols=1)
        box.alignment = WD_TABLE_ALIGNMENT.CENTER
        cell = box.cell(0, 0)
        _shade(cell._tc, lighten(color, 0.9))  # noqa: SLF001
        _borders(cell, color, sides=(), left=(color, 24))
        head = cell.paragraphs[0]
        head.paragraph_format.space_before = Pt(4)
        self._runs(head, title, color=color, bold=True)
        body = cell.add_paragraph()
        body.paragraph_format.space_after = Pt(4)
        self._runs(body, text)
        self.doc.add_paragraph()

    def table(self, rows: list[list], header: bool = True, widths: list[float] | None = None, caption: str | None = None, align: list[str] | None = None):
        """Tableau : en-tête à la couleur dominante, lignes alternées, nombres alignés à droite."""
        t = self.theme
        rows = [["" if v is None else str(v) for v in row] for row in rows]
        cols = max(len(r) for r in rows)
        table = self.doc.add_table(rows=len(rows), cols=cols)
        table.alignment = WD_TABLE_ALIGNMENT.CENTER
        usable = 16.6
        total = sum(widths) if widths else cols
        for r, row in enumerate(rows):
            for c in range(cols):
                cell = table.cell(r, c)
                cell.width = Cm(usable * ((widths[c] if widths else 1) / total))
                value = row[c] if c < len(row) else ""
                paragraph = cell.paragraphs[0]
                paragraph.paragraph_format.space_before = Pt(3)
                paragraph.paragraph_format.space_after = Pt(3)
                side = align[c] if align and c < len(align) else ("r" if _numeric(value) and not (header and r == 0) else "l")
                paragraph.alignment = {"l": WD_ALIGN_PARAGRAPH.LEFT, "c": WD_ALIGN_PARAGRAPH.CENTER, "r": WD_ALIGN_PARAGRAPH.RIGHT}[side]
                is_header = header and r == 0
                self._runs(paragraph, value, size=10, color=on(t.primary) if is_header else t.text, bold=is_header)
                if is_header:
                    _shade(cell._tc, t.primary)  # noqa: SLF001
                elif r % 2 == 0:
                    _shade(cell._tc, t.light)  # noqa: SLF001
                _borders(cell, t.border, sides=("bottom",))
        if header:
            # L'en-tête se répète sur chaque page.
            row_properties = table.rows[0]._tr.get_or_add_trPr()  # noqa: SLF001
            repeat = OxmlElement("w:tblHeader")
            repeat.set(qn("w:val"), "true")
            row_properties.append(repeat)
        if caption:
            self.tables += 1
            self._caption(f"Tableau {self.tables} — {caption}")
        else:
            self.doc.add_paragraph()
        return table

    def image(self, path: str, width_cm: float = 15.5, caption: str | None = None):
        self.doc.add_picture(path, width=Cm(width_cm))
        self.doc.paragraphs[-1].alignment = WD_ALIGN_PARAGRAPH.CENTER
        if caption:
            self.figures += 1
            self._caption(f"Figure {self.figures} — {caption}")

    def chart(self, kind: str, categories: list, series: dict[str, list[float]], title: str | None = None, caption: str | None = None, unit: str = "", width_cm: float = 15.5):
        """Graphique aux couleurs du thème : column, stacked, bar, line, area, pie, doughnut."""
        path = os.path.join(os.getcwd(), f".chart-{uuid.uuid4().hex[:8]}.png")
        chart_png(path, kind, categories, series, self.theme, title=title, unit=unit)
        self.image(path, width_cm, caption)
        os.remove(path)

    def kpis(self, items: list[tuple]):
        """Chiffres clés côte à côte : [(« 18 % », « croissance »), …] (2 à 4)."""
        t = self.theme
        table = self.doc.add_table(rows=1, cols=len(items))
        table.alignment = WD_TABLE_ALIGNMENT.CENTER
        for index, item in enumerate(items):
            value, label, *rest = item
            cell = table.cell(0, index)
            _shade(cell._tc, t.light)  # noqa: SLF001
            _borders(cell, "#FFFFFF", sides=("left", "right"), size=24, left=(t.chart[index % len(t.chart)], 24))
            top = cell.paragraphs[0]
            top.paragraph_format.space_before = Pt(8)
            self._runs(top, str(value), size=22, color=t.primary, bold=True)
            self._runs(cell.add_paragraph(), str(label), size=10, color=t.text)
            if rest:
                self._runs(cell.add_paragraph(), str(rest[0]), size=9.5, color=t.accent, bold=True)
        self.doc.add_paragraph()

    def quote(self, text: str, author: str = ""):
        t = self.theme
        paragraph = self.doc.add_paragraph()
        paragraph.paragraph_format.left_indent = Cm(1)
        paragraph.paragraph_format.space_before = Pt(10)
        self._runs(paragraph, f"« {text} »", size=13, color=t.primary)
        paragraph.runs[0].italic = True
        if author:
            self._runs(self.doc.add_paragraph(), f"— {author}", size=10, color=t.muted).paragraph_format.left_indent = Cm(1)

    def page_break(self):
        self.doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)

    def _caption(self, text: str):
        paragraph = self.doc.add_paragraph(style="Caption")
        paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
        paragraph.add_run(text)

    def _write_toc(self):
        """Entrées du sommaire (champ TOC dont le résultat est déjà écrit) : un signet par titre,
        un lien et un renvoi de page (PAGEREF) par entrée."""
        placeholder, levels = self._toc
        entries = []
        for paragraph in self.doc.paragraphs:
            match = re.fullmatch(r"Heading (\d)", paragraph.style.name or "")
            if not match or int(match.group(1)) > levels or not paragraph.text.strip():
                continue
            name = f"_Toc{len(entries) + 1:06d}"
            start, end = OxmlElement("w:bookmarkStart"), OxmlElement("w:bookmarkEnd")
            start.set(qn("w:id"), str(900 + len(entries)))
            start.set(qn("w:name"), name)
            end.set(qn("w:id"), str(900 + len(entries)))
            paragraph._p.insert(1 if paragraph._p.pPr is not None else 0, start)  # noqa: SLF001
            paragraph._p.append(end)  # noqa: SLF001
            entries.append((int(match.group(1)), paragraph.text.strip(), name))
        if not entries:
            self._runs(placeholder, "(aucun titre)", color=self.theme.muted)
            return
        section = self.doc.sections[-1]
        width = int((section.page_width - section.left_margin - section.right_margin) / 635)  # EMU → twips

        def char(kind):
            run = OxmlElement("w:r")
            element = OxmlElement("w:fldChar")
            element.set(qn("w:fldCharType"), kind)
            run.append(element)
            return run

        def instruction(code):
            run = OxmlElement("w:r")
            element = OxmlElement("w:instrText")
            element.set(qn("xml:space"), "preserve")
            element.text = code
            run.append(element)
            return run

        def text(value, bold=False):
            run = OxmlElement("w:r")
            if bold:
                properties = OxmlElement("w:rPr")
                properties.append(OxmlElement("w:b"))
                run.append(properties)
            element = OxmlElement("w:t")
            element.set(qn("xml:space"), "preserve")
            element.text = value
            run.append(element)
            return run

        previous = placeholder
        for index, (level, label, name) in enumerate(entries):
            paragraph = placeholder if index == 0 else previous.insert_paragraph_before("")
            if index:
                # insert_paragraph_before place AVANT : on remet l'entrée après la précédente.
                previous._p.addnext(paragraph._p)  # noqa: SLF001
            paragraph.paragraph_format.left_indent = Cm(0.6 * (level - 1))
            paragraph.paragraph_format.space_after = Pt(4 if level > 1 else 6)
            paragraph.paragraph_format.tab_stops.add_tab_stop(Twips(width), WD_TAB_ALIGNMENT.RIGHT, WD_TAB_LEADER.DOTS)
            p = paragraph._p  # noqa: SLF001
            if index == 0:
                p.append(char("begin"))
                p.append(instruction(f' TOC \\o "1-{levels}" \\h \\z \\u '))
                p.append(char("separate"))
            link = OxmlElement("w:hyperlink")
            link.set(qn("w:anchor"), name)
            link.set(qn("w:history"), "1")
            link.append(text(label, bold=level == 1))
            tab = OxmlElement("w:r")
            tab.append(OxmlElement("w:tab"))
            link.append(tab)
            link.append(char("begin"))
            link.append(instruction(f" PAGEREF {name} \\h "))
            link.append(char("separate"))
            link.append(text("1"))
            link.append(char("end"))
            p.append(link)
            previous = paragraph
        previous._p.append(char("end"))  # noqa: SLF001

    def save(self, path: str = "rapport.docx") -> str:
        if not path.lower().endswith(".docx"):
            path += ".docx"
        if getattr(self, "_toc", None):
            self._write_toc()
            self._toc = None
        self.doc.save(path)
        return path


def fill_template(template: str, context: dict, output: str, images: dict[str, tuple[str, float]] | None = None) -> str:
    """Remplit un modèle Word à champs Jinja : {{ client }}, {% for l in lignes %}…{% endfor %}.
    images : {« logo »: (« inputs/logo.png », largeur_cm)} pour {{ logo }} dans le modèle."""
    from docxtpl import DocxTemplate, InlineImage

    document = DocxTemplate(template)
    values = dict(context)
    for name, (path, width) in (images or {}).items():
        values[name] = InlineImage(document, path, width=Cm(width))
    document.render(values, autoescape=True)
    document.save(output)
    return output


def template_fields(template: str) -> list[str]:
    """Champs {{ … }} attendus par un modèle Word (à demander ou remplir)."""
    from docxtpl import DocxTemplate

    return sorted(DocxTemplate(template).get_undeclared_template_variables())


def _numeric(text: str) -> bool:
    cleaned = text.replace(" ", "").replace(" ", "").replace(",", ".").rstrip("%€$").lstrip("+-")
    try:
        float(cleaned)
        return bool(cleaned)
    except ValueError:
        return False
