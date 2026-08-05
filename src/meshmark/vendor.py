"""Copy three.js into a bundle, following its imports instead of listing them.

The bundle is self-contained by design: it has to open from a plain static
server, on a machine with no network, in a browser with no import map beyond the
one in the page. So three.js is copied in rather than loaded from a CDN.

Which files to copy is not a list here, because a list goes stale. three ships
``three.module.js`` that imports ``./three.core.js`` by relative path -- added in
0.17x -- and copying only the entry point produced a bundle that 404s at runtime
with nothing in the build output to suggest it would. Loaders likewise reach
sideways into ``../utils/``.

So we read each file, find its relative imports, and copy those too, until the
set stops growing. Adding a loader means naming one entry point; its dependency
closure comes along by construction.
"""

from __future__ import annotations

import os
import re
import shutil
from pathlib import Path

#: Addon entry points, relative to ``examples/jsm``. Their dependencies are
#: discovered, not listed.
ADDONS = (
    "controls/OrbitControls.js",
    "loaders/GLTFLoader.js",
    "loaders/OBJLoader.js",
    "loaders/MTLLoader.js",
)

#: Where a three.js install tends to be, in the order worth trying.
SEARCH = (
    Path.cwd() / "node_modules/three",
    Path.home() / "node_modules/three",
    Path.home() / ".hermes/hermes-agent/node_modules/three",
    Path("/usr/lib/node_modules/three"),
)

# import ... from 'x';  export ... from "x";  import 'x';
_IMPORT = re.compile(
    r"""(?:^|\n)\s*(?:import|export)\b[^;'"]*?['"]([^'"]+)['"]""",
    re.MULTILINE,
)


class VendorError(RuntimeError):
    """Raised when three.js cannot be found or copied."""


def find(explicit: str | None = None) -> Path:
    """Locate a three.js package directory, or say exactly how to get one."""
    candidates = []
    if explicit:
        candidates.append(Path(explicit).expanduser())
    if os.environ.get("MESHMARK_THREE"):
        candidates.append(Path(os.environ["MESHMARK_THREE"]).expanduser())
    candidates.extend(SEARCH)

    for c in candidates:
        if (c / "build/three.module.js").is_file():
            return c
        # Tolerate being pointed at the build directory or the repo root.
        for sub in (c / "three", c.parent):
            if (sub / "build/three.module.js").is_file():
                return sub

    raise VendorError(
        "could not find three.js. Any one of these fixes it:\n"
        "  npm install three            (in this directory, or anywhere and pass --three)\n"
        "  meshmark build --three /path/to/node_modules/three\n"
        "  export MESHMARK_THREE=/path/to/node_modules/three\n"
        f"Looked in: {', '.join(str(c) for c in candidates)}"
    )


def version(root: Path) -> str:
    """The installed three version, for the record. Never fatal."""
    import json
    try:
        return str(json.loads((root / "package.json").read_text())["version"])
    except Exception:
        return "unknown"


def _copy_closure(entry: Path, src_root: Path, dst_root: Path) -> int:
    """Copy ``entry`` and everything it imports by relative path."""
    pending = [entry]
    done: set[Path] = set()
    while pending:
        src = pending.pop().resolve()
        if src in done:
            continue
        done.add(src)
        if not src.is_file():
            raise VendorError(f"three.js is missing a file it imports: {src}")
        rel = src.relative_to(src_root)
        dst = dst_root / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(src, dst)
        text = src.read_text(encoding="utf-8", errors="ignore")
        for spec in _IMPORT.findall(text):
            if spec.startswith("."):
                pending.append((src.parent / spec).resolve())
            # Bare specifiers are 'three' itself, which the page's import map
            # already points at the copied entry point.
    return len(done)


def install(root: Path, out: Path) -> dict:
    """Copy the entry point and every addon closure into ``out/vendor``."""
    vendor = out / "vendor"
    n = _copy_closure(root / "build/three.module.js", root / "build", vendor)
    jsm = root / "examples/jsm"
    addons = vendor / "addons"
    for rel in ADDONS:
        src = jsm / rel
        if not src.is_file():
            raise VendorError(
                f"three.js at {root} has no {rel}. This is usually a partial "
                f"install -- 'npm install three' ships examples/jsm."
            )
        n += _copy_closure(src, jsm, addons)
    return {"three_version": version(root), "three_root": str(root), "files": n}
