"""Fit a box to the geometry around each reference position, as a proposal.

Nothing here annotates anything. It *proposes*: for every position a targets
file claims, it cuts a local point cloud out of the mesh, finds where that
object's top is, fits a footprint to what is left, and writes the lot as a
meshmark annotation file in which every object is still pending. A person then
opens that file in the annotator and rules on each one -- confirm, correct, or
mark absent. The tool proposes; a person annotates.

The distinction is the whole design, and it is why the written objects carry no
``status`` field (see ``write_proposals``). A box that arrives already marked
"done" is a box nobody looks at, and an unlooked-at box fitted by a program is
exactly the kind of number that gets cited as a measurement later.

What it will not do is find objects. It fits a box to the geometry around each
position the targets file already claims; an empty targets file gets you
nothing, and a position pointing at bare floor comes back saying so.

The judgement in here is ported from a predecessor's automatic refit tool, which
was written against a baked scan of an operating room and had four failure modes
beaten out of it by a manual audit:

  * a fixed height cap swallowed tall objects and invented tops for short ones
    -> the height comes from a break in the z profile, measured;
  * mass hanging over an object (a wall shelf above a bench) was read as part
    of it -> unsupported mass is dropped, judged by xy coverage underneath;
  * footprints annexed the neighbour and the bare floor -> a neighbour's own
    claimed radius takes its points back, and bare end bands are trimmed;
  * hollow racks fitted a rectangle to their own rim -> slivers are flagged.

That tool needed numpy and scipy. This one is stdlib, because meshmark is: each
object is cropped to a few thousand points first, and a few thousand points is
not a reason to make a room annotator depend on a numeric stack.
"""

from __future__ import annotations

import base64
import json
import math
import random
import struct
from pathlib import Path
from typing import NamedTuple
from urllib.parse import unquote

from . import classes as classes_mod
from . import mesh as mesh_mod
from . import targets as targets_mod
from .bundle import baseline_digest


class FitError(ValueError):
    """Raised when a mesh cannot be turned into points, or a fit cannot be run."""


# --------------------------------------------------------------------- points
#
# A low-poly mesh has almost no vertices where it matters: every box of
# furniture in the demo room is eight corners. Fitting to vertices alone reads
# eight points and calls it a cabinet, so triangles are resampled by area.

SAMPLE_PER_M2 = 400.0     # samples per square metre of surface. At Z_BIN_M this
                          # puts ~20 points in every 5 cm slice of a 0.05 m
                          # radius IV pole -- the thinnest thing worth fitting.
SAMPLE_SEED = 20260826    # any fixed number; what matters is that it never
                          # changes, so two runs over one mesh agree exactly.
MAX_POINTS = 600_000      # a whole room at SAMPLE_PER_M2 is a few hundred
                          # thousand; past this the list of tuples costs more
                          # memory than the extra resolution is worth, so the
                          # density is scaled down and the thinning reported.

_GLB_MAGIC = 0x46546C67
_CHUNK_JSON = 0x4E4F534A
_CHUNK_BIN = 0x004E4942
# glTF component types, as (struct code, bytes). Only float32 positions are
# read; the quantised variants need KHR_mesh_quantization to interpret and
# guessing at them would put a room in the wrong units without saying so.
_COMPONENT = {5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2),
              5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4)}
_ELEMENTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT2": 4, "MAT3": 9, "MAT4": 16}
_TRIANGLES = 4            # glTF primitive mode; the only one with faces to sample

# ----------------------------------------------------------------------- floor
#
# Restated from the browser's geometry.js FLOOR, which finds the same plane from
# triangles. The two share no import -- one is JavaScript -- so the numbers are
# written twice on purpose rather than one of them being the "real" copy.

FLOOR_BIN_M = 0.01        # 1 cm resolves a floor from a cabinet's kick plate
FLOOR_SEARCH_M = 1.0      # how far above the lowest geometry to look at all
FLOOR_GATHER_M = 0.05     # half-thickness of the slab averaged around the peak
FLOOR_TIE_FRACTION = 0.70 # a bin holding this share of the peak's mass is the
                          # same floor, and the HIGHEST such bin wins: a slab
                          # floor has an underside of exactly the area of its
                          # top, and the side things stand on is the top one.

# ------------------------------------------------------------------- cropping

CROP_PAD_M = 0.45         # slack around the claimed footprint, so an object
                          # whose reference position is off by a hand's width
                          # is still wholly inside its own crop
CROP_RADIUS_FACTOR = 1.2  # a stated footprint radius is a rounded-off number
                          # and can be short of the object; this is the
                          # allowance for that, and no more. It used to be 1.6,
                          # which is where a bounding radius would sit if the
                          # stated one were an inradius -- measured on the demo
                          # room, that window reached 1.97 m around a table
                          # whose own corner is at 1.09, and the table came back
                          # having annexed a stool 1.9 m away. Reaching further
                          # than the object can possibly be does not find more
                          # of it; it finds the neighbours.
FLOOR_CLEARANCE_M = 0.02  # crops start this far above the floor, so the floor
                          # itself is never mistaken for the bottom of a box
DEFAULT_Z_MAX_M = 2.5     # default ceiling of the crop, above the floor
INDEX_CELL_M = 0.5        # xy bucket size for the point index. One pass over a
                          # room per object is affordable once, not fourteen
                          # times.
WALL_KEEPOUT_M = 0.15     # the outer shell of the cloud is the walls, and a
                          # wall runs floor to ceiling: left in, it never breaks
                          # in the z profile and it stretches every footprint
                          # standing against it. KNOWN LIMIT: an object whose
                          # own body lies in that shell loses those points, so
                          # its box can come out short on that side. The
                          # predecessor typed the room's four wall coordinates
                          # in as constants; measuring them is the general form.
WALL_BOUND_QUANTILE = 0.002  # ... and the shell is measured from this quantile
                          # of the cloud, not its extremes, so one stray point
                          # outside the room does not move the wall.

# --------------------------------------------------------------------- height

Z_BIN_M = 0.05            # z profile resolution; the height is quantised to it
GAP_BINS = 3              # this many near-empty bins in a row ends the object
GAP_FRACTION = 0.25       # a bin under this share of the TYPICAL occupied bin
                          # counts as empty. Typical means the median, not the
                          # peak: one horizontal face -- a tabletop, a floor --
                          # puts its whole area into a single 5 cm bin, and
                          # measured against that spike a solid body reads as a
                          # stack of gaps and gets cut off at its own knees.
GAP_MIN_PTS = 2           # ... but never under this absolute floor
FLOATING_MIN_PTS = 30     # mass above a break worth running a support test on
SUPPORT_PROBE_M = 0.30    # look this far under a mass for whatever carries it
SUPPORT_CELL_M = 0.10     # xy grid the mass is projected onto. Support is
SUPPORT_CELL_MIN_PTS = 2  # judged by COVERAGE, never by a share of the points:
SUPPORT_CELL_FRACTION = 0.15  # a stool's seat holds far more points than the
SUPPORT_CORE_RADIUS_M = 0.15  # single column carrying it, and a count ratio
SUPPORT_CORE_MIN_PTS = 5      # calls that seat floating.
BREAK_SHARP_RATIO = 5.0   # solid:gap point ratio that makes a top "high"

# ------------------------------------------------------------------ footprint

FIT_LOW_Q = 0.02          # the footprint is the p02-p98 span in each local
FIT_HIGH_Q = 0.98         # axis: a plain min/max hands the box to one outlier
# The footprint's angle is searched, not taken from the principal axis. A
# square has no principal axis -- PCA returns whichever way the noise leans,
# and a 0.50 m square fitted on its diagonal comes out 0.68 x 0.68. Sweeping
# the angle for the smallest p02-p98 rectangle is rotating calipers' idea done
# on quantiles, so one stray point still cannot set the answer.
ANGLE_COARSE_DEG = 4.0    # first pass over the 90 degrees a rectangle has
ANGLE_FINE_DEG = 0.4      # second pass, within one coarse step of the winner
ANGLE_SAMPLE_MAX = 800    # points the search itself runs on; the extents are
                          # then measured on every point at the chosen angle
END_BANDS = 4             # bands along the long axis, tested for bare floor
END_MIN_FRACTION = 0.15   # an end band under mean * this is not the object
MAX_END_TRIMS = 2         # ... and at most this many are cut off
SLIVER_SHORT_M = 0.15     # a fit thinner than this, or longer than
SLIVER_ASPECT = 5.0       # this * its short side, is a rim rather than a body
PRIOR_SIZE_RATIO = 1.6    # a fit this far from its class's nominal box, either
                          # way, is flagged for an eye. A coarse tripwire and
                          # nothing more -- it makes no claim that the box is
                          # wrong, only that it is not the shape the preset led
                          # anyone to expect. Deliberately loose: on the demo
                          # room a correct 1.90 m worktop sits at 1.58 against a
                          # 1.2 m nominal, just under the line, while the two
                          # fits that really had annexed a neighbour sat just
                          # over it. Anything tighter flags every big worktop.
PRIOR_BAND_FACTOR = 1.25  # how far above a class's nominal HEIGHT the plane fit
                          # may still take points, when the column never broke
                          # and so the top is only a bound. A prior used this way
                          # chooses the band and nothing else: the height that
                          # gets published is still the measured bound, still
                          # "low", still flagged. The alternative -- fitting the
                          # whole unbroken column -- was measured on a real
                          # theatre scan, where a stool with an unlabelled IV
                          # pole standing in its window and a ceiling arm over it
                          # came back 1.47 x 0.84 against a real 0.65 x 0.50.
                          # 1.25 is slack for a tall example of the class plus
                          # the bin the top is quantised to, and no more.
MIN_POINTS = 40           # a tenth of a square metre of surface at
                          # SAMPLE_PER_M2. Under it the fit is reading noise,
                          # so no box is proposed at all.

#: What every fitted height is called in the written file. The annotator knows
#: three provenances for a height and this is a fourth: not dragged, not typed,
#: not a class default -- read off the mesh by a program, pending review.
HEIGHT_SOURCE = "fitted from the mesh"


# =========================================================== reading the mesh

class Cloud(NamedTuple):
    """A mesh flattened to points, with how it was arrived at."""

    points: list[tuple[float, float, float]]
    format: str
    vertices: int      # points that are mesh vertices
    sampled: int       # points that are face samples
    area_m2: float     # total triangle area the samples were spread over
    density: float     # samples per square metre actually used
    thinned: bool      # True when MAX_POINTS forced density below SAMPLE_PER_M2


def points(mesh_path: str | Path) -> list[tuple[float, float, float]]:
    """The mesh as a point cloud, in the mesh's own frame.

    Vertices, plus enough face samples to make a low-poly cabinet more than
    eight corners. Use :func:`cloud` when the sampling itself matters.
    """
    return cloud(mesh_path).points


def cloud(mesh_path: str | Path) -> Cloud:
    """:func:`points`, plus the account of how the cloud was produced."""
    src = Path(mesh_path).expanduser()
    fmt = mesh_mod.kind(src)          # raises MeshError, named, with a fix in it
    verts, tris = _obj_geometry(src) if fmt == "obj" else _gltf_geometry(src)
    if not verts:
        raise FitError(f"{src.name} has no vertex positions in it -- nothing to fit")

    kept = verts
    thinned = False
    if len(kept) > MAX_POINTS:
        # A mesh with this many vertices is already dense enough that its
        # vertices ARE the cloud; face sampling is dropped with them, because
        # the index list no longer refers to the points that were kept.
        step = math.ceil(len(kept) / MAX_POINTS)
        kept = kept[::step]
        tris, thinned = [], True

    area = 0.0
    for a, b, c in tris:
        area += _tri_area(verts[a], verts[b], verts[c])
    budget = MAX_POINTS - len(kept)
    density = SAMPLE_PER_M2 if tris else 0.0
    if area > 0 and area * density > budget:
        density = max(budget, 0) / area
        thinned = True

    out = list(kept)
    if density > 0:
        rng = random.Random(SAMPLE_SEED)
        for a, b, c in tris:
            _sample_triangle(verts[a], verts[b], verts[c], density, rng, out)
    return Cloud(points=out, format=fmt, vertices=len(kept),
                 sampled=len(out) - len(kept), area_m2=area,
                 density=density, thinned=thinned)


def _tri_area(a, b, c) -> float:
    ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
    return 0.5 * math.sqrt(
        (uy * vz - uz * vy) ** 2 + (uz * vx - ux * vz) ** 2 + (ux * vy - uy * vx) ** 2
    )


def _sample_triangle(a, b, c, density: float, rng: random.Random, out: list) -> None:
    """Scatter points over one triangle at ``density`` per square metre.

    The count is area * density with its fractional part decided by a coin
    toss, so a mesh of many small triangles is sampled at the right density
    overall rather than being rounded to nothing one triangle at a time.
    """
    expected = _tri_area(a, b, c) * density
    n = int(expected)
    if rng.random() < expected - n:
        n += 1
    for _ in range(n):
        u, v = rng.random(), rng.random()
        if u + v > 1.0:                      # fold the far half of the square
            u, v = 1.0 - u, 1.0 - v          # back onto the triangle
        out.append((
            a[0] + u * (b[0] - a[0]) + v * (c[0] - a[0]),
            a[1] + u * (b[1] - a[1]) + v * (c[1] - a[1]),
            a[2] + u * (b[2] - a[2]) + v * (c[2] - a[2]),
        ))


# ------------------------------------------------------------------------ obj

def _obj_geometry(path: Path):
    """``v`` lines and ``f`` lines. Polygons are fanned into triangles."""
    verts: list[tuple[float, float, float]] = []
    tris: list[tuple[int, int, int]] = []
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        if line.startswith("v "):
            parts = line.split()
            if len(parts) >= 4:
                try:
                    verts.append((float(parts[1]), float(parts[2]), float(parts[3])))
                except ValueError:
                    continue
        elif line.startswith("f "):
            idx = []
            for token in line.split()[1:]:
                head = token.split("/")[0]
                try:
                    i = int(head)
                except ValueError:
                    idx = []
                    break
                # OBJ counts from one, and from the end when negative.
                idx.append(len(verts) + i if i < 0 else i - 1)
            for k in range(1, len(idx) - 1):
                a, b, c = idx[0], idx[k], idx[k + 1]
                if 0 <= a < len(verts) and 0 <= b < len(verts) and 0 <= c < len(verts):
                    tris.append((a, b, c))
    return verts, tris


# --------------------------------------------------------------------- gltf

def _gltf_geometry(path: Path):
    """Every POSITION accessor in the scene tree, with node transforms applied.

    A glTF node's transform is not decoration: the demo room is twenty-two unit
    cubes, and read without their scales it is twenty-two overlapping metre
    boxes at the origin.
    """
    raw = path.read_bytes()
    if path.suffix.lower() == ".glb":
        doc, binary = _glb_chunks(raw, path.name)
    else:
        try:
            doc, binary = json.loads(raw.decode("utf-8")), None
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise FitError(f"{path.name} is not valid glTF JSON: {exc}") from exc

    nodes = doc.get("nodes") or []
    meshes = doc.get("meshes") or []
    scenes = doc.get("scenes") or []
    if scenes:
        scene = scenes[int(doc.get("scene", 0)) if int(doc.get("scene", 0)) < len(scenes) else 0]
        roots = list(scene.get("nodes") or [])
    else:
        # No scene: every node is a root. Some exporters leave the list out.
        roots = list(range(len(nodes)))

    cache: dict[int, bytes] = {}
    accessors: dict[int, list] = {}
    verts: list[tuple[float, float, float]] = []
    tris: list[tuple[int, int, int]] = []
    # glTF node graphs are trees; a visited set both enforces that and stops a
    # malformed file from walking a cycle forever.
    visited: set[int] = set()
    stack = [(int(i), _IDENTITY) for i in reversed(roots)]
    while stack:
        index, parent = stack.pop()
        if index in visited or not 0 <= index < len(nodes):
            continue
        visited.add(index)
        node = nodes[index]
        world = _compose(parent, _node_matrix(node))
        for child in node.get("children") or []:
            stack.append((int(child), world))
        if "mesh" not in node or not 0 <= int(node["mesh"]) < len(meshes):
            continue
        for prim in meshes[int(node["mesh"])].get("primitives") or []:
            pos = (prim.get("attributes") or {}).get("POSITION")
            if pos is None:
                continue
            local = _accessor(doc, int(pos), path, binary, cache, accessors, "POSITION")
            base = len(verts)
            for p in local:
                verts.append(_apply(world, p))
            if int(prim.get("mode", _TRIANGLES)) != _TRIANGLES:
                continue                     # points, lines, strips: no faces
            if prim.get("indices") is None:
                order = range(len(local))
            else:
                order = [int(v[0]) for v in _accessor(
                    doc, int(prim["indices"]), path, binary, cache, accessors, "indices")]
            order = list(order)
            for k in range(0, len(order) - 2, 3):
                a, b, c = order[k], order[k + 1], order[k + 2]
                if a < len(local) and b < len(local) and c < len(local):
                    tris.append((base + a, base + b, base + c))
    return verts, tris


def _glb_chunks(raw: bytes, where: str) -> tuple[dict, bytes | None]:
    if len(raw) < 12:
        raise FitError(f"{where} is too short to be a GLB")
    magic, version, total = struct.unpack_from("<III", raw, 0)
    if magic != _GLB_MAGIC:
        raise FitError(f"{where} does not start with a glTF header")
    if version != 2:
        raise FitError(f"{where} is glTF binary version {version}; meshmark reads 2")
    doc: dict | None = None
    binary: bytes | None = None
    off, end = 12, min(int(total), len(raw))
    while off + 8 <= end:
        length, kind = struct.unpack_from("<II", raw, off)
        body = raw[off + 8: off + 8 + length]
        if kind == _CHUNK_JSON and doc is None:
            try:
                doc = json.loads(body.decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                raise FitError(f"{where}: the JSON chunk does not parse: {exc}") from exc
        elif kind == _CHUNK_BIN and binary is None:
            binary = body
        off += 8 + length
    if doc is None:
        raise FitError(f"{where} has no JSON chunk")
    return doc, binary


def _buffer(doc: dict, index: int, path: Path, binary: bytes | None,
            cache: dict[int, bytes]) -> bytes:
    if index in cache:
        return cache[index]
    buffers = doc.get("buffers") or []
    if not 0 <= index < len(buffers):
        raise FitError(f"{path.name} refers to buffer {index}, which is not there")
    uri = buffers[index].get("uri")
    if uri is None:
        if binary is None:
            raise FitError(f"{path.name} refers to a binary chunk it does not have")
        data = binary
    elif uri.startswith("data:"):
        head, _, payload = uri.partition(",")
        if "base64" not in head:
            raise FitError(f"{path.name} has a data: buffer that is not base64")
        data = base64.b64decode(payload)
    else:
        side = path.parent / unquote(uri)
        if not side.is_file():
            raise FitError(f"{path.name} refers to {uri!r}, which is not next to it")
        data = side.read_bytes()
    cache[index] = data
    return data


def _accessor(doc: dict, index: int, path: Path, binary: bytes | None,
              cache: dict[int, bytes], memo: dict[int, list], what: str) -> list:
    if index in memo:
        return memo[index]
    accessors = doc.get("accessors") or []
    if not 0 <= index < len(accessors):
        raise FitError(f"{path.name} refers to accessor {index}, which is not there")
    acc = accessors[index]
    if "sparse" in acc:
        raise FitError(
            f"{path.name} uses a sparse accessor for {what}, which meshmark does "
            f"not read. Re-export without sparse accessors."
        )
    comp, kind = int(acc.get("componentType", 0)), str(acc.get("type", ""))
    if comp not in _COMPONENT or kind not in _ELEMENTS:
        raise FitError(f"{path.name}: {what} has an accessor meshmark cannot read")
    if what == "POSITION" and (comp != 5126 or kind != "VEC3"):
        raise FitError(
            f"{path.name} stores positions as {kind}/{comp}, not float32 VEC3. "
            f"That is a quantised mesh (KHR_mesh_quantization); re-export it "
            f"unquantised and the coordinates will be in metres again."
        )
    code, width = _COMPONENT[comp]
    n_elems = _ELEMENTS[kind]
    count = int(acc.get("count", 0))
    view_index = acc.get("bufferView")
    if view_index is None:
        return memo.setdefault(index, [tuple([0.0] * n_elems)] * count)
    views = doc.get("bufferViews") or []
    if not 0 <= int(view_index) < len(views):
        raise FitError(f"{path.name} refers to bufferView {view_index}, which is not there")
    view = views[int(view_index)]
    data = _buffer(doc, int(view.get("buffer", 0)), path, binary, cache)
    start = int(view.get("byteOffset", 0)) + int(acc.get("byteOffset", 0))
    stride = int(view.get("byteStride") or width * n_elems)
    reader = struct.Struct("<" + code * n_elems)
    if count and start + (count - 1) * stride + reader.size > len(data):
        raise FitError(f"{path.name}: {what} runs off the end of its buffer")
    out = [reader.unpack_from(data, start + i * stride) for i in range(count)]
    memo[index] = out
    return out


#: Column-major, the way glTF stores matrices.
_IDENTITY = (1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0,
             0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0)


def _compose(a: tuple, b: tuple) -> tuple:
    """``a`` after ``b`` -- the parent transform applied to the child's."""
    out = [0.0] * 16
    for col in range(4):
        for row in range(4):
            out[col * 4 + row] = sum(a[k * 4 + row] * b[col * 4 + k] for k in range(4))
    return tuple(out)


def _node_matrix(node: dict) -> tuple:
    m = node.get("matrix")
    if isinstance(m, (list, tuple)) and len(m) == 16:
        return tuple(float(v) for v in m)
    tx, ty, tz = (float(v) for v in (node.get("translation") or (0.0, 0.0, 0.0)))
    x, y, z, w = (float(v) for v in (node.get("rotation") or (0.0, 0.0, 0.0, 1.0)))
    sx, sy, sz = (float(v) for v in (node.get("scale") or (1.0, 1.0, 1.0)))
    return (
        (1 - 2 * (y * y + z * z)) * sx, (2 * (x * y + z * w)) * sx, (2 * (x * z - y * w)) * sx, 0.0,
        (2 * (x * y - z * w)) * sy, (1 - 2 * (x * x + z * z)) * sy, (2 * (y * z + x * w)) * sy, 0.0,
        (2 * (x * z + y * w)) * sz, (2 * (y * z - x * w)) * sz, (1 - 2 * (x * x + y * y)) * sz, 0.0,
        tx, ty, tz, 1.0,
    )


def _apply(m: tuple, p) -> tuple[float, float, float]:
    x, y, z = float(p[0]), float(p[1]), float(p[2])
    return (m[0] * x + m[4] * y + m[8] * z + m[12],
            m[1] * x + m[5] * y + m[9] * z + m[13],
            m[2] * x + m[6] * y + m[10] * z + m[14])


# ================================================================ the floor

def floor_z(cloud_points: list) -> float:
    """Height of the floor: the largest horizontal slab in the lowest metre.

    The browser finds the same plane from triangles, weighted by area. Here the
    weighting is already in the cloud -- face sampling puts points on a surface
    in proportion to its area -- so counting points is the same measurement made
    on the same evidence.
    """
    if not cloud_points:
        raise FitError("no points to measure a floor from")
    base = min(p[2] for p in cloud_points)
    bins = max(1, int(round(FLOOR_SEARCH_M / FLOOR_BIN_M)))
    hist = [0] * bins
    for p in cloud_points:
        d = p[2] - base
        if 0.0 <= d < FLOOR_SEARCH_M:
            hist[min(bins - 1, int(d / FLOOR_BIN_M))] += 1
    peak = max(hist)
    if peak <= 0:
        raise FitError(
            f"nothing within {FLOOR_SEARCH_M} m of the lowest geometry -- "
            f"pass --floor to say where the floor is"
        )
    # Highest bin still holding the peak's share of the mass. See
    # FLOOR_TIE_FRACTION: a slab floor's underside is as big as its top.
    chosen = max(b for b, n in enumerate(hist) if n >= peak * FLOOR_TIE_FRACTION)
    centre = base + (chosen + 0.5) * FLOOR_BIN_M
    near = [p[2] for p in cloud_points if abs(p[2] - centre) <= FLOOR_GATHER_M]
    return sum(near) / len(near) if near else centre


def room_bounds(cloud_points: list) -> tuple[float, float, float, float]:
    """``(x0, x1, y0, y1)`` of the room, robust to a few stray points."""
    xs = sorted(p[0] for p in cloud_points)
    ys = sorted(p[1] for p in cloud_points)
    n = len(xs)
    lo = min(n - 1, int(n * WALL_BOUND_QUANTILE))
    hi = max(0, n - 1 - lo)
    return xs[lo], xs[hi], ys[lo], ys[hi]


class _Index:
    """Points bucketed on a coarse xy grid, so one crop touches one neighbourhood.

    Built once over the interior of the cloud -- the outer WALL_KEEPOUT_M shell
    never reaches a fit at all, because it is the walls.
    """

    def __init__(self, cloud_points: list, bounds: tuple, cell: float = INDEX_CELL_M):
        x0, x1, y0, y1 = bounds
        self.cell = cell
        self.cells: dict[tuple[int, int], list] = {}
        self.kept = 0
        for p in cloud_points:
            if not (x0 + WALL_KEEPOUT_M <= p[0] <= x1 - WALL_KEEPOUT_M
                    and y0 + WALL_KEEPOUT_M <= p[1] <= y1 - WALL_KEEPOUT_M):
                continue
            key = (int(math.floor(p[0] / cell)), int(math.floor(p[1] / cell)))
            self.cells.setdefault(key, []).append(p)
            self.kept += 1

    def near(self, cx: float, cy: float, radius: float, z_lo: float, z_hi: float) -> list:
        r2 = radius * radius
        out = []
        i0 = int(math.floor((cx - radius) / self.cell))
        i1 = int(math.floor((cx + radius) / self.cell))
        j0 = int(math.floor((cy - radius) / self.cell))
        j1 = int(math.floor((cy + radius) / self.cell))
        for i in range(i0, i1 + 1):
            for j in range(j0, j1 + 1):
                for p in self.cells.get((i, j), ()):
                    if z_lo <= p[2] <= z_hi and (p[0] - cx) ** 2 + (p[1] - cy) ** 2 <= r2:
                        out.append(p)
        return out


# =============================================================== the height

class HeightRead(NamedTuple):
    """Where the object stops, how sure of it, and what had to be dropped."""

    top_z: float | None
    confidence: str          # high | medium | low
    floating_excluded: bool
    broke: bool


def read_height(pts: list, ceiling_z: float) -> HeightRead:
    """The top of whatever stands in this crop -- measured, not assumed.

    A Z_BIN_M histogram is climbed from the bottom. The first run of GAP_BINS
    near-empty bins ends the object, and the height is that last real bin's
    upper edge. Mass above the break then gets a support test: carried by
    something (shelf posts, a cart's column) means the same object continues and
    the climb resumes; carried by nothing is a wall shelf hanging over it, and
    is dropped.

    ``ceiling_z`` is the top of the crop, and it is what separates the two ways
    a climb can end. Points that run out well below it mean nothing is standing
    above this object, which is as clean a top as a break. Points that go all
    the way up to it mean the object is welded to whatever continues past the
    crop, and the number that comes back is a bound rather than a reading --
    reported "low", for a person to settle.

    KNOWN LIMIT, inherited: this reads a break, so it can only separate what the
    profile separates.
    """
    if not pts:
        return HeightRead(None, "low", False, False)
    zs = [p[2] for p in pts]
    lo = int(math.floor(min(zs) / Z_BIN_M))
    n_bins = int(math.floor(max(zs) / Z_BIN_M)) - lo + 1
    counts = [0] * n_bins
    for z in zs:
        counts[int(math.floor(z / Z_BIN_M)) - lo] += 1
    occupied = sorted(c for c in counts if c)
    typical = occupied[len(occupied) // 2] if occupied else 0
    threshold = max(float(GAP_MIN_PTS), typical * GAP_FRACTION)
    solid = [c >= threshold for c in counts]

    top_bin, confidence, floating = None, "medium", False
    i, last_solid = 0, None
    while i < n_bins:
        if solid[i]:
            last_solid, i = i, i + 1
            continue
        gap_start = i
        while i < n_bins and not solid[i]:
            i += 1
        if last_solid is None:
            continue                      # sparse skirt under the first real bin
        if i >= n_bins:
            # Nothing solid above -- but there are two ways to run out of solid
            # bins, and only one of them is a top. The points ran out well below
            # the crop's ceiling: a top. The CROP ran out first: nothing was
            # observed above this object at all, and the sparse tail is only as
            # long as the room left for it. Measured on a real theatre scan,
            # this branch published a cart welded to a ceiling arm as a 2.39 m
            # reading at "medium", with no bound flag on it anywhere.
            tail_top = (lo + last_solid + 1) * Z_BIN_M
            if not _clear_of_ceiling(tail_top, ceiling_z):
                return HeightRead(round(min(tail_top, ceiling_z), 4), "low",
                                  floating, False)
            top_bin = last_solid
            confidence = _break_confidence(counts, last_solid, gap_start, n_bins)
            break
        if i - gap_start < GAP_BINS:
            continue                      # a waist in an open frame, not a top
        mass = [p for p in pts
                if i <= int(math.floor(p[2] / Z_BIN_M)) - lo < _mass_end(solid, i)]
        break_z = (lo + last_solid + 1) * Z_BIN_M
        if len(mass) < FLOATING_MIN_PTS or not _supported(pts, mass, break_z):
            top_bin = last_solid
            floating = len(mass) >= FLOATING_MIN_PTS
            confidence = _break_confidence(counts, last_solid, gap_start, i)
            break
        # carried from below: the same object continues, so keep climbing.
    if top_bin is None:
        last = max((b for b, s in enumerate(solid) if s), default=n_bins - 1)
        top_z = (lo + last + 1) * Z_BIN_M
        if _clear_of_ceiling(top_z, ceiling_z):
            return HeightRead(round(top_z, 4), "high", floating, True)
        return HeightRead(round(min(top_z, ceiling_z), 4), "low", floating, False)
    return HeightRead(round((lo + top_bin + 1) * Z_BIN_M, 4), confidence, floating, True)


def _clear_of_ceiling(top_z: float, ceiling_z: float) -> bool:
    """Is there room under the crop's ceiling for the emptiness above ``top_z``
    to be evidence, rather than an artefact of where the crop was cut?

    A break in this profile is GAP_BINS empty bins in a row. A top with fewer
    than that many bins of headroom has not been seen to break -- whatever the
    column does above it happens outside the crop -- so it is a bound.

    Both arguments are absolute z, the frame ``fit_one`` passes its ceiling in.
    The comparison is inclusive and carries a float's slack, because ``top_z``
    is a bin's UPPER edge while ``ceiling_z`` is wherever the crop happened to be
    cut: the object that stops exactly GAP_BINS bins under the ceiling has its
    whole gap in view and is a clean top, and which side of the line it lands on
    must not depend on the last bit of a subtraction.
    """
    return top_z <= ceiling_z - GAP_BINS * Z_BIN_M + 1e-9


def _mass_end(solid: list, start: int) -> int:
    """Exclusive end of the run of bins starting at ``start``."""
    end, i, gap = start, start, 0
    while i < len(solid):
        if solid[i]:
            end, gap = i + 1, 0
        else:
            gap += 1
            if gap >= GAP_BINS:
                break
        i += 1
    return end


def _break_confidence(counts: list, last_solid: int, gap_start: int, gap_end: int) -> str:
    """How sharp is the top? A count that falls off a cliff is a real surface;
    one that fades out could be a sparse upper body the scan half-missed."""
    window = counts[gap_start:gap_end]
    peak = max(window) if window else 0
    if peak <= 0:
        return "high"
    return "high" if counts[last_solid] / peak > BREAK_SHARP_RATIO else "medium"


def _supported(pts: list, mass: list, break_z: float) -> bool:
    """Is there structure holding ``mass`` up, or is it hanging in the air?

    The probe is SUPPORT_PROBE_M under the mass, clipped to the gap that starts
    at ``break_z``: support has to BRIDGE the break, or a bench's own top
    surface would vouch for the cabinet hanging above it, which is the mistake
    this test exists to catch.

    The verdict is xy coverage on a SUPPORT_CELL_M grid, never a point ratio.
    Either the support is spread under the mass, or it is one solid core right
    under its centroid -- the second is a stool: a wide seat on a narrow column,
    which any share-of-the-points test calls floating.
    """
    x0 = min(p[0] for p in mass)
    x1 = max(p[0] for p in mass)
    y0 = min(p[1] for p in mass)
    y1 = max(p[1] for p in mass)
    z_bottom = min(p[2] for p in mass)
    probe_lo = max(break_z, z_bottom - SUPPORT_PROBE_M)
    under = [p for p in pts
             if x0 <= p[0] <= x1 and y0 <= p[1] <= y1 and probe_lo <= p[2] < z_bottom]
    if not under:
        return False

    def cell(p):
        return (int(math.floor((p[0] - x0) / SUPPORT_CELL_M)),
                int(math.floor((p[1] - y0) / SUPPORT_CELL_M)))

    mass_cells = {cell(p) for p in mass}
    below: dict[tuple[int, int], int] = {}
    for p in under:
        key = cell(p)
        below[key] = below.get(key, 0) + 1

    carried = sum(1 for c in mass_cells if below.get(c, 0) >= SUPPORT_CELL_MIN_PTS)
    if carried >= SUPPORT_CELL_FRACTION * len(mass_cells):
        return True                                      # spread support
    cx = sum(p[0] for p in mass) / len(mass)
    cy = sum(p[1] for p in mass) / len(mass)
    for (i, j), k in below.items():
        if k < SUPPORT_CORE_MIN_PTS:
            continue
        px = x0 + (i + 0.5) * SUPPORT_CELL_M
        py = y0 + (j + 0.5) * SUPPORT_CELL_M
        if math.hypot(px - cx, py - cy) <= SUPPORT_CORE_RADIUS_M:
            return True                                  # one thin central column
    return False


# ============================================================= the footprint

def norm_yaw(deg: float) -> float:
    """A rectangle's yaw in [-90, 90).

    A box is 180-degree symmetric and a width/depth swap is the same box turned
    by 90, so there is exactly one way to write any footprint down. This is the
    browser's normYaw180, restated: the two agree or a proposal reads as a
    different box from the one that was fitted.
    """
    return ((deg % 180.0) + 270.0) % 180.0 - 90.0


def _spans(pts: list, yaw: float) -> tuple[tuple[float, float], tuple[float, float]]:
    """The p02-p98 span of ``pts`` along ``yaw`` and across it."""
    cos_y, sin_y = math.cos(yaw), math.sin(yaw)
    us = sorted(p[0] * cos_y + p[1] * sin_y for p in pts)
    vs = sorted(-p[0] * sin_y + p[1] * cos_y for p in pts)
    return ((_quantile(us, FIT_LOW_Q), _quantile(us, FIT_HIGH_Q)),
            (_quantile(vs, FIT_LOW_Q), _quantile(vs, FIT_HIGH_Q)))


def _fit_yaw(pts: list) -> float:
    """The angle whose p02-p98 rectangle is smallest, in radians.

    Coarse pass then fine pass, over the 90 degrees a rectangle has. Searched on
    at most ANGLE_SAMPLE_MAX points: the angle is a shape question and a
    thinned copy answers it, while the extents that get published are measured
    on every point. Ties keep the earliest angle, so a round object -- where
    every angle really is as good -- comes out at zero rather than at whichever
    way its noise leaned.
    """
    step = max(1, len(pts) // ANGLE_SAMPLE_MAX)
    sub = pts[::step]

    def area(deg: float) -> float:
        (u0, u1), (v0, v1) = _spans(sub, math.radians(deg))
        return (u1 - u0) * (v1 - v0)

    coarse = [i * ANGLE_COARSE_DEG for i in range(int(90.0 / ANGLE_COARSE_DEG) + 1)]
    best = min(coarse, key=area)
    fine = [best + i * ANGLE_FINE_DEG
            for i in range(-int(ANGLE_COARSE_DEG / ANGLE_FINE_DEG),
                           int(ANGLE_COARSE_DEG / ANGLE_FINE_DEG) + 1)]
    return math.radians(min(fine, key=area))


def _quantile(sorted_values: list, q: float) -> float:
    n = len(sorted_values)
    if n == 1:
        return sorted_values[0]
    pos = q * (n - 1)
    low = int(math.floor(pos))
    high = min(low + 1, n - 1)
    frac = pos - low
    return sorted_values[low] * (1.0 - frac) + sorted_values[high] * frac


def _bare_end(uv: list, u_span: tuple, v_span: tuple) -> list | None:
    """Which points survive cutting one bare end band off the long axis.

    A quantile fit is still pulled long by whatever sits at the far end of the
    crop -- a strip of neighbour, a patch of floor the crop reached. Split the
    footprint into END_BANDS bands along its long axis; an end band holding less
    than END_MIN_FRACTION of the mean band is not part of this object.
    """
    (u0, u1), (v0, v1) = u_span, v_span
    along_u = (u1 - u0) >= (v1 - v0)
    lo, hi = (u0, u1) if along_u else (v0, v1)
    length = hi - lo
    if length <= 0:
        return None
    step = length / END_BANDS
    values = [t[0] if along_u else t[1] for t in uv]
    counts = [0] * END_BANDS
    for value in values:
        counts[min(END_BANDS - 1, max(0, int((value - lo) / step)))] += 1
    mean = sum(counts) / END_BANDS
    if mean <= 0:
        return None
    if counts[0] < END_MIN_FRACTION * mean:
        return [value > lo + step for value in values]
    if counts[-1] < END_MIN_FRACTION * mean:
        return [value < hi - step for value in values]
    return None


class Footprint(NamedTuple):
    cx: float
    cy: float
    width_m: float           # always the long side; see norm_yaw
    depth_m: float
    yaw_deg: float
    trims: int
    swapped: bool
    kept: list


def fit_footprint(pts: list) -> Footprint:
    """The p02-p98 rectangle around ``pts``, on its own principal axis."""
    kept = list(pts)
    yaw = _fit_yaw(kept)
    trims = 0
    while True:
        cos_y, sin_y = math.cos(yaw), math.sin(yaw)
        uv = [(p[0] * cos_y + p[1] * sin_y, -p[0] * sin_y + p[1] * cos_y) for p in kept]
        u_span, v_span = _spans(kept, yaw)
        if trims >= MAX_END_TRIMS:
            break
        survives = _bare_end(uv, u_span, v_span)
        if survives is None:
            break
        trimmed = [p for p, keep in zip(kept, survives) if keep]
        if len(trimmed) < MIN_POINTS:
            break
        kept, trims = trimmed, trims + 1
        yaw = _fit_yaw(kept)

    cu = (u_span[0] + u_span[1]) / 2.0
    cv = (v_span[0] + v_span[1]) / 2.0
    cos_y, sin_y = math.cos(yaw), math.sin(yaw)
    cx = cu * cos_y - cv * sin_y
    cy = cu * sin_y + cv * cos_y
    width = u_span[1] - u_span[0]
    depth = v_span[1] - v_span[0]
    yaw_deg = math.degrees(yaw)
    swapped = depth > width
    if swapped:
        # Long side first, always. A width/depth swap is the same box rotated by
        # 90, and publishing one short-side-first makes its yaw mean the short
        # axis -- which is how a fitted box comes out at right angles to itself.
        width, depth = depth, width
        yaw_deg += 90.0
    return Footprint(cx, cy, width, depth, norm_yaw(yaw_deg), trims, swapped, kept)


# ============================================================ fitting objects

def _slug(text: str) -> str:
    """The browser's slug(), restated: lower case, runs of anything else to _."""
    cleaned = "".join(
        ch if (ch.isascii() and ch.isalnum()) else "_" for ch in str(text).lower()
    )
    return "_".join(part for part in cleaned.split("_") if part)


def class_index(preset: dict) -> dict:
    """Every name a class answers to -> the class. Mirrors the browser's byAlias."""
    index: dict[str, dict] = {}
    for c in preset.get("classes") or []:
        names = [c.get("id"), _slug(c.get("id", "")), _slug(c.get("en", "")), c.get("zh")]
        for alias in c.get("aliases") or []:
            names += [alias, _slug(alias)]
        for name in names:
            if name:
                index.setdefault(name, c)
    return index


def class_for(index: dict, label: str) -> dict | None:
    """The class a free-text label from a targets file refers to, if any."""
    return index.get(_slug(label)) or index.get(str(label))


def _prior_radius(cls: dict | None) -> float:
    """Half-diagonal of a class's nominal box: the reach of a typical one."""
    if not cls:
        return 0.0
    w, d, _ = cls["size_m"]
    return math.hypot(float(w), float(d)) / 2.0


def _crop_radius(target: dict, cls: dict | None) -> float:
    """How wide a window to cut around one claimed position."""
    claimed = float(target.get("radius_m") or targets_mod.DEFAULT_RADIUS_M)
    return max(claimed * CROP_RADIUS_FACTOR, _prior_radius(cls)) + CROP_PAD_M


def fit_one(index: _Index, target: dict, neighbours: list, floor: float,
            z_max_m: float, cls: dict | None) -> dict:
    """Propose one box for one claimed position. Never raises on bad geometry."""
    cx, cy = float(target["xy"][0]), float(target["xy"][1])
    own_r2 = float(target.get("radius_m") or targets_mod.DEFAULT_RADIUS_M) ** 2
    result = {
        "object_id": target["object_id"],
        "label": target.get("label") or "other",
        "class_id": cls["id"] if cls else None,
        "box": None,
        "confidence": "none",
        "rules": [],
        "points_cropped": 0,   # inside the window
        "points_kept": 0,      # ... and not claimed by the target next door
        "points_used": 0,      # ... and inside the band the plane fit read, after
                               # trimming. That band is the fitted top, or the
                               # class prior's when the top is only a bound.
        "needs_manual": False,
        "note": "",
    }

    radius = _crop_radius(target, cls)
    crop = index.near(cx, cy, radius, floor + FLOOR_CLEARANCE_M, floor + z_max_m)
    result["points_cropped"] = len(crop)

    if neighbours:
        # A point another target claims is not ours -- but a point inside our own
        # claim is never yielded, even where the two claims overlap. Note which
        # radius is which: a neighbour reaches as far as its class's nominal box
        # (see fit_all), while our own claim is only what this target actually
        # stated. Reading our own claim generously would have us annexing
        # everything a nominal box covers, which is what the neighbour rule is
        # here to stop.
        #
        # Unconditionally, including when it leaves nothing: a position whose
        # every point belongs to the object next door is a position with nothing
        # of its own, and saying so is the answer. The predecessor kept the
        # unfiltered crop in that case, which is how a reference pointing at
        # bare floor came back holding a confident box around its neighbour.
        kept = []
        stolen = False
        for p in crop:
            mine = (p[0] - cx) ** 2 + (p[1] - cy) ** 2 <= own_r2
            if not mine and any((p[0] - nx) ** 2 + (p[1] - ny) ** 2 <= nr2
                                for nx, ny, nr2 in neighbours):
                stolen = True
                continue
            kept.append(p)
        crop = kept
        if stolen:
            result["rules"].append("neighbour_excluded")
    result["points_kept"] = len(crop)

    if len(crop) < MIN_POINTS:
        result["rules"].append("too_few_points")
        result["needs_manual"] = True
        result["note"] = (
            f"fit: {len(crop)} mesh points left in the window, too few to fit "
            f"anything. Place it by hand, or mark it absent."
        )
        return result

    height = read_height(crop, floor + z_max_m)
    top_z = height.top_z if height.top_z is not None else floor + z_max_m
    if height.floating_excluded:
        result["rules"].append("floating_mass_excluded")
    if not height.broke:
        result["rules"].append("height_unbounded")

    # How far up the plane fit reads. Normally the top that was measured -- but a
    # top that never broke is a bound, and a bound hands the fit everything
    # standing in the window up to the crop's ceiling: on a real theatre scan, an
    # unlabelled IV pole running past a stool and the arm hanging over it, which
    # between them doubled the stool's footprint. Where the class says how tall
    # one of these usually is, that says how much of the column can be this
    # object, and the fit is banded to it.
    #
    # The prior chooses the band and touches nothing else. The height published
    # below is still the bound that was measured, still "low", still carrying
    # height_unbounded -- a class default that could reach the height field would
    # be a nominal size wearing a measurement's clothes. With no class there is
    # no band to draw, so the whole column is fitted as before: too big, and left
    # for the sliver and off_class_prior tripwires to catch.
    fit_top = top_z
    prior_height = float(cls["size_m"][2]) if cls else 0.0
    if not height.broke and prior_height > 0:
        band_top = floor + prior_height * PRIOR_BAND_FACTOR
        if band_top < top_z:
            fit_top = band_top
            result["rules"].append("prior_banded_footprint")

    body = [p for p in crop if p[2] <= fit_top + 1e-9]
    if len(body) < MIN_POINTS:
        result["rules"].append("too_few_points")
        where = ("under the fitted top" if fit_top >= top_z else
                 f"in the bottom {fit_top - floor:.2f} m")
        result["note"] = (
            f"fit: {len(body)} mesh points left {where}, too few to "
            f"fit anything. Place it by hand, or mark it absent."
        )
        result["needs_manual"] = True
        return result

    shape = fit_footprint(body)
    if shape.trims:
        result["rules"].append("end_trimmed")
    if shape.swapped:
        result["rules"].append("axis_normalised")

    notes = []
    sliver = (shape.depth_m < SLIVER_SHORT_M
              or shape.width_m > SLIVER_ASPECT * max(shape.depth_m, 1e-6))
    if sliver:
        # The predecessor refused to publish a sliver at all, because its output
        # went into a catalog. This one publishes it flagged: the destination is
        # a person looking at the mesh, and a wrong box they can drag is more use
        # than an empty ring they have to draw from nothing.
        result["rules"].append("sliver_guard")
        notes.append(
            f"fit: sliver guard -- {shape.width_m:.2f} x {shape.depth_m:.2f} m is a "
            f"rim, not a body. Verify by hand."
        )
    if height.confidence == "low":
        notes.append(
            "fit: the column never broke, so this height is a bound and not a "
            "reading. Verify by hand."
        )
    if "prior_banded_footprint" in result["rules"]:
        notes.append(
            f"fit: and because it never broke, the footprint was fitted to the "
            f"bottom {fit_top - floor:.2f} m of it -- {PRIOR_BAND_FACTOR:g} x the "
            f"nominal height of a {cls['id']} -- rather than to whatever else is "
            f"standing in the window. The height above is still the bound."
        )
    if cls and not sliver:
        nominal = sorted((float(cls["size_m"][0]), float(cls["size_m"][1])), reverse=True)
        ratio = max(shape.width_m / nominal[0], nominal[0] / max(shape.width_m, 1e-6),
                    shape.depth_m / nominal[1], nominal[1] / max(shape.depth_m, 1e-6))
        if ratio > PRIOR_SIZE_RATIO:
            result["rules"].append("off_class_prior")
            notes.append(
                f"fit: {shape.width_m:.2f} x {shape.depth_m:.2f} m against a "
                f"nominal {nominal[0]:.2f} x {nominal[1]:.2f} for {cls['id']}. "
                f"Not the shape the preset expects -- verify by hand."
            )

    result["box"] = {
        "centre": (round(shape.cx, 4), round(shape.cy, 4)),
        "width_m": round(shape.width_m, 3),
        "depth_m": round(shape.depth_m, 3),
        "height_m": round(max(top_z - floor, Z_BIN_M), 3),
        "yaw_deg": round(shape.yaw_deg, 1),
    }
    result["confidence"] = height.confidence
    result["points_used"] = len(shape.kept)
    result["needs_manual"] = bool(notes)
    result["note"] = " ".join(notes)
    return result


def fit_all(cloud_points: list, target_list: list, preset: dict, floor: float,
            z_max_m: float = DEFAULT_Z_MAX_M) -> list[dict]:
    """One proposal per target, in the order the targets file gave them."""
    index = _Index(cloud_points, room_bounds(cloud_points))
    classes = class_index(preset)
    matched = [class_for(classes, t.get("label") or "") for t in target_list]
    # A neighbour reaches at least as far as its class's nominal box. A stated
    # footprint radius is often the radius somebody needs to drive around, not
    # the object, and a two-metre table that claims 0.95 hands its own ends to
    # whatever is cropped next to it.
    claims = [(float(t["xy"][0]), float(t["xy"][1]),
               max(float(t.get("radius_m") or targets_mod.DEFAULT_RADIUS_M),
                   _prior_radius(cls)) ** 2)
              for t, cls in zip(target_list, matched)]
    out = []
    for i, target in enumerate(target_list):
        neighbours = [c for j, c in enumerate(claims) if j != i]
        out.append(fit_one(index, target, neighbours, floor, z_max_m, matched[i]))
    return out


# ================================================================== writing

def constants_snapshot() -> dict:
    """Every threshold that shaped a run, written beside its results.

    A proposal file outlives the argv that made it. Without this, "why is this
    box 0.15 m wider than the one from last month" has no answer in the archive.
    """
    return {
        "sample_per_m2": SAMPLE_PER_M2,
        "sample_seed": SAMPLE_SEED,
        "max_points": MAX_POINTS,
        "floor_bin_m": FLOOR_BIN_M,
        "floor_search_m": FLOOR_SEARCH_M,
        "floor_gather_m": FLOOR_GATHER_M,
        "floor_tie_fraction": FLOOR_TIE_FRACTION,
        "crop_pad_m": CROP_PAD_M,
        "crop_radius_factor": CROP_RADIUS_FACTOR,
        "floor_clearance_m": FLOOR_CLEARANCE_M,
        "wall_keepout_m": WALL_KEEPOUT_M,
        "wall_bound_quantile": WALL_BOUND_QUANTILE,
        "z_bin_m": Z_BIN_M,
        "gap_bins": GAP_BINS,
        "gap_fraction": GAP_FRACTION,
        "gap_min_pts": GAP_MIN_PTS,
        "floating_min_pts": FLOATING_MIN_PTS,
        "support_probe_m": SUPPORT_PROBE_M,
        "support_cell_m": SUPPORT_CELL_M,
        "support_cell_fraction": SUPPORT_CELL_FRACTION,
        "support_core_radius_m": SUPPORT_CORE_RADIUS_M,
        "break_sharp_ratio": BREAK_SHARP_RATIO,
        "fit_quantiles": [FIT_LOW_Q, FIT_HIGH_Q],
        "angle_coarse_deg": ANGLE_COARSE_DEG,
        "angle_fine_deg": ANGLE_FINE_DEG,
        "angle_sample_max": ANGLE_SAMPLE_MAX,
        "end_bands": END_BANDS,
        "end_min_fraction": END_MIN_FRACTION,
        "max_end_trims": MAX_END_TRIMS,
        "sliver_short_m": SLIVER_SHORT_M,
        "sliver_aspect": SLIVER_ASPECT,
        "prior_size_ratio": PRIOR_SIZE_RATIO,
        "prior_band_factor": PRIOR_BAND_FACTOR,
        "min_points": MIN_POINTS,
    }


def write_proposals(results: list[dict], out_path: str | Path, scene: str,
                    mesh_info: dict, floor: float, *,
                    floor_source: str = "measured from the mesh",
                    classes_preset: str | None = None,
                    z_max_m: float = DEFAULT_Z_MAX_M,
                    sampling: Cloud | None = None,
                    baseline: str | None = None) -> dict:
    """Write the proposals as a meshmark annotation file, and count them.

    The written objects deliberately carry **no** ``status`` field. The
    annotator reads a missing status as pending, which is the point: every one of
    these has to appear in the review queue unhandled. Writing "confirmed" here
    would be a program marking its own homework, and the objects it got wrong
    would be the ones nobody ever opens.
    """
    objects = []
    for r in results:
        entry = {
            "object_id": r["object_id"],
            "label": r["label"],
            "kind": "reference",
            "note": r["note"],
        }
        if r["class_id"]:
            entry["class_id"] = r["class_id"]
        if r["box"]:
            entry["world_xy"] = [r["box"]["centre"][0], r["box"]["centre"][1]]
            entry["box"] = {
                "width_m": r["box"]["width_m"],
                "depth_m": r["box"]["depth_m"],
                "height_m": r["box"]["height_m"],
                "yaw_deg": r["box"]["yaw_deg"],
                "height_source": HEIGHT_SOURCE,
            }
        objects.append(entry)

    proposed = sum(1 for r in results if r["box"])
    flagged = sum(1 for r in results if r["box"] and r["needs_manual"])
    document = {
        "format": "meshmark/annotations",
        "version": 1,
        "scene": scene,
        "source": {
            "mesh": mesh_info.get("file"),
            "mesh_source": mesh_info.get("source"),
            "floor_z_m": round(float(floor), 4),
            "floor_source": floor_source,
            "classes_preset": classes_preset,
            "baseline": baseline,
            "produced_by": "meshmark fit",
        },
        "objects": objects,
        # Ignored by the browser, kept for the archive: what the fit did, object
        # by object, and under which thresholds.
        "fit": {
            "note": ("Proposals, not annotations. Every object here is pending "
                     "until a person rules on it in the annotator."),
            "z_max_m": z_max_m,
            "constants": constants_snapshot(),
            "cloud": None if sampling is None else {
                "format": sampling.format,
                "vertices": sampling.vertices,
                "face_samples": sampling.sampled,
                "area_m2": round(sampling.area_m2, 2),
                "samples_per_m2": round(sampling.density, 1),
                "thinned": sampling.thinned,
            },
            "objects": [{
                "object_id": r["object_id"],
                "confidence": r["confidence"],
                "rules": r["rules"],
                "points_cropped": r["points_cropped"],
                "points_kept": r["points_kept"],
                "points_used": r["points_used"],
                "needs_manual": r["needs_manual"],
            } for r in results],
        },
    }
    out = Path(out_path).expanduser()
    if out.parent and not out.parent.exists():
        out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(document, indent=1, ensure_ascii=False) + "\n",
                   encoding="utf-8")
    return {
        "out": out,
        "targets": len(results),
        "proposals": proposed,
        "flagged": flagged,
        "empty": len(results) - proposed,
    }


def propose(mesh: str | Path, targets: str | Path, out: str | Path,
            classes: str = "generic", scene: str | None = None,
            floor_z_m: float | None = None,
            z_max_m: float = DEFAULT_Z_MAX_M) -> dict:
    """Fit a box around every claimed position and write the proposals out."""
    mesh_path = Path(mesh).expanduser()
    if z_max_m <= FLOOR_CLEARANCE_M:
        raise FitError(
            f"--z-max {z_max_m} leaves no room above the floor to fit anything"
        )
    preset = classes_mod.load(classes)
    target_list = targets_mod.load(targets)
    sampling = cloud(mesh_path)
    floor = float(floor_z_m) if floor_z_m is not None else floor_z(sampling.points)
    results = fit_all(sampling.points, target_list, preset, floor, z_max_m)
    info = write_proposals(
        results, out, scene or mesh_path.stem,
        {"file": mesh_path.name, "source": str(mesh_path.resolve())},
        floor,
        floor_source="given with --floor" if floor_z_m is not None
                     else "measured from the mesh",
        classes_preset=preset.get("name"), z_max_m=z_max_m,
        sampling=sampling, baseline=baseline_digest(target_list),
    )
    info["results"] = results
    info["floor_z_m"] = floor
    info["scene"] = scene or mesh_path.stem
    return info
