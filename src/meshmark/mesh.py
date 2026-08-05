"""Get a mesh and everything it refers to into the bundle.

A ``.glb`` is one file and this is trivial. A ``.gltf`` is a JSON file plus a
buffer plus however many textures, and an ``.obj`` is a file that names an
``.mtl`` that names images -- each with paths relative to itself. Copying only
the file the user named produces a bundle that loads a grey blob, or nothing,
with no error worth reading.

So the referenced files are read out of the mesh and copied alongside it, with
their relative layout preserved. Anything named but missing is reported by name
rather than discovered later as a texture that did not appear.
"""

from __future__ import annotations

import json
import os
import re
import shutil
from pathlib import Path

SUPPORTED = {".glb": "glb", ".gltf": "gltf", ".obj": "obj"}

# map_Kd, map_Bump, bump, refl ... every OBJ material texture directive.
_MTL_MAP = re.compile(r"^\s*(?:map_\w+|bump|refl|disp|decal)\s+(.*)$", re.IGNORECASE)
# Options such as -s 1 1 1 may precede the filename.
_MTL_OPT = re.compile(r"^-\w+(?:\s+[-\d.]+)*\s*")


class MeshError(ValueError):
    """Raised when a mesh cannot be read or staged into a bundle."""


def kind(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix not in SUPPORTED:
        raise MeshError(
            f"{path.name}: meshmark reads {', '.join(sorted(SUPPORTED))}, not "
            f"{suffix or '(no extension)'}. Convert first -- for a scan, "
            f"'assimp export in.ply out.glb' or Blender's glTF exporter."
        )
    if not path.is_file():
        raise MeshError(f"no such mesh: {path}")
    return SUPPORTED[suffix]


def _gltf_refs(path: Path) -> list[str]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise MeshError(f"{path} is not valid glTF JSON: {exc}") from exc
    refs = []
    for section in ("buffers", "images"):
        for item in data.get(section) or []:
            uri = item.get("uri")
            # Data URIs are inline; nothing to copy.
            if isinstance(uri, str) and not uri.startswith("data:"):
                refs.append(uri)
    return refs


def _obj_refs(path: Path) -> list[str]:
    refs, mtls = [], []
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        if line.lower().startswith("mtllib"):
            mtls.extend(line.split(None, 1)[1].split())
    refs.extend(mtls)
    for mtl in mtls:
        mtl_path = path.parent / mtl
        if not mtl_path.is_file():
            continue
        for line in mtl_path.read_text(encoding="utf-8", errors="ignore").splitlines():
            m = _MTL_MAP.match(line)
            if m:
                refs.append(_MTL_OPT.sub("", m.group(1).strip()).strip())
    return refs


def stage(source: str | Path, out: Path, link: bool = False) -> dict:
    """Put the mesh and its referenced files into ``out``, returning the spec."""
    src = Path(source).expanduser().resolve()
    fmt = kind(src)
    out.mkdir(parents=True, exist_ok=True)

    refs = {"gltf": _gltf_refs, "obj": _obj_refs}.get(fmt, lambda _: [])(src)
    missing, staged = [], []

    def place(rel: str) -> None:
        # Unquote percent-encoding: glTF URIs are URIs, and a texture named
        # "wall tile.png" appears in the file as "wall%20tile.png".
        from urllib.parse import unquote
        rel_clean = unquote(rel)
        s = (src.parent / rel_clean).resolve()
        # Refuse to reach outside the mesh's own directory. A relative path with
        # ".." in it would otherwise copy arbitrary files into a bundle that
        # gets served over HTTP.
        try:
            inside = s.relative_to(src.parent)
        except ValueError:
            raise MeshError(
                f"{src.name} refers to {rel!r}, which is outside its own "
                f"directory. Move the file next to the mesh and try again."
            ) from None
        if not s.is_file():
            missing.append(rel_clean)
            return
        dst = out / inside
        dst.parent.mkdir(parents=True, exist_ok=True)
        _put(s, dst, link)
        staged.append(str(inside))

    for rel in refs:
        place(rel)
    if missing:
        raise MeshError(
            f"{src.name} refers to {len(missing)} file(s) that are not there: "
            + ", ".join(missing[:8]) + (" ..." if len(missing) > 8 else "")
        )

    _put(src, out / src.name, link)
    return {
        "file": src.name,
        "format": fmt,
        "source": str(src),
        "companions": sorted(staged),
        "bytes": src.stat().st_size + sum((out / c).stat().st_size for c in staged),
    }


def _put(src: Path, dst: Path, link: bool) -> None:
    if dst.exists() or dst.is_symlink():
        dst.unlink()
    if link:
        os.symlink(src, dst)
    else:
        shutil.copy(src, dst)
