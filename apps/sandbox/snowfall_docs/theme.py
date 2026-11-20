"""Thèmes : palettes, polices et utilitaires de couleur partagés par tous les formats."""

from __future__ import annotations

import colorsys
import re
import zipfile
from dataclasses import dataclass, replace

HEX = re.compile(r"^#?([0-9a-fA-F]{6})$")


def hex_color(value: str) -> str:
    """« #2F80ED » ou « 2f80ed » → « 2F80ED » (format des bibliothèques Office)."""
    match = HEX.match(value.strip())
    if not match:
        raise ValueError(f"Couleur invalide : {value!r} (attendu : #RRGGBB)")
    return match.group(1).upper()


def rgb(value: str) -> tuple[int, int, int]:
    code = hex_color(value)
    return int(code[0:2], 16), int(code[2:4], 16), int(code[4:6], 16)


def mix(color: str, other: str, amount: float) -> str:
    """Mélange deux couleurs (0 : la première, 1 : la seconde)."""
    a, b = rgb(color), rgb(other)
    return "#" + "".join(f"{round(x + (y - x) * amount):02X}" for x, y in zip(a, b))


def lighten(color: str, amount: float) -> str:
    return mix(color, "#FFFFFF", amount)


def darken(color: str, amount: float) -> str:
    return mix(color, "#000000", amount)


def luminance(color: str) -> float:
    def channel(c: int) -> float:
        c = c / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (channel(c) for c in rgb(color))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def on(color: str) -> str:
    """Couleur de texte lisible sur ce fond (contraste WCAG)."""
    return "#FFFFFF" if luminance(color) < 0.42 else "#111827"


@dataclass(frozen=True)
class Theme:
    """Palette et typographie d'un document.

    primary   : couleur dominante (titres, bandeaux, en-têtes de tableau)
    accent    : couleur d'action (puces, chiffres clés, liens, filets)
    highlight : contrepoint (mise en avant ponctuelle)
    text, muted, light, border : texte, texte secondaire, fonds clairs, filets
    chart     : couleurs des séries de graphiques, dans l'ordre
    font, heading_font : polices (Calibri : présente dans Office ; en PDF,
                Carlito a les mêmes mesures, la mise en page ne bouge pas)
    """

    name: str = "snowfall"
    primary: str = "#16325C"
    accent: str = "#2F80ED"
    highlight: str = "#F2994A"
    text: str = "#1F2937"
    muted: str = "#6B7280"
    light: str = "#F3F6FA"
    border: str = "#D9E1EC"
    chart: tuple[str, ...] = ("#2F80ED", "#16325C", "#56CCF2", "#F2994A", "#27AE60", "#9B51E0", "#EB5757")
    font: str = "Calibri"
    heading_font: str | None = None
    logo: str | None = None

    @property
    def headings(self) -> str:
        return self.heading_font or self.font

    def with_(self, **changes) -> "Theme":
        return replace(self, **changes)

    @staticmethod
    def preset(name: str) -> "Theme":
        """Thème prêt à l'emploi : voir PALETTES (snowfall, ocean, graphite, forest, sunset, royal, minimal).
        Un nom inventé (« corporate », « blue »…) donne le thème le plus proche, signalé dans la sortie."""
        key = name.strip().lower()
        if key in PALETTES:
            return PALETTES[key]
        chosen = ALIASES.get(key, "snowfall")
        print(f"[snowfall_docs] Thème {name!r} inconnu : {chosen!r} utilisé. Choix : {', '.join(PALETTES)}")
        return PALETTES[chosen]

    @staticmethod
    def from_color(color: str, name: str = "marque", font: str = "Calibri") -> "Theme":
        """Thème construit à partir d'une couleur de marque : dominante foncée, accent, contrepoint complémentaire."""
        r, g, b = (c / 255 for c in rgb(color))
        h, l, s = colorsys.rgb_to_hls(r, g, b)

        def hls(hue: float, light: float, sat: float) -> str:
            return "#" + "".join(f"{round(c * 255):02X}" for c in colorsys.hls_to_rgb(hue % 1, max(0, min(1, light)), max(0, min(1, sat))))

        accent = "#" + hex_color(color)
        primary = hls(h, min(l, 0.24), min(1, s * 0.9 + 0.1))
        highlight = hls(h + 0.5, 0.55, max(0.55, s))
        chart = (accent, primary, hls(h, 0.68, s), highlight, hls(h + 0.33, 0.45, 0.55), hls(h + 0.66, 0.5, 0.5), hls(h + 0.15, 0.5, 0.6))
        return Theme(name=name, primary=primary, accent=accent, highlight=highlight, light=hls(h, 0.97, min(0.6, s)), border=hls(h, 0.88, min(0.35, s)), chart=chart, font=font)

    @staticmethod
    def from_template(path: str) -> "Theme":
        """Couleurs et polices d'un modèle Office (.pptx, .docx, .xlsx, .potx, .dotx) : celles de son thème."""
        with zipfile.ZipFile(path) as archive:
            names = [n for n in archive.namelist() if re.match(r"^(ppt|word|xl)/theme/theme\d*\.xml$", n)]
            if not names:
                return PALETTES["snowfall"]
            xml = archive.read(sorted(names)[0]).decode("utf-8", "replace")

        def scheme(slot: str) -> str | None:
            block = re.search(rf"<a:{slot}>(.*?)</a:{slot}>", xml, re.S)
            if not block:
                return None
            found = re.search(r'(?:srgbClr val|lastClr)="([0-9A-Fa-f]{6})"', block.group(1))
            return f"#{found.group(1).upper()}" if found else None

        def typeface(kind: str) -> str | None:
            block = re.search(rf"<a:{kind}>(.*?)</a:{kind}>", xml, re.S)
            found = re.search(r'<a:latin typeface="([^"]+)"', block.group(1)) if block else None
            return found.group(1) if found and not found.group(1).startswith("+") else None

        base = PALETTES["snowfall"]
        accents = [c for c in (scheme(f"accent{i}") for i in range(1, 7)) if c]
        dark = scheme("dk2") or scheme("dk1") or base.primary
        primary = dark if luminance(dark) < 0.3 else (accents[0] if accents else base.primary)
        accent = accents[0] if accents else base.accent
        return Theme(
            name="modèle",
            primary=primary,
            accent=accent,
            highlight=accents[1] if len(accents) > 1 else base.highlight,
            text=scheme("dk1") or base.text,
            light=lighten(accent, 0.92),
            border=lighten(accent, 0.75),
            chart=tuple(accents) or base.chart,
            font=typeface("minorFont") or base.font,
            heading_font=typeface("majorFont"),
        )


PALETTES: dict[str, Theme] = {
    "snowfall": Theme(),
    "ocean": Theme(
        name="ocean", primary="#0B3954", accent="#0889A8", highlight="#FF9F1C", light="#EEF7FA", border="#CFE6EE",
        chart=("#0889A8", "#0B3954", "#5BC0DE", "#FF9F1C", "#2EC4B6", "#8E7DBE", "#E71D36"),
    ),
    "graphite": Theme(
        name="graphite", primary="#111827", accent="#4F46E5", highlight="#F43F5E", light="#F4F4F6", border="#E2E3E8",
        chart=("#4F46E5", "#111827", "#818CF8", "#F43F5E", "#10B981", "#F59E0B", "#06B6D4"),
    ),
    "forest": Theme(
        name="forest", primary="#1B4332", accent="#2D9F6A", highlight="#D4A373", light="#F1F7F3", border="#D3E6DA",
        chart=("#2D9F6A", "#1B4332", "#74C69D", "#D4A373", "#577590", "#BC6C25", "#9B2226"),
    ),
    "sunset": Theme(
        name="sunset", primary="#3D1F3A", accent="#E76F51", highlight="#2A9D8F", light="#FCF4F1", border="#F1DAD3",
        chart=("#E76F51", "#3D1F3A", "#F4A261", "#2A9D8F", "#E9C46A", "#6D597A", "#264653"),
    ),
    "royal": Theme(
        name="royal", primary="#24135F", accent="#7C3AED", highlight="#F59E0B", light="#F6F3FD", border="#E2D9F8",
        chart=("#7C3AED", "#24135F", "#A78BFA", "#F59E0B", "#10B981", "#EC4899", "#3B82F6"),
    ),
    "minimal": Theme(
        name="minimal", primary="#111111", accent="#111111", highlight="#C8102E", text="#222222", muted="#767676", light="#F5F5F5", border="#E0E0E0",
        chart=("#111111", "#767676", "#B0B0B0", "#C8102E", "#4A4A4A", "#D9D9D9", "#8C1C13"),
    ),
}

# Noms qu'un modèle invente volontiers → thème le plus proche (sinon snowfall).
ALIASES = {
    **dict.fromkeys(["corporate", "business", "professional", "professionnel", "pro", "sobre", "formal", "executive", "gray", "grey", "gris", "dark"], "graphite"),
    **dict.fromkeys(["blue", "bleu", "tech", "modern", "moderne", "navy", "marine", "default", "classic"], "ocean"),
    **dict.fromkeys(["green", "vert", "nature", "eco", "sustainable"], "forest"),
    **dict.fromkeys(["orange", "warm", "chaud", "red", "rouge", "energy"], "sunset"),
    **dict.fromkeys(["purple", "violet", "luxe", "premium", "elegant", "élégant"], "royal"),
    **dict.fromkeys(["white", "blanc", "clean", "simple", "minimalist", "minimaliste", "light"], "minimal"),
}
