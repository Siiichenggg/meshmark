# meshmark

**Hand-annotate objects and routes in a scanned room, in your browser.**

[![tests](https://github.com/Siiichenggg/meshmark/actions/workflows/test.yml/badge.svg)](https://github.com/Siiichenggg/meshmark/actions/workflows/test.yml)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)
[![python 3.10+](https://img.shields.io/badge/python-3.10%2B-blue.svg)](pyproject.toml)

[中文说明](README.zh.md)

![The meshmark annotator: a 3D view of a scanned operating room on the left, a metric top-down view of one object on the right](docs/annotator.jpg)

<sub>A photogrammetry scan of an operating room, mid-annotation. Yellow: boxes drawn around objects. Red: the positions a reference file claims. Cyan: a route traced across the floor. Top right: the same object from directly above, at 6.9 mm per pixel.</sub>

meshmark turns a 3D scan of a room into a web page where you draw oriented boxes
around the objects in it and trace routes across its floor, then exports both as
JSON in the mesh's own coordinates.

It exists for indoor robot navigation work, where you need to know where the
furniture is and where people walk. Its main job is checking: give it a file that
says where the objects are, and it puts each claim on screen next to the geometry
so you can confirm it, correct it, or record that nothing is there. It works on
an empty room too, with nothing to check and everything to add.

Requirements: Python 3.10+, and a copy of three.js. No Blender, no GPU, no
network — a built bundle is a static directory that makes no outbound requests.

## Quickstart

```bash
npm install three          # meshmark copies it into each bundle it builds
pip install -e .

meshmark build examples/demo_room.glb --out .annotate/demo \
    --classes operating-room --targets examples/demo_room_targets.json
meshmark serve .annotate/demo --open
```

A demo room ships with the repo so there is something to annotate before you have
a scan of your own. It is deliberately awkward in the ways real rooms are: its
floor is at 0.12 m rather than 0, a ceiling blocks the view from above, two
objects touch, and one of the fourteen reference positions names an object that
is not in the room at all.

## The two views

The **top-down view** is where you measure. It is an orthographic render of the
scan from directly overhead, with an exact world-to-pixel mapping and its scale
printed underneath, so a position can be read off it without perspective
distortion.

The **3D view** is where you identify. From directly above, a trash can and a
stack of folded linen are the same grey circle; you have to look from the side to
tell them apart.

Both edit the same annotation. A click on the mesh in 3D puts the box down; from
then on it is edited where it stands, by the grips on the box itself — the centre
moves it, the corners resize it, the ring outside one edge turns it, and the
diamond on top pulls its height up the vertical rail. A click on bare mesh only
ever places a box that has nowhere to be yet, so a stray click on the far wall
cannot teleport one you have already fitted. The top-down view is where the last
centimetre gets measured: drag it there, or nudge with the arrow keys at 1 cm per
press.

Both views hide everything above **the cut**, a height above the floor set by
`--cut-height` and adjustable with the slider. Without it you would be looking at
the ceiling. The top-down view re-renders when you move the cut, so lowering it
reveals what was underneath.

## Working against an existing file

Pass a file of positions with `--targets` and each one is drawn as a red ring.
For every object you then record one of:

| Status | Meaning |
|---|---|
| `confirmed` | the reference position is right; the annotation takes its exact coordinates |
| `corrected` | the object is here instead; `offset_m` records how far it moved |
| `absent` | there is nothing at that position |
| `added` | an object you found that the file does not mention |
| `pending` | not looked at yet |

Objects you add have no ring and no reference position. Objects from the file
keep theirs, so a diff against the original is always available.

Recording `confirmed` or `absent` is the end of one object's turn, so it moves
you on to the next object nobody has ruled on yet, wrapping once and staying put
when there is none. A hundred-object pass otherwise costs a hundred extra clicks
on *next*.

**`--targets` and `--marker` are different things.** `--targets` are positions you
check and edit. A `--marker` is a fixed point drawn in pink that you cannot edit —
a robot's start pose, a doorway, anything a route should be judged against.

## What it does not do

- **It does not find objects.** It is a manual annotator by design. A
  photogrammetry scan is usually one welded surface over the whole room, and no
  clustering method separates a cart from the wall behind it. `meshmark fit`
  fits a box around a position you already have; it never discovers one.
- **It does not decide anything for you.** Width, depth and yaw are dragged onto
  the object, and height can be too — the diamond on top of the box runs up a
  vertical rail until the box reaches the top of what it encloses. `meshmark
  fit` will read all four off the mesh, but what it writes is a *proposal*: it
  arrives pending, in the review queue, with nothing marked handled.
  `height_source` in the export says which of the four ways each height got its
  number, because a figure dragged onto the mesh, a figure a program fitted and
  a figure nobody has ever looked at should not be cited the same way.
- **One room, one person, one browser.** No server, no accounts, no merging.

## Install

meshmark has no Python dependencies. It needs a copy of three.js to put in the
bundles it builds, and looks for one in this order:

1. `--three /path/to/node_modules/three`
2. `$MESHMARK_THREE`
3. `./node_modules/three`, then `~/node_modules/three`

## Usage

```bash
# an empty room, generic classes
meshmark build scan.glb --out .annotate/room

# an operating room in Chinese, checked against an existing file,
# with the robot's start pose drawn as a fixed marker
meshmark build or_room.glb --out .annotate/or_room \
    --name or_room \
    --classes operating-room \
    --lang zh \
    --targets gt_or_room.json \
    --marker "robot start=-1.35,-1.9"

meshmark serve .annotate/or_room --open

# propose a box around each of those positions first, and open the annotator
# on the proposals instead of on empty rings
meshmark fit or_room.glb --targets gt_or_room.json \
    --classes operating-room \
    --out proposals.json
meshmark build or_room.glb --out .annotate/or_room \
    --targets gt_or_room.json --preload proposals.json
```

### `meshmark build`

| Option | Default | What it does |
|---|---|---|
| `--out` | *required* | Directory to write the bundle into |
| `--name` | mesh filename | Name for this room. Your browser stores its saved work under it |
| `--classes` | `generic` | Built-in preset name, or a path to your own JSON |
| `--targets` | — | Positions to check, as JSON. Each becomes a red ring |
| `--marker` | — | `NAME=X,Y` drawn in pink and never editable. Repeatable |
| `--lang` | `en` | `en` or `zh`, for a browser that has not chosen yet. The in-page switch overrides it and is remembered |
| `--floor` | *detected* | Floor height in metres. Omit and it is found from the mesh |
| `--cut-height` | `1.6` | Metres above the floor to hide everything above, in both views |
| `--top-down-pixels` | `2048` | Resolution of the top-down render |
| `--preload` | — | An exported file to open with, when the browser has no saved work |
| `--three` | *searched* | Path to a three.js package directory |
| `--link` | off | Symlink the mesh instead of copying it. For large scans |

### `meshmark fit`

Fits a box to the geometry around each position in a targets file and writes
them as an annotation file you hand to `--preload`. **It proposes; you
annotate.** Every object it writes arrives *pending*, with no status on it, so
all of them appear in the review queue unhandled — a box that turns up already
marked confirmed is a box nobody opens.

It does not find objects. A position pointing at bare floor comes back with a
sentence saying so and no box at all, and an empty targets file gets you
nothing. Fits it doubts — a rim rather than a body, a height that is a bound
rather than a reading, a shape a long way off what the class preset expects —
are flagged in the file and counted in the summary.

| Option | Default | What it does |
|---|---|---|
| `--targets` | *required* | The positions to fit around. Without them there is nothing to fit |
| `--out` | *required* | Annotation file to write the proposals into |
| `--classes` | `generic` | Preset whose nominal sizes size the window cut around each position |
| `--name` | mesh filename | Name for this room, written into the file |
| `--floor` | *detected* | Floor height in metres, measured from the mesh if omitted |
| `--z-max` | `2.5` | Ignore geometry more than this far above the floor, so a ceiling is never read as an object's top |

The file also carries a `fit` section the annotator ignores: every threshold the
run used, and per object which rules fired, how confident the height is, and how
many points it was fitted from. A proposal outlives the command line that made
it.

### `meshmark serve`

`meshmark serve <bundle> [--port 8731] [--open]`

Binds to `127.0.0.1` only. A bundle contains a copy of the scan it was built
from; scans of real interiors should not be exposed on a network by accident.

### Input meshes

| Format | Notes |
|---|---|
| `.glb` | One file, textures embedded. The easy case. |
| `.gltf` | Its buffer and images are found and staged alongside it. |
| `.obj` | Its `.mtl`, and every texture the `.mtl` names, come too, with the directory layout preserved. |

Any other extension stops the build with a suggested conversion.

### Controls

| | |
|---|---|
| **3D** | left drag orbit · right drag pan · wheel zoom · click a box selects it · its grips: centre moves · corners resize · ring turns · diamond sets height · click on bare mesh places a target that has no position yet |
| **Top-down** | click sets the centre · drag inside moves · drag a corner resizes |
| **Keys** | arrows nudge 1 cm (Shift 10 cm) · <kbd>Enter</kbd> next · <kbd>F</kbd> frame · <kbd>Del</kbd> remove · <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo |

**focus current**, above the object list, draws and hit-tests the object you are
on and nothing else. A room's worth of boxes overlaps from every angle a person
can stand at, and the one being edited is the one that has to stay legible. It is
remembered per browser, not per room.

Your work is saved to the browser's `localStorage` as you go. It is stored under
the room name plus a digest of the reference positions, so editing that file
gives you a clean slate rather than boxes laid over rings that have moved.
Routes are stored under the room name alone, and survive a rebuild.

## Formats

<details>
<summary><b>What you export</b> — <code>meshmark/annotations</code></summary>

```json
{
  "format": "meshmark/annotations",
  "version": 1,
  "scene": "or_room",
  "source": {
    "mesh": "or_room.glb",
    "floor_z_m": 0.1079,
    "floor_source": "measured from the mesh",
    "top_down": { "pixels": 2048, "metres_per_pixel": 0.00333, "centre_xy": [0, 0] }
  },
  "objects": [
    {
      "object_id": "or_room_cart_001",
      "class_id": "cart",
      "label": "cart",
      "label_zh": "推车",
      "kind": "reference",
      "status": "corrected",
      "reference_xy": [-0.59, 1.18],
      "world_xy": [-0.7691, 1.2038],
      "box": { "width_m": 0.851, "depth_m": 0.481,
               "height_m": 1.45, "yaw_deg": -69,
               "height_source": "class default" },
      "offset_m": 0.1834,
      "note": ""
    }
  ],
  "routes": [
    { "id": "route_1", "name": "Route 1",
      "waypoints": [[-1.0, -2.0], [0.0, -1.0]], "length_m": 1.414 }
  ]
}
```

| Field | Meaning |
|---|---|
| `kind` | `reference` if it came from `--targets`, `added` if you created it |
| `world_xy` | where you put it |
| `reference_xy` | where the file said it was. Absent on added objects |
| `offset_m` | distance between those two |
| `box.yaw_deg` | rotation about the vertical axis, degrees |
| `box.height_source` | `class default`, `entered by hand`, or `dragged in 3D` against the mesh |
| `source_fields` | anything in your `--targets` file meshmark does not model, handed back untouched |

Coordinates are in the mesh's own frame. Nothing is converted on the way in or
out, so the export drops straight back into whatever produced the mesh.

</details>

<details>
<summary><b>What you can pass to <code>--targets</code></b></summary>

Field names are read loosely, because every project spells them differently:

| Meaning | Any of |
|---|---|
| identity | `object_id`, `id`, `name`, `object` |
| position | `world_xy`, `xy`, `position_xy`, `position`, `world_xyz`, `xyz` |
| radius | `footprint_radius_m`, `radius_m`, `radius`, `arrival_radius_m` |
| class | `label`, `class`, `category`, `type` |

```json
{"objects": [
  {"object_id": "cart_001", "label": "trolley",
   "world_xy": [2.05, -0.14], "footprint_radius_m": 0.42, "dynamic": true}
]}
```

Two things are refused rather than guessed at: a file that yields no usable
positions, and duplicate ids. Ids key your saved work, so two objects sharing one
would overwrite each other's annotation.

</details>

<details>
<summary><b>Class presets</b> — for rooms that are not operating rooms</summary>

```json
{
  "name": "warehouse",
  "display": { "en": "Warehouse", "zh": "仓库" },
  "classes": [
    { "id": "pallet", "en": "pallet", "zh": "托盘", "size_m": [1.2, 0.8, 0.15],
      "aliases": ["skid"] }
  ]
}
```

`size_m` is `[width, depth, height]` in metres and is a starting size, so placing
an object takes one click instead of a click and three numbers.

`aliases` let a class claim the other names reference files use, so
`operating table` also answers to `operating bed` rather than becoming a second
class. A label matching no class is added as a class of its own rather than
silently retyped.

Both `en` and `zh` are required, and an alias claimed by two classes is refused.
See [`examples/warehouse.json`](examples/warehouse.json) for a complete file.

</details>

## Two numbers that are measured, not assumed

**The floor.** meshmark takes the largest horizontal slab in the lowest metre of
geometry, weighted by surface area so that a finely tessellated tabletop does not
outvote a coarse floor. Scanned rooms rarely sit at z = 0 — the two this was
developed against are at 108 mm and 171 mm — and a cut height measured from the
wrong floor is wrong by that much everywhere. Use `--floor` to override.

**The top-down mapping.** On load, meshmark renders a marker at a known
asymmetric position and checks that it lands in the pixel the mapping predicts,
logging the error to the browser console:

```
meshmark: top-down mapping verified to 0.89 px (3.0 mm)
```

A mirrored axis would produce annotations that look completely reasonable, so
this is checked on every load rather than trusted.

## Development

```
src/meshmark/          CLI, bundling, presets, reference files, three.js vendoring
src/meshmark/web/      the annotator: app, top-down render, geometry, storage, i18n
src/meshmark/presets/  generic.json, operating-room.json
examples/              demo_room.glb and the Blender script that generates it
tests/                 Python; tests/js/ runs in node
```

```bash
python -m pytest          # everything, including the JavaScript via node
npm test                  # the JavaScript alone
```

The JavaScript is in `.js` files, not embedded in Python strings, so it can be
parsed, linted and unit-tested. `tests/js/` covers the parts with no DOM in them:
floor detection, box geometry, the storage layer and the translation tables.

Early days — 0.3.1. The formats above carry a version number, so a breaking
change will announce itself.

## Licence

MIT — see [LICENSE](LICENSE), and [NOTICE](NOTICE) for what a built bundle
contains. Bundles include a copy of three.js (also MIT) from your own
installation; three.js is not redistributed here.
