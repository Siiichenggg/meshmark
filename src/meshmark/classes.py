"""Class presets: the list of things a scene can contain, in both languages.

A preset is data, not code. The operating-room list this tool grew out of was
hard-coded in the middle of a 900-line HTML string, which meant annotating a
warehouse required editing the application. Presets are JSON, live in
``presets/``, and are selected with ``--classes``.

Each class carries a starting box in metres. Those are nominal sizes and the UI
says so: they exist so that placing an object is one click rather than one click
plus three number entries, and every one of them is meant to be dragged to fit.
"""

from __future__ import annotations

import json
from pathlib import Path

#: Presets shipped with the package, resolvable by bare name. Inside the package
#: rather than beside it, so an installed copy has them too.
BUILTIN_DIR = Path(__file__).resolve().parent / "presets"

LANGS = ("en", "zh")


class PresetError(ValueError):
    """Raised when a class preset cannot be used as given."""


def resolve(name_or_path: str) -> Path:
    """Find a preset by bare name (``operating-room``) or by path."""
    p = Path(name_or_path).expanduser()
    if p.is_file():
        return p
    candidate = BUILTIN_DIR / f"{name_or_path}.json"
    if candidate.is_file():
        return candidate
    available = ", ".join(sorted(f.stem for f in BUILTIN_DIR.glob("*.json")))
    raise PresetError(
        f"no class preset {name_or_path!r}: not a file, and not one of the "
        f"built-ins ({available or 'none found'})"
    )


def load(name_or_path: str) -> dict:
    """Read and check a preset, raising with the offending entry named."""
    path = resolve(name_or_path)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise PresetError(f"{path} is not valid JSON: {exc}") from exc

    classes = data.get("classes")
    if not isinstance(classes, list) or not classes:
        raise PresetError(f"{path} has no classes")

    seen: set[str] = set()
    for i, c in enumerate(classes):
        where = f"{path} class #{i}"
        if not isinstance(c, dict):
            raise PresetError(f"{where} is {type(c).__name__}, not an object")
        cid = c.get("id")
        if not isinstance(cid, str) or not cid:
            raise PresetError(f"{where} has no id")
        if cid in seen:
            raise PresetError(f"{where}: duplicate id {cid!r}")
        seen.add(cid)
        # Both languages are required rather than defaulted. A missing zh name
        # silently falling back to the English one produces a UI that looks
        # translated and is not, which is worse than a build that stops.
        for lang in LANGS:
            if not isinstance(c.get(lang), str) or not c[lang]:
                raise PresetError(f"{where} ({cid}) has no {lang!r} name")
        size = c.get("size_m")
        if (not isinstance(size, (list, tuple)) or len(size) != 3
                or not all(isinstance(v, (int, float)) and v > 0 for v in size)):
            raise PresetError(
                f"{where} ({cid}) needs size_m as three positive numbers "
                f"[width, depth, height] in metres, got {size!r}"
            )

    data.setdefault("name", path.stem)
    data.setdefault("display", {lang: data["name"] for lang in LANGS})
    data["source"] = str(path)
    return data
