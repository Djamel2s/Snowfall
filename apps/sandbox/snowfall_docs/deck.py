"""Présentations PowerPoint (.pptx) : diapositives typées, au gabarit du thème ou d'un modèle."""

from __future__ import annotations

import os

from PIL import Image
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION, XL_LABEL_POSITION
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Inches, Pt

from .theme import Theme, hex_color, lighten, on
from .tolerant import tolerant

CHART_TYPES = {
    "column": XL_CHART_TYPE.COLUMN_CLUSTERED,
    "stacked": XL_CHART_TYPE.COLUMN_STACKED,
    "bar": XL_CHART_TYPE.BAR_CLUSTERED,
    "line": XL_CHART_TYPE.LINE_MARKERS,
    "area": XL_CHART_TYPE.AREA,
    "pie": XL_CHART_TYPE.PIE,
    "doughnut": XL_CHART_TYPE.DOUGHNUT,
}

W, H = Inches(13.333), Inches(7.5)
MARGIN = Inches(0.7)


def _rgb(color: str) -> RGBColor:
    return RGBColor.from_string(hex_color(color))


def _size_for(text_length: int, sizes=((900, 14), (650, 16), (420, 18), (0, 20))) -> int:
    for limit, size in sizes:
        if text_length > limit:
            return size
    return sizes[-1][1]


@tolerant
class Deck:
    """Présentation 16:9.

    deck = Deck(theme=Theme.preset("ocean"), title="Bilan 2026", footer="Snowfall")
    deck.title_slide("Bilan 2026", "Comité de direction · 12 novembre")
    deck.bullets("Ce qu'il faut retenir", ["Croissance de 18 %", ("Trois marchés", ["France", "Belgique"])])
    deck.save("bilan.pptx")

    Avec un modèle de l'utilisateur : Deck(template="inputs/modele.pptx") reprend sa
    taille, ses couleurs, ses polices et son masque ; ses diapositives d'exemple
    sont retirées (keep_slides=True pour les garder). layout_slide() remplit ses
    propres mises en page.
    """

    def __init__(self, theme: Theme | None = None, title: str = "", footer: str | None = None, template: str | None = None, keep_slides: bool = False, numbers: bool = True):
        self.template = template
        if template:
            self.prs = Presentation(template)
            self.theme = theme or Theme.from_template(template)
            if not keep_slides:
                ids = self.prs.slides._sldIdLst  # noqa: SLF001 (API officielle absente)
                for slide_id in list(ids):
                    self.prs.part.drop_rel(slide_id.rId)
                    ids.remove(slide_id)
        else:
            self.prs = Presentation()
            self.prs.slide_width, self.prs.slide_height = W, H
            self.theme = theme or Theme()
        self.width, self.height = self.prs.slide_width, self.prs.slide_height
        self.title = title
        self.footer = footer if footer is not None else title
        self.numbers = numbers
        self.count = 0

    # ---- briques ----------------------------------------------------------------

    def _blank(self):
        layouts = list(self.prs.slide_layouts)
        named = [l for l in layouts if l.name.lower() in ("blank", "vide", "leer", "en blanco")]
        layout = named[0] if named else min(layouts, key=lambda l: len(l.placeholders))
        slide = self.prs.slides.add_slide(layout)
        for placeholder in list(slide.placeholders):
            placeholder._element.getparent().remove(placeholder._element)  # noqa: SLF001
        self.count += 1
        return slide

    def _rect(self, slide, x, y, w, h, color, shape=MSO_SHAPE.RECTANGLE, radius=None):
        item = slide.shapes.add_shape(shape, x, y, w, h)
        item.fill.solid()
        item.fill.fore_color.rgb = _rgb(color)
        item.line.fill.background()
        item.shadow.inherit = False
        if radius is not None and item.adjustments:
            item.adjustments[0] = radius
        return item

    def _text(self, slide, x, y, w, h, text, size=18, color=None, bold=False, italic=False, font=None, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP, spacing=1.1):
        box = slide.shapes.add_textbox(x, y, w, h)
        frame = box.text_frame
        frame.word_wrap = True
        frame.vertical_anchor = anchor
        frame.margin_left = frame.margin_right = Inches(0.05)
        frame.margin_top = frame.margin_bottom = Inches(0.03)
        for index, line in enumerate(str(text).split("\n")):
            paragraph = frame.paragraphs[0] if index == 0 else frame.add_paragraph()
            paragraph.alignment = align
            paragraph.line_spacing = spacing
            run = paragraph.add_run()
            run.text = line
            self._style(run.font, size, color or self.theme.text, bold, italic, font)
        return box

    def _style(self, font, size, color, bold=False, italic=False, family=None):
        font.size = Pt(size)
        font.bold = bold
        font.italic = italic
        font.name = family or self.theme.font
        font.color.rgb = _rgb(color)

    def _chrome(self, slide, title: str | None, notes: str | None):
        """Gabarit des diapositives de contenu : titre, filet d'accent, pied de page."""
        t = self.theme
        if title:
            self._text(slide, MARGIN, Inches(0.45), self.width - 2 * MARGIN, Inches(0.9), title, size=30, color=t.primary, bold=True, font=t.headings, anchor=MSO_ANCHOR.BOTTOM)
            self._rect(slide, MARGIN, Inches(1.42), Inches(0.9), Inches(0.06), t.accent)
        if self.footer or self.numbers:
            y = self.height - Inches(0.48)
            if self.footer:
                self._text(slide, MARGIN, y, Inches(8), Inches(0.3), self.footer, size=10, color=t.muted)
            if self.numbers:
                self._text(slide, self.width - MARGIN - Inches(1), y, Inches(1), Inches(0.3), str(self.count), size=10, color=t.muted, align=PP_ALIGN.RIGHT)
        if t.logo and os.path.exists(t.logo):
            self._picture(slide, t.logo, self.width - MARGIN - Inches(1.4), Inches(0.42), Inches(1.4), Inches(0.55))
        self._notes(slide, notes)

    def _notes(self, slide, notes):
        if notes:
            slide.notes_slide.notes_text_frame.text = notes

    def _picture(self, slide, path, x, y, w, h):
        """Image ajustée dans le cadre, proportions gardées, centrée."""
        with Image.open(path) as image:
            ratio = image.width / image.height
        if w / h > ratio:
            width, height = int(h * ratio), h
        else:
            width, height = w, int(w / ratio)
        return slide.shapes.add_picture(path, x + (w - width) // 2, y + (h - height) // 2, width, height)

    @property
    def _content(self):
        """Zone de contenu (sous le titre, au-dessus du pied de page)."""
        return MARGIN, Inches(1.75), self.width - 2 * MARGIN, self.height - Inches(1.75) - Inches(0.8)

    def _bullet_lines(self, frame, items, size, level=0, first=True):
        t = self.theme
        for item in items:
            text, children = (item if isinstance(item, tuple) else (item, []))
            paragraph = frame.paragraphs[0] if first else frame.add_paragraph()
            first = False
            paragraph.level = min(level, 4)
            paragraph.space_after = Pt(size * (0.55 if level == 0 else 0.3))
            paragraph.line_spacing = 1.08
            marker = paragraph.add_run()
            marker.text = ("■  " if level == 0 else "–  ")
            self._style(marker.font, size * (0.6 if level == 0 else 0.9), t.accent if level == 0 else t.muted)
            run = paragraph.add_run()
            run.text = str(text)
            self._style(run.font, size if level == 0 else size - 2, t.text if level == 0 else t.muted)
            if children:
                first = self._bullet_lines(frame, children, size, level + 1, first=False)
        return first

    # ---- diapositives -----------------------------------------------------------

    def title_slide(self, title: str, subtitle: str = "", note: str = "", notes: str | None = None):
        """Couverture : fond dominant, titre en grand, sous-titre, mention (date, auteur)."""
        t = self.theme
        slide = self._blank()
        self._rect(slide, 0, 0, self.width, self.height, t.primary)
        self._rect(slide, 0, self.height - Inches(0.22), self.width, Inches(0.22), t.accent)
        self._rect(slide, MARGIN, Inches(2.55), Inches(1.1), Inches(0.08), t.highlight)
        ink = on(t.primary)
        self._text(slide, MARGIN, Inches(2.8), self.width - 2 * MARGIN, Inches(1.9), title, size=46 if len(title) < 45 else 36, color=ink, bold=True, font=t.headings, anchor=MSO_ANCHOR.TOP, spacing=1.0)
        if subtitle:
            self._text(slide, MARGIN, Inches(4.75), self.width - 2 * MARGIN, Inches(1), subtitle, size=22, color=lighten(t.primary, 0.75) if ink == "#FFFFFF" else t.muted)
        if note:
            self._text(slide, MARGIN, self.height - Inches(1.05), Inches(9), Inches(0.5), note, size=13, color=lighten(t.primary, 0.6) if ink == "#FFFFFF" else t.muted)
        if t.logo and os.path.exists(t.logo):
            self._picture(slide, t.logo, self.width - MARGIN - Inches(2), Inches(0.6), Inches(2), Inches(0.8))
        self._notes(slide, notes)
        return slide

    def section(self, title: str, number: int | str | None = None, subtitle: str = "", notes: str | None = None):
        """Intercalaire : grand numéro d'accent, titre de partie."""
        t = self.theme
        slide = self._blank()
        self._rect(slide, 0, 0, self.width, self.height, t.primary)
        ink = on(t.primary)
        if number is not None:
            label = f"{number:02d}" if isinstance(number, int) else str(number)
            self._text(slide, MARGIN, Inches(1.9), Inches(4), Inches(1.6), label, size=88, color=t.accent if on(t.primary) == "#FFFFFF" else t.primary, bold=True, font=t.headings)
        self._text(slide, MARGIN, Inches(3.6), self.width - 2 * MARGIN, Inches(1.4), title, size=40, color=ink, bold=True, font=t.headings)
        if subtitle:
            self._text(slide, MARGIN, Inches(4.95), self.width - 2 * MARGIN, Inches(0.9), subtitle, size=20, color=lighten(t.primary, 0.7))
        self._notes(slide, notes)
        return slide

    def bullets(self, title: str, items: list, notes: str | None = None, aside: str | None = None):
        """Liste à puces ; un élément peut être (texte, [sous-points]). aside : encadré à droite (chiffre, idée forte)."""
        t = self.theme
        slide = self._blank()
        self._chrome(slide, title, notes)
        x, y, w, h = self._content
        length = sum(len(str(i[0] if isinstance(i, tuple) else i)) + sum(len(str(c)) for c in (i[1] if isinstance(i, tuple) else [])) for i in items)
        if aside:
            w_text = int(w * 0.62)
            panel = self._rect(slide, x + w_text + Inches(0.4), y, w - w_text - Inches(0.4), h, t.light, MSO_SHAPE.ROUNDED_RECTANGLE, 0.06)
            panel_frame = panel.text_frame
            panel_frame.word_wrap = True
            panel_frame.margin_left = panel_frame.margin_right = Inches(0.35)
            panel_frame.vertical_anchor = MSO_ANCHOR.MIDDLE
            paragraph = panel_frame.paragraphs[0]
            run = paragraph.add_run()
            run.text = aside
            self._style(run.font, 24 if len(aside) < 80 else 18, t.primary, bold=True, family=t.headings)
            w = w_text
        box = slide.shapes.add_textbox(x, y, w, h)
        frame = box.text_frame
        frame.word_wrap = True
        self._bullet_lines(frame, items, _size_for(length * (1.4 if aside else 1)))
        return slide

    def two_columns(self, title: str, left: list | str, right: list | str, left_title: str | None = None, right_title: str | None = None, notes: str | None = None):
        """Deux colonnes (comparaison, avant/après, avantages/limites)."""
        t = self.theme
        slide = self._blank()
        self._chrome(slide, title, notes)
        x, y, w, h = self._content
        gap = Inches(0.5)
        col = (w - gap) // 2
        for index, (content, heading) in enumerate(((left, left_title), (right, right_title))):
            cx = x + index * (col + gap)
            top = y
            if heading:
                self._rect(slide, cx, top, col, Inches(0.55), t.primary if index == 0 else t.accent, MSO_SHAPE.ROUNDED_RECTANGLE, 0.15)
                self._text(slide, cx + Inches(0.2), top, col - Inches(0.4), Inches(0.55), heading, size=16, color=on(t.primary if index == 0 else t.accent), bold=True, anchor=MSO_ANCHOR.MIDDLE)
                top += Inches(0.75)
            box = slide.shapes.add_textbox(cx, top, col, h - (top - y))
            box.text_frame.word_wrap = True
            if isinstance(content, str):
                paragraph = box.text_frame.paragraphs[0]
                run = paragraph.add_run()
                run.text = content
                self._style(run.font, _size_for(len(content), ((500, 14), (300, 16), (0, 18))), t.text)
            else:
                length = sum(len(str(i[0] if isinstance(i, tuple) else i)) for i in content)
                self._bullet_lines(box.text_frame, content, _size_for(length * 2, ((900, 14), (500, 16), (0, 18))))
        return slide

    def kpis(self, title: str, items: list[tuple], notes: str | None = None, caption: str | None = None):
        """Chiffres clés en cartes : [(« 18 % », « croissance »), (« 4,2 M€ », « chiffre d'affaires », « +12 % vs 2025 »)]."""
        t = self.theme
        slide = self._blank()
        self._chrome(slide, title, notes)
        x, y, w, h = self._content
        count = max(1, min(len(items), 4))
        rows = (len(items) + count - 1) // count
        gap = Inches(0.35)
        card_w = (w - gap * (count - 1)) // count
        room = h - (Inches(0.6) if caption else 0)
        card_h = min(Inches(2.6), (room - gap * (rows - 1)) // rows)
        # Cartes centrées verticalement : pas de grand vide sous une seule rangée.
        y += max(0, (room - (card_h * rows + gap * (rows - 1))) // 2)
        for index, item in enumerate(items):
            value, label, *rest = item
            row, col = divmod(index, count)
            cx, cy = x + col * (card_w + gap), y + row * (card_h + gap)
            self._rect(slide, cx, cy, card_w, card_h, t.light, MSO_SHAPE.ROUNDED_RECTANGLE, 0.08)
            self._rect(slide, cx, cy, Inches(0.09), card_h, t.chart[index % len(t.chart)])
            self._text(slide, cx + Inches(0.35), cy + Inches(0.3), card_w - Inches(0.5), Inches(1.1), str(value), size=40 if len(str(value)) < 8 else 30, color=t.primary, bold=True, font=t.headings)
            self._text(slide, cx + Inches(0.35), cy + Inches(1.35), card_w - Inches(0.5), Inches(0.6), str(label), size=15, color=t.text)
            if rest:
                self._text(slide, cx + Inches(0.35), cy + Inches(1.85), card_w - Inches(0.5), Inches(0.5), str(rest[0]), size=12, color=t.accent, bold=True)
        if caption:
            self._text(slide, x, y + h - Inches(0.5), w, Inches(0.5), caption, size=12, color=t.muted, italic=True)
        return slide

    def chart(self, title: str, kind: str, categories: list, series: dict[str, list[float]], notes: str | None = None, number_format: str = '#,##0', labels: bool = True, takeaway: str | None = None):
        """Graphique natif (modifiable dans PowerPoint) : column, stacked, bar, line, area, pie, doughnut.
        takeaway : la conclusion à lire, affichée à droite du graphique."""
        t = self.theme
        if kind not in CHART_TYPES:
            raise ValueError(f"Type de graphique inconnu : {kind!r}. Choix : {', '.join(CHART_TYPES)}")
        slide = self._blank()
        self._chrome(slide, title, notes)
        x, y, w, h = self._content
        data = CategoryChartData()
        data.categories = [str(c) for c in categories]
        for name, values in series.items():
            data.add_series(str(name), [float(v) if v is not None else None for v in values])
        chart_w = int(w * 0.68) if takeaway else w
        frame = slide.shapes.add_chart(CHART_TYPES[kind], x, y, chart_w, h, data)
        chart = frame.chart
        chart.font.name = t.font
        chart.font.size = Pt(12)
        chart.font.color.rgb = _rgb(t.muted)
        multi = len(series) > 1 or kind in ("pie", "doughnut")
        chart.has_legend = multi
        if multi:
            chart.legend.position = XL_LEGEND_POSITION.BOTTOM if kind not in ("pie", "doughnut") else XL_LEGEND_POSITION.RIGHT
            chart.legend.include_in_layout = False
            chart.legend.font.size = Pt(12)
        plot = chart.plots[0]
        if kind in ("pie", "doughnut"):
            for index, point in enumerate(plot.series[0].points):
                point.format.fill.solid()
                point.format.fill.fore_color.rgb = _rgb(t.chart[index % len(t.chart)])
                point.format.line.color.rgb = _rgb("#FFFFFF")
        else:
            for index, item in enumerate(plot.series):
                color = _rgb(t.chart[index % len(t.chart)])
                if kind in ("line",):
                    item.format.line.color.rgb = color
                    item.format.line.width = Pt(3)
                    item.smooth = False
                    item.marker.format.fill.solid()
                    item.marker.format.fill.fore_color.rgb = color
                    item.marker.format.line.color.rgb = color
                else:
                    item.format.fill.solid()
                    item.format.fill.fore_color.rgb = color
            if kind in ("column", "bar", "stacked"):
                plot.gap_width = 70
                if kind == "stacked":
                    plot.overlap = 100
            value_axis = chart.value_axis
            value_axis.has_major_gridlines = True
            value_axis.major_gridlines.format.line.color.rgb = _rgb(t.border)
            value_axis.format.line.fill.background()
            value_axis.tick_labels.number_format = number_format
            value_axis.tick_labels.number_format_is_linked = False
            chart.category_axis.format.line.color.rgb = _rgb(t.border)
            chart.category_axis.tick_labels.font.size = Pt(12)
        if labels and (len(series) == 1 or kind in ("pie", "doughnut")):
            plot.has_data_labels = True
            labels_ = plot.data_labels
            labels_.font.size = Pt(11)
            labels_.font.bold = kind in ("pie", "doughnut")
            if kind in ("pie", "doughnut"):
                labels_.number_format = '0%'
                labels_.number_format_is_linked = False
                labels_.show_percentage = True
                labels_.show_value = False
                labels_.font.color.rgb = _rgb("#FFFFFF")
            else:
                labels_.number_format = number_format
                labels_.number_format_is_linked = False
                labels_.font.color.rgb = _rgb(t.text)
                if kind in ("column", "bar"):
                    labels_.position = XL_LABEL_POSITION.OUTSIDE_END
        if takeaway:
            px = x + chart_w + Inches(0.4)
            panel = self._rect(slide, px, y + Inches(0.3), w - chart_w - Inches(0.4), h - Inches(0.6), t.light, MSO_SHAPE.ROUNDED_RECTANGLE, 0.06)
            frame_ = panel.text_frame
            frame_.word_wrap = True
            frame_.margin_left = frame_.margin_right = Inches(0.3)
            frame_.vertical_anchor = MSO_ANCHOR.MIDDLE
            run = frame_.paragraphs[0].add_run()
            run.text = takeaway
            self._style(run.font, 20 if len(takeaway) < 90 else 16, t.primary, bold=True, family=t.headings)
        return slide

    def table(self, title: str, rows: list[list], header: bool = True, notes: str | None = None, widths: list[float] | None = None, align: list[str] | None = None):
        """Tableau : en-tête à la couleur dominante, lignes alternées. align : « l », « c » ou « r » par colonne."""
        t = self.theme
        slide = self._blank()
        self._chrome(slide, title, notes)
        x, y, w, h = self._content
        rows = [[("" if v is None else str(v)) for v in row] for row in rows]
        count, cols = len(rows), max(len(r) for r in rows)
        row_h = min(Inches(0.55), h // max(1, count))
        frame = slide.shapes.add_table(count, cols, x, y, w, row_h * count)
        table = frame.table
        size = 14 if count <= 8 else 12 if count <= 13 else 10
        total = sum(widths) if widths else cols
        for c in range(cols):
            table.columns[c].width = int(w * ((widths[c] if widths else 1) / total))
        for r, row in enumerate(rows):
            table.rows[r].height = row_h
            for c in range(cols):
                cell = table.cell(r, c)
                cell.text = row[c] if c < len(row) else ""
                is_header = header and r == 0
                cell.fill.solid()
                cell.fill.fore_color.rgb = _rgb(t.primary if is_header else (t.light if r % 2 == 0 else "#FFFFFF"))
                cell.margin_left = cell.margin_right = Inches(0.12)
                cell.vertical_anchor = MSO_ANCHOR.MIDDLE
                for paragraph in cell.text_frame.paragraphs:
                    side = (align[c] if align and c < len(align) else ("r" if _numeric(row[c] if c < len(row) else "") and not is_header else "l"))
                    paragraph.alignment = {"l": PP_ALIGN.LEFT, "c": PP_ALIGN.CENTER, "r": PP_ALIGN.RIGHT}[side]
                    for run in paragraph.runs:
                        self._style(run.font, size, on(t.primary) if is_header else t.text, bold=is_header)
        return slide

    def image(self, title: str | None, path: str, caption: str | None = None, notes: str | None = None, full: bool = False):
        """Image (photo, schéma, image créée) ajustée sans déformation ; full=True : pleine page."""
        t = self.theme
        slide = self._blank()
        if full:
            self._picture(slide, path, 0, 0, self.width, self.height)
            self._notes(slide, notes)
            return slide
        self._chrome(slide, title, notes)
        x, y, w, h = self._content
        self._picture(slide, path, x, y, w, h - (Inches(0.5) if caption else 0))
        if caption:
            self._text(slide, x, y + h - Inches(0.4), w, Inches(0.4), caption, size=12, color=t.muted, italic=True, align=PP_ALIGN.CENTER)
        return slide

    def image_text(self, title: str, path: str, items: list | str, notes: str | None = None, image_left: bool = True):
        """Image d'un côté, texte (ou puces) de l'autre."""
        t = self.theme
        slide = self._blank()
        self._chrome(slide, title, notes)
        x, y, w, h = self._content
        half = (w - Inches(0.5)) // 2
        image_x, text_x = (x, x + half + Inches(0.5)) if image_left else (x + half + Inches(0.5), x)
        self._picture(slide, path, image_x, y, half, h)
        box = slide.shapes.add_textbox(text_x, y, half, h)
        box.text_frame.word_wrap = True
        box.text_frame.vertical_anchor = MSO_ANCHOR.MIDDLE
        if isinstance(items, str):
            run = box.text_frame.paragraphs[0].add_run()
            run.text = items
            self._style(run.font, _size_for(len(items), ((450, 15), (250, 17), (0, 20))), t.text)
        else:
            self._bullet_lines(box.text_frame, items, _size_for(sum(len(str(i)) for i in items) * 2, ((800, 14), (450, 16), (0, 18))))
        return slide

    def quote(self, text: str, author: str = "", notes: str | None = None):
        """Citation mise en valeur."""
        t = self.theme
        slide = self._blank()
        self._rect(slide, 0, 0, self.width, self.height, t.light)
        self._text(slide, MARGIN, Inches(0.9), Inches(2), Inches(2), "“", size=160, color=t.accent, bold=True, font="Georgia")
        self._text(slide, Inches(1.6), Inches(2.3), self.width - Inches(3.2), Inches(3), text, size=32 if len(text) < 140 else 24, color=t.primary, italic=True, font=t.headings, spacing=1.15)
        if author:
            self._text(slide, Inches(1.6), Inches(5.5), self.width - Inches(3.2), Inches(0.6), f"— {author}", size=18, color=t.muted)
        self._notes(slide, notes)
        return slide

    def timeline(self, title: str, steps: list[tuple[str, str] | tuple[str, str, str]], notes: str | None = None):
        """Frise : [(« T1 2026 », « Lancement », « détail facultatif »), …] — 2 à 7 étapes."""
        t = self.theme
        slide = self._blank()
        self._chrome(slide, title, notes)
        x, y, w, h = self._content
        count = max(1, len(steps))
        line_y = y + Inches(1.6)
        self._rect(slide, x, line_y, w, Inches(0.05), t.border)
        step_w = w // count
        for index, step in enumerate(steps):
            when, what, *detail = step
            cx = x + index * step_w
            center = cx + step_w // 2
            color = t.chart[index % len(t.chart)]
            self._rect(slide, center - Inches(0.16), line_y - Inches(0.135), Inches(0.32), Inches(0.32), color, MSO_SHAPE.OVAL)
            self._text(slide, cx, y + Inches(0.6), step_w, Inches(0.7), when, size=16, color=color, bold=True, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.BOTTOM)
            self._text(slide, cx + Inches(0.1), line_y + Inches(0.45), step_w - Inches(0.2), Inches(0.8), what, size=16, color=t.primary, bold=True, align=PP_ALIGN.CENTER)
            if detail:
                self._text(slide, cx + Inches(0.1), line_y + Inches(1.15), step_w - Inches(0.2), Inches(1.8), detail[0], size=12, color=t.muted, align=PP_ALIGN.CENTER)
        return slide

    def steps(self, title: str, items: list[tuple[str, str]], notes: str | None = None):
        """Étapes numérotées en cartes (processus, méthode) : [(« Diagnostiquer », « 2 semaines d'entretiens »), …]."""
        t = self.theme
        slide = self._blank()
        self._chrome(slide, title, notes)
        x, y, w, h = self._content
        count = max(1, min(len(items), 5))
        gap = Inches(0.3)
        card_w = (w - gap * (count - 1)) // count
        for index, (name, detail) in enumerate(items[:5]):
            cx = x + index * (card_w + gap)
            self._rect(slide, cx, y, card_w, h - Inches(0.2), t.light, MSO_SHAPE.ROUNDED_RECTANGLE, 0.05)
            circle = self._rect(slide, cx + Inches(0.3), y + Inches(0.35), Inches(0.75), Inches(0.75), t.chart[index % len(t.chart)], MSO_SHAPE.OVAL)
            frame = circle.text_frame
            run = frame.paragraphs[0].add_run()
            run.text = str(index + 1)
            frame.paragraphs[0].alignment = PP_ALIGN.CENTER
            frame.vertical_anchor = MSO_ANCHOR.MIDDLE
            self._style(run.font, 20, "#FFFFFF", bold=True)
            self._text(slide, cx + Inches(0.3), y + Inches(1.35), card_w - Inches(0.5), Inches(0.9), name, size=18, color=t.primary, bold=True, font=t.headings)
            self._text(slide, cx + Inches(0.3), y + Inches(2.25), card_w - Inches(0.5), h - Inches(2.6), detail, size=13 if len(detail) > 140 else 14, color=t.text)
        return slide

    def closing(self, title: str = "Merci", subtitle: str = "", notes: str | None = None):
        """Dernière diapositive (remerciements, contact, prochaine étape)."""
        return self.title_slide(title, subtitle, notes=notes)

    def layout_slide(self, layout: str | int, notes: str | None = None, **fields):
        """Diapositive d'une mise en page du MODÈLE, ses espaces réservés remplis :
        title=…, subtitle=…, body=[puces] ou texte, picture=chemin ; ou par numéro : ph_1=…
        Noms des mises en page : layouts()."""
        layouts = list(self.prs.slide_layouts)
        if isinstance(layout, int):
            chosen = layouts[layout]
        else:
            matches = [l for l in layouts if l.name.lower() == layout.lower()] or [l for l in layouts if layout.lower() in l.name.lower()]
            if not matches:
                raise ValueError(f"Mise en page introuvable : {layout!r}. Disponibles : {self.layouts()}")
            chosen = matches[0]
        slide = self.prs.slides.add_slide(chosen)
        self.count += 1
        from pptx.enum.shapes import PP_PLACEHOLDER

        kinds = {
            "title": (PP_PLACEHOLDER.TITLE, PP_PLACEHOLDER.CENTER_TITLE),
            "subtitle": (PP_PLACEHOLDER.SUBTITLE,),
            "body": (PP_PLACEHOLDER.BODY, PP_PLACEHOLDER.OBJECT),
            "picture": (PP_PLACEHOLDER.PICTURE,),
        }
        used = set()
        for key, value in fields.items():
            target = None
            if key.startswith("ph_"):
                idx = int(key[3:])
                target = next((p for p in slide.placeholders if p.placeholder_format.idx == idx), None)
            else:
                target = next((p for p in slide.placeholders if p.placeholder_format.type in kinds.get(key, ()) and p.placeholder_format.idx not in used), None)
            if target is None:
                raise ValueError(f"Espace réservé « {key} » absent de la mise en page {chosen.name!r}.")
            used.add(target.placeholder_format.idx)
            if key == "picture" or (isinstance(value, str) and os.path.isfile(value) and value.lower().endswith((".png", ".jpg", ".jpeg"))):
                target.insert_picture(value)
            elif isinstance(value, list):
                frame = target.text_frame
                for index, item in enumerate(value):
                    text, children = item if isinstance(item, tuple) else (item, [])
                    paragraph = frame.paragraphs[0] if index == 0 else frame.add_paragraph()
                    paragraph.text = str(text)
                    for child in children:
                        sub = frame.add_paragraph()
                        sub.text = str(child)
                        sub.level = 1
            else:
                target.text = str(value)
        self._notes(slide, notes)
        return slide

    def layouts(self) -> list[str]:
        """Noms des mises en page disponibles (utile avec un modèle)."""
        return [l.name for l in self.prs.slide_layouts]

    def save(self, path: str = "presentation.pptx") -> str:
        if not path.lower().endswith(".pptx"):
            path += ".pptx"
        self.prs.core_properties.title = self.title or ""
        self.prs.save(path)
        return path


def _numeric(text: str) -> bool:
    cleaned = text.replace(" ", "").replace(" ", "").replace(",", ".").rstrip("%€$").lstrip("+-")
    try:
        float(cleaned)
        return bool(cleaned)
    except ValueError:
        return False

