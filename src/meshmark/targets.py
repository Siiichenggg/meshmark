"""Reference points to annotate against -- an existing ground truth, usually.

Optional. Without it you annotate an empty room and every object is one you
added. With it, each reference position is drawn as a ring the annotation can be
confirmed against, corrected from, or marked absent -- which is the workflow this
tool was built for: not "where is the cart", but "is the cart where the file
says it is".

Field names are read loosely on purpose. Every project that has a ground truth
already spells these differently, and refusing to open a file over the
difference between ``id`` and ``object_id`` would be pedantry with no payoff.
What is *not* loose: a position must be two finite numbers, and a file that
parses to zero usable targets says so instead of opening an empty annotator.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

ID_KEYS = ("object_id", "id", "name", "object")
XY_KEYS = ("world_xy", "xy", "position_xy", "position", "world_xyz", "xyz")
RADIUS_KEYS = ("footprint_radius_m", "radius_m", "radius", "arrival_radius_m")
LABEL_KEYS = ("label", "class", "category", "type")

DEFAULT_RADIUS_M = 0.35


class TargetError(ValueError):
    """Raised when a reference file cannot be turned into targets."""


def _first(entry: dict, keys):
    for k in keys:
        if k in entry and entry[k] is not None:
            return k, entry[k]
    return None, None


def _xy(value, where: str) -> list[float]:
    if not isinstance(value, (list, tuple)) or len(value) < 2:
        raise TargetError(f"{where}: position {value!r} is not [x, y]")
    try:
        xy = [float(value[0]), float(value[1])]
    except (TypeError, ValueError) as exc:
        raise TargetError(f"{where}: position {value!r} is not numeric") from exc
    if not all(math.isfinite(v) for v in xy):
        raise TargetError(f"{where}: position {value!r} is not finite")
    return xy


def load(path: str | Path) -> list[dict]:
    """Read a reference file into ``[{id, label, xy, radius_m, extra}]``."""
    p = Path(path).expanduser()
    if not p.is_file():
        raise TargetError(f"no such reference file: {p}")
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise TargetError(f"{p} is not valid JSON: {exc}") from exc

    if isinstance(data, list):
        entries = data
    elif isinstance(data, dict):
        # Accept the common containers rather than insisting on one.
        entries = next(
            (data[k] for k in ("objects", "targets", "items", "annotations")
             if isinstance(data.get(k), list)),
            None,
        )
        if entries is None:
            raise TargetError(
                f"{p} is an object with no list under 'objects', 'targets', "
                f"'items' or 'annotations'; keys present: "
                f"{', '.join(sorted(data)) or '(none)'}"
            )
    else:
        raise TargetError(f"{p} is a {type(data).__name__}, not a list or object")

    out, skipped = [], []
    for i, e in enumerate(entries):
        where = f"{p} entry #{i}"
        if not isinstance(e, dict):
            raise TargetError(f"{where} is {type(e).__name__}, not an object")
        _, oid = _first(e, ID_KEYS)
        _, xy_raw = _first(e, XY_KEYS)
        if xy_raw is None:
            skipped.append(str(oid or i))
            continue
        _, label = _first(e, LABEL_KEYS)
        _, radius = _first(e, RADIUS_KEYS)
        out.append({
            "object_id": str(oid) if oid is not None else f"target_{i:03d}",
            "label": str(label) if label else "other",
            "xy": _xy(xy_raw, where),
            "radius_m": float(radius) if isinstance(radius, (int, float)) and radius > 0
                        else DEFAULT_RADIUS_M,
            # Carried through untouched so a promoted baseline does not come back
            # looking unresolved, and so nothing this tool does not understand is
            # silently dropped between load and export.
            "extra": {k: v for k, v in e.items()
                      if k not in set(ID_KEYS + XY_KEYS + RADIUS_KEYS + LABEL_KEYS)},
        })

    if not out:
        raise TargetError(
            f"{p} has {len(entries)} entries and none of them has a position. "
            f"Looked for any of: {', '.join(XY_KEYS)}"
        )
    if skipped:
        print(f"note: {len(skipped)} entries in {p.name} have no position and were "
              f"skipped: {', '.join(skipped[:6])}"
              + (" ..." if len(skipped) > 6 else ""))

    ids = [t["object_id"] for t in out]
    if len(set(ids)) != len(ids):
        dupes = sorted({i for i in ids if ids.count(i) > 1})
        raise TargetError(
            f"{p} has duplicate ids: {', '.join(dupes[:6])}"
            + (" ..." if len(dupes) > 6 else "")
            + ". Ids key the browser's saved work, so two targets sharing one "
              "would overwrite each other's annotation."
        )
    return out
