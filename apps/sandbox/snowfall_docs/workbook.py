"""Classeurs Excel (.xlsx) : tableaux mis en forme, formats, totaux, graphiques natifs."""

from __future__ import annotations

import datetime as dt
from typing import Any

import xlsxwriter
from xlsxwriter.utility import xl_rowcol_to_cell

from .theme import Theme, hex_color, lighten, on
from .tolerant import tolerant

FORMATS = {
    "text": "@",
    # Motifs Excel : « , » est le séparateur de milliers de la langue de l'utilisateur (espace en français).
    "int": "#,##0",
    "number": "#,##0.00",
    "euro": "#,##0.00 €",
    "euro0": "#,##0 €",
    "percent": "0.0%",
    "date": "dd/mm/yyyy",
    "datetime": "dd/mm/yyyy hh:mm",
}
CHARTS = {"column": ("column", None), "stacked": ("column", "stacked"), "bar": ("bar", None), "line": ("line", None), "area": ("area", None), "pie": ("pie", None), "doughnut": ("doughnut", None)}


def _hex(color: str) -> str:
    return "#" + hex_color(color)


@tolerant
class Sheet:
    def __init__(self, book: "Workbook", worksheet):
        self.book = book
        self.ws = worksheet
        self.row = 0
        self.tables: dict[str, dict] = {}
        self.widths: dict[int, float] = {}

    def heading(self, title: str, subtitle: str | None = None):
        """Titre de la feuille (et sous-titre : source, période)."""
        t = self.book.theme
        self.ws.set_row(self.row, 30)
        self.ws.write(self.row, 0, title, self.book.fmt({"bold": True, "font_size": 18, "font_color": _hex(t.primary), "font_name": t.headings, "valign": "vcenter"}))
        self.row += 1
        if subtitle:
            self.ws.write(self.row, 0, subtitle, self.book.fmt({"font_size": 10, "font_color": _hex(t.muted), "italic": True}))
            self.row += 1
        self.row += 1
        return self

    def table(self, data: Any, columns: list[str] | None = None, formats: dict[str, str] | None = None, totals: dict[str, str] | list[str] | None = None, name: str | None = None, widths: dict[str, float] | None = None):
        """Tableau Excel (filtres, lignes alternées, en-tête figé) à partir de lignes ou d'un DataFrame.
        formats : {colonne: « euro » | « euro0 » | « int » | « number » | « percent » | « date » | motif Excel}.
        totals : [colonnes à sommer] ou {colonne: « sum » | « average » | « count » | « max » | « min »}."""
        t = self.book.theme
        if hasattr(data, "to_dict") and hasattr(data, "columns"):
            columns = columns or [str(c) for c in data.columns]
            rows = data.astype(object).where(data.notna(), None).values.tolist()
        else:
            rows = [list(r) for r in data]
            if columns is None:
                columns, rows = [str(c) for c in rows[0]], rows[1:]
        formats = formats or {}
        totals = {c: "sum" for c in totals} if isinstance(totals, list) else (totals or {})
        first = self.row
        last = first + len(rows) + (1 if totals else 0)
        header = self.book.fmt({"bold": True, "font_color": _hex(on(t.primary)), "bg_color": _hex(t.primary), "border": 0, "valign": "vcenter", "text_wrap": True})
        spec_columns = []
        for index, column in enumerate(columns):
            pattern = FORMATS.get(formats.get(column, ""), formats.get(column))
            if pattern is None:
                sample = next((r[index] for r in rows if index < len(r) and r[index] is not None), None)
                pattern = FORMATS["date"] if isinstance(sample, (dt.date, dt.datetime)) else None
            cell_format = self.book.fmt({"num_format": pattern} if pattern else {})
            spec = {"header": column, "header_format": header, "format": cell_format}
            if column in totals:
                spec["total_function"] = totals[column]
                spec["format"] = cell_format
            elif index == 0 and totals:
                spec["total_string"] = "Total"
            spec_columns.append(spec)
            longest = max([len(str(column))] + [len(_display(r[index])) for r in rows[:500] if index < len(r)])
            width = (widths or {}).get(column) or min(60, max(9, longest * 1.15 + 2))
            self.widths[index] = max(self.widths.get(index, 0), width)
            self.ws.set_column(index, index, self.widths[index])
        style = self.book.table_style
        name = name or f"Tableau{len(self.book.names) + 1}"
        self.ws.add_table(first, 0, last, len(columns) - 1, {
            "data": [[_value(v) for v in r] for r in rows],
            "columns": spec_columns,
            "style": style,
            "total_row": bool(totals),
            "name": name,
            "autofilter": True,
        })
        self.book.names.append(name)
        self.ws.set_row(first, 22)
        if first <= 3:
            self.ws.freeze_panes(first + 1, 0)
        self.tables[name] = {"first": first, "last_data": first + len(rows), "columns": columns}
        self.tables["last"] = self.tables[name]
        self.row = last + 2
        return self

    def chart(self, kind: str, category: str, values: list[str], title: str | None = None, table: str = "last", at: str | None = None, size: tuple[float, float] = (1.6, 1.25)):
        """Graphique natif à partir d'un tableau de la feuille : catégorie = une colonne, valeurs = des colonnes."""
        t = self.book.theme
        if kind not in CHARTS:
            raise ValueError(f"Type de graphique inconnu : {kind!r}. Choix : {', '.join(CHARTS)}")
        info = self.tables[table]
        kind_name, subtype = CHARTS[kind]
        chart = self.book.wb.add_chart({"type": kind_name, **({"subtype": subtype} if subtype else {})})
        cat = info["columns"].index(category)
        for index, column in enumerate(values):
            col = info["columns"].index(column)
            color = _hex(t.chart[index % len(t.chart)])
            series = {
                "name": [self.ws.name, info["first"], col],
                "categories": [self.ws.name, info["first"] + 1, cat, info["last_data"], cat],
                "values": [self.ws.name, info["first"] + 1, col, info["last_data"], col],
            }
            if kind in ("pie", "doughnut"):
                series["points"] = [{"fill": {"color": _hex(t.chart[i % len(t.chart)])}, "border": {"color": "#FFFFFF"}} for i in range(info["last_data"] - info["first"])]
                series["data_labels"] = {"percentage": True, "font": {"color": "#FFFFFF", "bold": True}}
            elif kind == "line":
                series["line"] = {"color": color, "width": 2.5}
                series["marker"] = {"type": "circle", "size": 6, "fill": {"color": color}, "border": {"color": color}}
            else:
                series["fill"] = {"color": color}
                series["border"] = {"none": True}
                series["gap"] = 70
            chart.add_series(series)
        chart.set_title({"name": title, "name_font": {"size": 13, "bold": True, "color": _hex(t.primary), "name": t.headings}} if title else {"none": True})
        chart.set_legend({"position": "bottom"} if len(values) > 1 or kind in ("pie", "doughnut") else {"none": True})
        if kind not in ("pie", "doughnut"):
            chart.set_y_axis({"major_gridlines": {"visible": True, "line": {"color": _hex(t.border)}}, "line": {"none": True}, "num_font": {"color": _hex(t.muted)}})
            chart.set_x_axis({"line": {"color": _hex(t.border)}, "num_font": {"color": _hex(t.muted)}})
        chart.set_chartarea({"border": {"none": True}})
        anchor = at or xl_rowcol_to_cell(info["first"], len(info["columns"]) + 1)
        self.ws.insert_chart(anchor, chart, {"x_scale": size[0], "y_scale": size[1]})
        return self

    def kpis(self, items: list[tuple]):
        """Chiffres clés en cartes sur une ligne : [(« 4,2 M€ », « Chiffre d'affaires »), …]."""
        t = self.book.theme
        value = self.book.fmt({"bold": True, "font_size": 20, "font_color": _hex(t.primary), "bg_color": _hex(t.light), "valign": "vcenter", "left": 5, "left_color": _hex(t.accent)})
        label = self.book.fmt({"font_size": 10, "font_color": _hex(t.muted), "bg_color": _hex(t.light), "left": 5, "left_color": _hex(t.accent)})
        self.ws.set_row(self.row, 32)
        for index, (amount, text, *_) in enumerate(items):
            col = index * 2
            self.ws.set_column(col, col, max(self.widths.get(col, 0), 20))
            self.ws.write(self.row, col, str(amount), value)
            self.ws.write(self.row + 1, col, str(text), label)
        self.row += 3
        return self

    def highlight(self, column: str, rule: str = "data_bar", table: str = "last"):
        """Mise en évidence d'une colonne : data_bar (barres), scale (dégradé), top (5 premiers), negative (en rouge)."""
        t = self.book.theme
        info = self.tables[table]
        col = info["columns"].index(column)
        target = (info["first"] + 1, col, info["last_data"], col)
        options = {
            "data_bar": {"type": "data_bar", "bar_color": _hex(t.accent), "bar_solid": True},
            "scale": {"type": "2_color_scale", "min_color": _hex(lighten(t.accent, 0.9)), "max_color": _hex(t.accent)},
            "top": {"type": "top", "value": 5, "format": self.book.fmt({"bold": True, "font_color": _hex(t.accent)})},
            "negative": {"type": "cell", "criteria": "<", "value": 0, "format": self.book.fmt({"font_color": "#C0392B"})},
        }[rule]
        self.ws.conditional_format(*target, options)
        return self

    def note(self, text: str):
        self.ws.write(self.row, 0, text, self.book.fmt({"italic": True, "font_color": _hex(self.book.theme.muted), "font_size": 9}))
        self.row += 2
        return self


@tolerant
class Workbook:
    """Classeur.

    wb = Workbook("ventes.xlsx", theme=Theme.preset("ocean"))
    ws = wb.sheet("Ventes")
    ws.heading("Ventes 2026", "Source : CRM, au 31 octobre")
    ws.table(df, formats={"Montant": "euro", "Marge": "percent"}, totals=["Montant"])
    ws.chart("column", "Mois", ["Montant"], title="Ventes par mois")
    ws.highlight("Marge", "scale")
    wb.save()
    """

    def __init__(self, path: str = "classeur.xlsx", theme: Theme | None = None):
        if not path.lower().endswith(".xlsx"):
            path += ".xlsx"
        self.path = path
        self.theme = theme or Theme()
        self.wb = xlsxwriter.Workbook(path, {"nan_inf_to_errors": True, "default_date_format": "dd/mm/yyyy", "strings_to_formulas": False, "strings_to_urls": False})
        self.wb.set_properties({"title": "", "author": "Snowfall"})
        self.table_style = "Table Style Light 9"
        self.names: list[str] = []
        self._formats: dict[str, Any] = {}
        self.base = {"font_name": self.theme.font, "font_size": 11, "font_color": _hex(self.theme.text)}

    def fmt(self, options: dict):
        key = repr(sorted(options.items()))
        if key not in self._formats:
            self._formats[key] = self.wb.add_format({**self.base, **options})
        return self._formats[key]

    def sheet(self, name: str) -> Sheet:
        worksheet = self.wb.add_worksheet(name[:31])
        worksheet.hide_gridlines(2)
        worksheet.set_zoom(110)
        worksheet.set_default_row(18)
        return Sheet(self, worksheet)

    def save(self) -> str:
        self.wb.close()
        return self.path


def _value(value):
    if hasattr(value, "item"):
        value = value.item()
    if hasattr(value, "to_pydatetime"):
        value = value.to_pydatetime()
    return value


def _display(value) -> str:
    if value is None:
        return ""
    if isinstance(value, float):
        return f"{value:,.2f}"
    return str(value)
