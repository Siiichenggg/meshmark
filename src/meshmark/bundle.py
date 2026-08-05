"""Assemble a self-contained annotator bundle from a mesh and some options.

The output directory is a static site: an HTML file, a few JavaScript modules, a
copy of three.js, the mesh, and ``spec.json``. Serve it and it works; it makes
no network requests and reads nothing outside itself.

``spec.json`` is a separate file rather than a literal pasted into the page.
That is not tidiness. The version of this tool it grew out of kept its entire
application inside a Python string, so an undefined identifier in the JavaScript
was invisible to the interpreter, to linters and to tests -- and one duly
shipped, silently disabling the code that restored a session's saved work.
JavaScript that lives in ``.js`` files can be parsed, linted and tested.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

from . import classes as classes_mod
from . import mesh as mesh_mod
from . import targets as targets_mod
from . import vendor

WEB_DIR = Path(__file__).resolve().parent / "web"
SPEC_VERSION = 1


class BundleError(RuntimeError):
    """Raised when a bundle cannot be assembled."""


def baseline_digest(targets: list[dict]) -> str:
    """A short digest of the reference positions.

    Saved work is keyed by it. When the references move, boxes from a previous
    round would otherwise still be drawn over rings that are no longer there,
    and every offset in the panel would be measured against a reference that has
    since changed. Changing the digest gives a clean slate; changing it back
    restores that round.
    """
    return hashlib.sha256(
        json.dumps([[t["object_id"], t["xy"]] for t in targets],
                   sort_keys=True).encode()
    ).hexdigest()[:8]


def build(
    mesh: str | Path,
    out: str | Path,
    scene: str | None = None,
    classes: str = "generic",
    targets: str | Path | None = None,
    lang: str = "en",
    floor_z_m: float | None = None,
    plate_pixels: int = 2048,
    clip_height_m: float = 1.6,
    reference_points: list[str] | None = None,
    preload: str | Path | None = None,
    three: str | None = None,
    link: bool = False,
) -> dict:
    """Write a ready-to-serve annotator into ``out`` and return its summary."""
    out = Path(out).expanduser()
    mesh_path = Path(mesh).expanduser()
    scene = scene or mesh_path.stem

    if lang not in ("en", "zh"):
        raise BundleError(f"--lang must be en or zh, got {lang!r}")
    if plate_pixels < 256:
        raise BundleError(
            f"--plate-pixels {plate_pixels} would give a top-down plate too "
            f"coarse to measure on; 1024 or more is the useful range"
        )

    preset = classes_mod.load(classes)
    refs = _reference_points(reference_points or [])
    tgts = targets_mod.load(targets) if targets else []

    out.mkdir(parents=True, exist_ok=True)
    staged = mesh_mod.stage(mesh_path, out, link=link)

    for f in sorted(WEB_DIR.iterdir()):
        if f.is_file():
            shutil.copy(f, out / f.name)
    installed = vendor.install(vendor.find(three), out)

    preload_data = None
    if preload:
        preload_data = json.loads(Path(preload).expanduser().read_text(encoding="utf-8"))

    spec = {
        "format": "meshmark/spec",
        "version": SPEC_VERSION,
        "scene": scene,
        "lang": lang,
        "mesh": staged,
        # null means "measure it from the mesh in the browser". Neither of the
        # scans this was built on puts its floor at z=0, and they disagree with
        # each other by 63 mm, so a default of zero would be a scene-specific
        # constant wearing the costume of a general one.
        "floor_z_m": floor_z_m,
        "plate": {"pixels": plate_pixels, "clip_height_m": clip_height_m},
        "classes": preset,
        "targets": tgts,
        "reference_points": refs,
        "baseline": baseline_digest(tgts),
        "preload": preload_data,
        "built_with": {"meshmark_spec": SPEC_VERSION, **installed},
    }
    (out / "spec.json").write_text(
        json.dumps(spec, indent=1, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return {
        "out": out, "scene": scene, "targets": len(tgts),
        "classes": len(preset["classes"]), "baseline": spec["baseline"],
        "mesh_mb": staged["bytes"] / 1e6, "three": installed["three_version"],
    }


def _reference_points(specs: list[str]) -> list[dict]:
    """Parse ``NAME=X,Y`` into fixed points the annotator draws but never edits."""
    out = []
    for s in specs:
        if "=" not in s:
            raise BundleError(f"--reference wants NAME=X,Y, got {s!r}")
        name, xy = s.split("=", 1)
        try:
            values = [float(v) for v in xy.split(",")]
        except ValueError as exc:
            raise BundleError(f"--reference {s!r}: {exc}") from exc
        if len(values) != 2:
            raise BundleError(
                f"--reference {s!r}: expected two numbers, got {len(values)}"
            )
        out.append({"name": name, "xy": values})
    return out
