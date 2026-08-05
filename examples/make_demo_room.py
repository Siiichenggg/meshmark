"""Build examples/demo_room.glb -- a scene anyone can run meshmark on immediately.

    blender -b -P examples/make_demo_room.py -- --out examples/demo_room.glb

Synthetic on purpose. The tool was built against a photogrammetry scan of a real
operating room, and a scan of a real room is not something to ship in a public
repository. This is a stand-in with the same shape of problem: a floor that is
not at zero, furniture standing against walls, and two objects close enough
together to argue about.

Deliberate properties, each of which the README claims and this exercises:

- **The floor sits at 0.12 m, not 0.** meshmark measures it rather than assuming
  it, and a demo whose floor is at zero would not show the difference between a
  tool that measures and one that got lucky.
- **The ceiling is a separate slab at 3.0 m.** Without one, the cut-height slider
  has nothing to cut and the feature looks pointless.
- **Two objects touch.** The trolley is parked against the shelf, which is the
  case where a footprint drawn by eye is worth more than one derived by
  clustering.
- **No textures.** Which is the honest common case for anything that is not a
  scan, and is what the viewer's lighting has to cope with.
"""

import argparse
import math
import sys

import bpy

# Not zero, on purpose -- see the module docstring.
FLOOR_Z = 0.12
ROOM = (6.4, 5.2, 3.0)

PALETTE = {
    "floor": (0.62, 0.64, 0.67),
    "wall": (0.80, 0.82, 0.84),
    "ceiling": (0.88, 0.89, 0.90),
    "steel": (0.68, 0.71, 0.75),
    "drape": (0.22, 0.42, 0.58),
    "cabinet": (0.86, 0.87, 0.88),
    "screen": (0.10, 0.12, 0.15),
    "accent": (0.30, 0.55, 0.62),
    "bin": (0.35, 0.55, 0.42),
}

# name, kind, centre xy, size or radius, height above the floor, colour, yaw
FURNITURE = [
    ("operating_table_top", "box", (0.10, 0.15), (0.72, 2.05), (0.78, 0.16), "drape", 12),
    ("operating_table_base", "box", (0.10, 0.15), (0.34, 0.70), (0.00, 0.78), "steel", 12),
    ("anesthesia_machine", "box", (-1.62, 1.30), (0.66, 0.56), (0.00, 1.42), "cabinet", -22),
    ("anesthesia_screen", "box", (-1.62, 1.30), (0.44, 0.06), (1.42, 0.34), "screen", -22),
    ("cabinet_a", "box", (-2.72, -0.60), (0.52, 1.10), (0.00, 1.85), "cabinet", 0),
    ("shelf", "box", (2.78, 0.90), (0.42, 1.60), (0.00, 1.78), "cabinet", 0),
    # Parked against the shelf: the pair a person has to separate by eye.
    ("trolley", "box", (2.30, 0.05), (0.66, 0.48), (0.00, 0.94), "steel", -8),
    ("counter", "box", (0.60, -2.10), (1.90, 0.62), (0.00, 0.90), "cabinet", 0),
    ("sink", "box", (0.10, -2.10), (0.50, 0.40), (0.90, 0.05), "steel", 0),
    ("stool", "cyl", (-0.95, -1.05), 0.28, (0.00, 0.55), "accent", 0),
    ("trash_can", "cyl", (-2.55, -1.95), 0.22, (0.00, 0.78), "bin", 0),
    ("iv_pole", "cyl", (1.05, 1.55), 0.05, (0.00, 1.82), "steel", 0),
    ("monitor_stand", "cyl", (-1.05, 2.05), 0.09, (0.00, 1.30), "steel", 0),
    ("monitor", "box", (-1.05, 2.05), (0.56, 0.10), (1.30, 0.38), "screen", 0),
    ("equipment_tower", "box", (2.60, -1.75), (0.50, 0.50), (0.00, 1.34), "cabinet", 0),
    ("supply_box", "box", (-2.60, 1.95), (0.55, 0.42), (0.00, 0.42), "accent", 18),
]


def material(name, rgb):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.72
    if "Metallic" in bsdf.inputs:
        bsdf.inputs["Metallic"].default_value = 0.0
    return mat


def put(obj, mat, yaw_deg=0.0):
    obj.data.materials.append(mat)
    obj.rotation_euler[2] = math.radians(yaw_deg)
    return obj


def slab(name, size_xy, z, thickness, mat):
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, z + thickness / 2))
    o = bpy.context.object
    o.name = name
    o.scale = (size_xy[0], size_xy[1], thickness)
    return put(o, mat)


def main() -> int:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    args = ap.parse_args(argv)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    mats = {k: material(k, v) for k, v in PALETTE.items()}
    w, d, h = ROOM

    slab("floor", (w, d), FLOOR_Z - 0.06, 0.06, mats["floor"])
    # A real ceiling, so the cut-height slider has something to cut.
    slab("ceiling", (w, d), FLOOR_Z + h, 0.08, mats["ceiling"])
    for name, (sx, sy), (px, py) in [
        ("wall_n", (w, 0.10), (0, d / 2)),
        ("wall_s", (w, 0.10), (0, -d / 2)),
        ("wall_e", (0.10, d), (w / 2, 0)),
        ("wall_w", (0.10, d), (-w / 2, 0)),
    ]:
        bpy.ops.mesh.primitive_cube_add(size=1, location=(px, py, FLOOR_Z + h / 2))
        o = bpy.context.object
        o.name = name
        o.scale = (sx, sy, h)
        put(o, mats["wall"])

    for name, kind, (px, py), size, (base, height), colour, yaw in FURNITURE:
        z = FLOOR_Z + base + height / 2
        if kind == "box":
            bpy.ops.mesh.primitive_cube_add(size=1, location=(px, py, z))
            o = bpy.context.object
            o.scale = (size[0], size[1], height)
        else:
            bpy.ops.mesh.primitive_cylinder_add(
                radius=size, depth=height, location=(px, py, z), vertices=28
            )
            o = bpy.context.object
        o.name = name
        put(o, mats[colour], yaw)

    bpy.ops.export_scene.gltf(
        filepath=args.out,
        export_format="GLB",
        # Z-up preserved: meshmark writes annotations in the mesh's own frame,
        # and a converted copy would put every coordinate in a frame nothing
        # downstream knows about.
        export_yup=False,
        export_apply=True,
    )
    print(f"wrote {args.out}: floor at {FLOOR_Z} m, {len(FURNITURE)} objects")
    return 0


if __name__ == "__main__":
    sys.exit(main())
