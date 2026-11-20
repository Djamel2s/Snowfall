"""Graphiques en image (rapports Word, PDF) aux couleurs du thème, nets à l'impression."""

from __future__ import annotations

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib import font_manager  # noqa: E402
from matplotlib.ticker import FuncFormatter  # noqa: E402

from .theme import Theme  # noqa: E402

KINDS = ("bar", "column", "stacked", "line", "area", "pie", "doughnut")


def _font(theme: Theme) -> str:
    # Calibri n'existe pas ici : Carlito a les mêmes mesures. Sinon, la police demandée si elle est installée.
    wanted = {"Calibri": "Carlito", "Cambria": "Caladea"}.get(theme.font, theme.font)
    try:
        font_manager.findfont(wanted, fallback_to_default=False)
        return wanted
    except ValueError:
        return "DejaVu Sans"


def _number(value: float, unit: str = "") -> str:
    if abs(value) >= 1_000_000:
        text = f"{value / 1_000_000:.1f} M".replace(".0 ", " ")
    elif abs(value) >= 10_000:
        text = f"{value / 1_000:.0f} k"
    elif float(value).is_integer():
        text = f"{int(value):,}".replace(",", " ")
    else:
        text = f"{value:,.1f}".replace(",", " ").replace(".", ",")
    return f"{text}{unit}".replace(".", ",")


def chart_png(
    path: str,
    kind: str,
    categories: list,
    series: dict[str, list[float]],
    theme: Theme | None = None,
    title: str | None = None,
    unit: str = "",
    size: tuple[float, float] = (8, 4.5),
    labels: bool = True,
) -> str:
    """Enregistre un graphique PNG (200 dpi). kind : bar, column, stacked, line, area, pie, doughnut."""
    theme = theme or Theme()
    if kind not in KINDS:
        raise ValueError(f"Type de graphique inconnu : {kind!r}. Choix : {', '.join(KINDS)}")
    colors = list(theme.chart)
    plt.rcParams.update({"font.family": _font(theme), "font.size": 11, "axes.titleweight": "bold", "axes.titlesize": 14})
    fig, ax = plt.subplots(figsize=size, dpi=200)
    fig.patch.set_facecolor("white")
    names = list(series)
    if kind in ("pie", "doughnut"):
        values = series[names[0]]
        wedges, *_ = ax.pie(
            values,
            colors=colors[: len(values)],
            startangle=90,
            counterclock=False,
            wedgeprops={"width": 0.42 if kind == "doughnut" else 1, "edgecolor": "white", "linewidth": 2},
            autopct=(lambda pct: f"{pct:.0f} %") if labels else None,
            pctdistance=0.79 if kind == "doughnut" else 0.62,
            textprops={"color": "white", "fontsize": 11, "fontweight": "bold"},
        )
        ax.legend(wedges, categories, loc="center left", bbox_to_anchor=(1, 0.5), frameon=False)
        ax.set_aspect("equal")
    else:
        positions = range(len(categories))
        width = 0.8 / (1 if kind == "stacked" else max(1, len(names)))
        bottoms = [0.0] * len(categories)
        for index, name in enumerate(names):
            values = series[name]
            color = colors[index % len(colors)]
            if kind in ("bar", "column", "stacked"):
                offset = 0 if kind == "stacked" else (index - (len(names) - 1) / 2) * width
                at = [p + offset for p in positions]
                draw = ax.barh if kind == "bar" else ax.bar
                stacked = {"bottom": bottoms} if kind == "stacked" else {}
                bars = draw(at, values, width * 0.92, label=name, color=color, **stacked)
                if labels and kind != "stacked":
                    ax.bar_label(bars, labels=[_number(v, unit) for v in values], padding=3, fontsize=9.5, color=theme.muted)
                if kind == "stacked":
                    bottoms = [b + v for b, v in zip(bottoms, values)]
            else:
                ax.plot(list(positions), values, label=name, color=color, linewidth=2.6, marker="o", markersize=5)
                if kind == "area":
                    ax.fill_between(list(positions), values, alpha=0.18, color=color)
                if labels and len(names) == 1:
                    for p, v in zip(positions, values):
                        ax.annotate(_number(v, unit), (p, v), textcoords="offset points", xytext=(0, 8), ha="center", fontsize=9.5, color=theme.muted)
        if kind == "bar":
            ax.set_yticks(list(positions), [str(c) for c in categories])
            ax.invert_yaxis()
            ax.xaxis.set_major_formatter(FuncFormatter(lambda v, _: _number(v, unit)))
            ax.grid(axis="x", color=theme.border, linewidth=0.8)
        else:
            ax.set_xticks(list(positions), [str(c) for c in categories])
            ax.yaxis.set_major_formatter(FuncFormatter(lambda v, _: _number(v, unit)))
            ax.grid(axis="y", color=theme.border, linewidth=0.8)
        ax.set_axisbelow(True)
        for side in ("top", "right", "left" if kind != "bar" else "bottom"):
            ax.spines[side].set_visible(False)
        for side in ax.spines.values():
            side.set_color(theme.border)
        ax.tick_params(colors=theme.muted, length=0)
        if len(names) > 1:
            ax.legend(frameon=False, loc="upper center", bbox_to_anchor=(0.5, -0.1), ncol=min(4, len(names)))
    if title:
        ax.set_title(title, loc="left", color=theme.primary, pad=14)
    fig.tight_layout()
    fig.savefig(path, dpi=200, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    return path
