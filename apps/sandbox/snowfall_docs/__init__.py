"""snowfall_docs : présentations, rapports, classeurs et PDF soignés, dans le bac à sable.

    import snowfall_docs ; print(snowfall_docs.guide())   # mode d'emploi
"""

from .charts import chart_png
from .convert import pdf_fonts, to_pdf
from .deck import Deck
from .guide import guide
from .report import Report, fill_template, template_fields
from .theme import PALETTES, Theme
from .workbook import Workbook

__all__ = ["Deck", "PALETTES", "Report", "Theme", "Workbook", "chart_png", "fill_template", "guide", "pdf_fonts", "template_fields", "to_pdf"]
