"""Tolérance aux petites erreurs du modèle qui écrit le code.

Un modèle écrit souvent `note=` pour `notes=`, `chart_type=` pour `kind=`, ou
ajoute `author=` à une diapositive de titre. Python refuse l'appel, le modèle
relit l'erreur et recommence : une étape d'agent perdue à chaque fois (mesuré :
jusqu'à épuiser la limite d'étapes sans rien livrer). Ici :
- un nom courant (alias) ou très proche d'UN SEUL argument attendu est renommé ;
- un argument inconnu est ignoré ;
et chaque fois c'est écrit dans la sortie, pour que le modèle le sache. Un
argument obligatoire manquant reste une erreur : rien n'est inventé.
"""

from __future__ import annotations

import difflib
import functools
import inspect

# Noms qu'un modèle donne volontiers → argument réel (le premier qui existe dans la méthode).
ALIASES = {
    "chart_type": ["kind"], "type": ["kind"], "chart": ["kind"], "graph_type": ["kind"],
    "left_items": ["left"], "left_content": ["left"], "left_column": ["left"],
    "right_items": ["right"], "right_content": ["right"], "right_column": ["right"],
    "bullets": ["items"], "points": ["items"], "entries": ["items"], "kpis": ["items"], "metrics": ["items"], "events": ["steps", "items"],
    "data": ["series", "rows", "items"], "values": ["series"], "labels": ["categories"], "x": ["categories"],
    "author": ["note", "author"], "date": ["note", "when"], "speaker_notes": ["notes"],
    "takeaway": ["takeaway", "caption"], "conclusion": ["takeaway", "caption"], "message": ["takeaway", "caption"], "caption": ["caption", "takeaway"],
    "image": ["path"], "image_path": ["path"], "file": ["path"], "filename": ["path"],
    "heading": ["title"], "name": ["title"], "header": ["title"],
}


def _fix(name: str, method, positional: int, kwargs: dict) -> dict:
    parameters = inspect.signature(method).parameters
    if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in parameters.values()):
        return kwargs
    known = [p for p in parameters if p != "self"]
    # Déjà donnés par position : jamais une deuxième fois par un renommage.
    taken = set(known[:positional]) | set(kwargs)
    fixed = {}
    for key, value in kwargs.items():
        if key in known:
            fixed[key] = value
            continue
        target = next((t for t in ALIASES.get(key, []) if t in known and t not in taken and t not in fixed), None)
        if target is None:
            close = [c for c in difflib.get_close_matches(key, known, n=2, cutoff=0.75) if c not in taken and c not in fixed]
            target = close[0] if len(close) == 1 else None
        if target is None:
            print(f"[snowfall_docs] {name}() : argument {key}= ignoré (inconnu). Arguments possibles : {', '.join(known)}")
            continue
        print(f"[snowfall_docs] {name}() : {key}= compris comme {target}=")
        fixed[target] = value
    return fixed


def tolerant(cls):
    """Applique la correction aux méthodes publiques de la classe."""
    for attr, method in list(vars(cls).items()):
        if attr.startswith("_") or not inspect.isfunction(method):
            continue

        def wrap(method=method, attr=attr):
            @functools.wraps(method)
            def call(self, *args, **kwargs):
                return method(self, *args, **_fix(f"{cls.__name__}.{attr}", method, len(args), kwargs))

            return call

        setattr(cls, attr, wrap())
    return cls
