"""The Python half: presets, reference files, staging a mesh, building a bundle.

Everything here is filesystem-only. There is no headless browser in this suite
on purpose -- the browser half is checked in the browser, against a real mesh,
and a fake one here would mostly test the fake.
"""

from __future__ import annotations

import json
import struct
from pathlib import Path

import pytest

from meshmark import bundle, classes, mesh, targets, vendor


# ------------------------------------------------------------------ fixtures

def write(path: Path, data) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return path


@pytest.fixture
def glb(tmp_path: Path) -> Path:
    """A minimal but structurally valid GLB, enough to be staged and served."""
    body = json.dumps({"asset": {"version": "2.0"}, "scenes": [{"nodes": []}]}).encode()
    body += b" " * (-len(body) % 4)
    chunk = struct.pack("<II", len(body), 0x4E4F534A) + body
    path = tmp_path / "room.glb"
    path.write_bytes(struct.pack("<III", 0x46546C67, 2, 12 + len(chunk)) + chunk)
    return path


@pytest.fixture
def three(tmp_path: Path) -> Path:
    """A stand-in three.js install, with the relative-import trap in it."""
    root = tmp_path / "node_modules/three"
    (root / "build").mkdir(parents=True)
    (root / "examples/jsm/controls").mkdir(parents=True)
    (root / "examples/jsm/loaders").mkdir(parents=True)
    (root / "examples/jsm/utils").mkdir(parents=True)
    (root / "package.json").write_text('{"version": "0.180.0"}')
    # three.module.js imports three.core.js by relative path; shipping only the
    # entry point produced a bundle that 404s at runtime with nothing in the
    # build output to suggest it would.
    (root / "build/three.module.js").write_text("export * from './three.core.js';\n")
    (root / "build/three.core.js").write_text("export const REVISION = '180';\n")
    (root / "examples/jsm/controls/OrbitControls.js").write_text("import 'three';\n")
    (root / "examples/jsm/loaders/GLTFLoader.js").write_text(
        "import 'three';\nimport {toTrianglesDrawMode} from '../utils/BufferGeometryUtils.js';\n"
    )
    (root / "examples/jsm/loaders/OBJLoader.js").write_text("import 'three';\n")
    (root / "examples/jsm/loaders/MTLLoader.js").write_text("import 'three';\n")
    (root / "examples/jsm/utils/BufferGeometryUtils.js").write_text(
        "export function toTrianglesDrawMode() {}\n"
    )
    return root


# -------------------------------------------------------------------- presets

def test_builtin_presets_load():
    for name in ("generic", "operating-room"):
        preset = classes.load(name)
        assert preset["classes"], name
        assert preset["name"] == name


def test_the_shipped_examples_are_valid():
    """An example in the README that does not load is worse than no example."""
    root = Path(__file__).resolve().parents[1]
    assert classes.load(str(root / "examples/warehouse.json"))["classes"]
    assert len(targets.load(root / "examples/targets.json")) == 3


def test_an_alias_claimed_by_two_classes_is_rejected(tmp_path: Path):
    # Otherwise which class a reference file resolves to depends on iteration
    # order -- a bug that only ever shows up on someone else's data.
    p = write(tmp_path / "p.json", {"classes": [
        {"id": "table", "en": "t", "zh": "桌", "size_m": [1, 1, 1], "aliases": ["bench"]},
        {"id": "counter", "en": "c", "zh": "台", "size_m": [1, 1, 1], "aliases": ["Bench"]},
    ]})
    with pytest.raises(classes.PresetError, match="claimed by both"):
        classes.load(p)


def test_an_alias_may_not_shadow_another_classes_id(tmp_path: Path):
    p = write(tmp_path / "p.json", {"classes": [
        {"id": "table", "en": "t", "zh": "桌", "size_m": [1, 1, 1]},
        {"id": "counter", "en": "c", "zh": "台", "size_m": [1, 1, 1], "aliases": ["table"]},
    ]})
    with pytest.raises(classes.PresetError, match="claimed by both"):
        classes.load(p)


def test_the_operating_room_preset_claims_the_names_real_files_use():
    preset = classes.load("operating-room")
    claimed = {a.lower() for c in preset["classes"] for a in c.get("aliases", [])}
    for name in ("operating bed", "patient monitor", "trolley"):
        assert name in claimed, f"{name} would become a class of its own"


def test_a_preset_missing_a_translation_is_rejected(tmp_path: Path):
    # A zh name quietly defaulting to the English one gives a UI that looks
    # translated and is not -- worse than a build that stops.
    p = write(tmp_path / "p.json", {"classes": [{"id": "cart", "en": "cart", "size_m": [1, 1, 1]}]})
    with pytest.raises(classes.PresetError, match="has no 'zh' name"):
        classes.load(p)


def test_a_preset_with_a_bad_size_names_the_class(tmp_path: Path):
    p = write(tmp_path / "p.json",
              {"classes": [{"id": "cart", "en": "c", "zh": "车", "size_m": [1, 0, 1]}]})
    with pytest.raises(classes.PresetError, match="cart"):
        classes.load(p)


def test_duplicate_class_ids_are_rejected(tmp_path: Path):
    p = write(tmp_path / "p.json", {"classes": [
        {"id": "cart", "en": "a", "zh": "a1", "size_m": [1, 1, 1]},
        {"id": "cart", "en": "b", "zh": "b1", "size_m": [1, 1, 1]},
    ]})
    with pytest.raises(classes.PresetError, match="duplicate id"):
        classes.load(p)


def test_an_unknown_preset_lists_the_built_ins():
    with pytest.raises(classes.PresetError, match="operating-room"):
        classes.load("warehouse")


# -------------------------------------------------------------------- targets

def test_targets_are_read_however_they_are_spelled(tmp_path: Path):
    p = write(tmp_path / "gt.json", {"objects": [
        {"object_id": "a", "label": "cart", "world_xy": [1, 2], "footprint_radius_m": 0.4},
        {"id": "b", "class": "bed", "xy": [3, 4], "radius_m": 0.9},
        {"name": "c", "position": [5.0, 6.0, 0.1]},
    ]})
    out = targets.load(p)
    assert [t["object_id"] for t in out] == ["a", "b", "c"]
    assert out[1]["xy"] == [3.0, 4.0]
    assert out[2]["xy"] == [5.0, 6.0], "a three-component position keeps x and y"
    assert out[2]["radius_m"] == targets.DEFAULT_RADIUS_M


def test_unknown_fields_survive_the_round_trip(tmp_path: Path):
    p = write(tmp_path / "gt.json",
              {"objects": [{"object_id": "a", "world_xy": [0, 0], "dynamic": True, "mass_kg": 12}]})
    assert targets.load(p)[0]["extra"] == {"dynamic": True, "mass_kg": 12}


def test_a_file_with_no_positions_says_so(tmp_path: Path):
    p = write(tmp_path / "gt.json", {"objects": [{"object_id": "a", "label": "cart"}]})
    with pytest.raises(targets.TargetError, match="none of them has a position"):
        targets.load(p)


def test_duplicate_target_ids_are_fatal(tmp_path: Path):
    # Ids key the browser's saved work; two targets sharing one would overwrite
    # each other's annotation, which looks like the annotation was never made.
    p = write(tmp_path / "gt.json", {"objects": [
        {"object_id": "a", "world_xy": [0, 0]},
        {"object_id": "a", "world_xy": [1, 1]},
    ]})
    with pytest.raises(targets.TargetError, match="duplicate ids"):
        targets.load(p)


def test_a_container_we_do_not_recognise_lists_the_keys(tmp_path: Path):
    p = write(tmp_path / "gt.json", {"things": [], "meta": {}})
    with pytest.raises(targets.TargetError, match="meta, things"):
        targets.load(p)


# ----------------------------------------------------------------------- mesh

def test_an_unsupported_format_suggests_a_conversion(tmp_path: Path):
    p = tmp_path / "scan.ply"
    p.write_text("ply")
    with pytest.raises(mesh.MeshError, match="glb"):
        mesh.kind(p)


def test_obj_companions_are_staged(tmp_path: Path):
    (tmp_path / "tex").mkdir()
    (tmp_path / "tex/diffuse.png").write_bytes(b"\x89PNG")
    (tmp_path / "room.mtl").write_text("newmtl m\nmap_Kd tex/diffuse.png\n")
    (tmp_path / "room.obj").write_text("mtllib room.mtl\nv 0 0 0\n")
    out = tmp_path / "bundle"
    info = mesh.stage(tmp_path / "room.obj", out)
    assert (out / "room.obj").is_file()
    assert (out / "room.mtl").is_file()
    assert (out / "tex/diffuse.png").is_file(), "texture layout must be preserved"
    assert info["companions"] == ["room.mtl", "tex/diffuse.png"]


def test_a_missing_texture_is_named_not_discovered_later(tmp_path: Path):
    (tmp_path / "room.mtl").write_text("newmtl m\nmap_Kd gone.png\n")
    (tmp_path / "room.obj").write_text("mtllib room.mtl\n")
    with pytest.raises(mesh.MeshError, match="gone.png"):
        mesh.stage(tmp_path / "room.obj", tmp_path / "bundle")


def test_a_mesh_cannot_pull_files_from_outside_its_directory(tmp_path: Path):
    # The bundle gets served over HTTP; a "../.." in a texture path must not put
    # arbitrary files on that socket.
    (tmp_path / "secrets").mkdir()
    (tmp_path / "secrets/key.png").write_bytes(b"x")
    (tmp_path / "scene").mkdir()
    (tmp_path / "scene/room.mtl").write_text("newmtl m\nmap_Kd ../secrets/key.png\n")
    (tmp_path / "scene/room.obj").write_text("mtllib room.mtl\n")
    with pytest.raises(mesh.MeshError, match="outside its own directory"):
        mesh.stage(tmp_path / "scene/room.obj", tmp_path / "bundle")


def test_percent_encoded_texture_names_are_found(tmp_path: Path):
    (tmp_path / "wall tile.png").write_bytes(b"x")
    (tmp_path / "room.gltf").write_text(json.dumps({
        "asset": {"version": "2.0"}, "images": [{"uri": "wall%20tile.png"}],
    }))
    info = mesh.stage(tmp_path / "room.gltf", tmp_path / "bundle")
    assert info["companions"] == ["wall tile.png"]


# --------------------------------------------------------------------- vendor

def test_vendor_follows_relative_imports(tmp_path: Path, three: Path):
    out = tmp_path / "bundle"
    info = vendor.install(three, out)
    assert (out / "vendor/three.module.js").is_file()
    assert (out / "vendor/three.core.js").is_file(), "the split build must come along"
    assert (out / "vendor/addons/loaders/GLTFLoader.js").is_file()
    assert (out / "vendor/addons/utils/BufferGeometryUtils.js").is_file(), \
        "a loader's sideways import must come along"
    assert info["three_version"] == "0.180.0"


def test_a_partial_three_install_says_which_file_is_missing(tmp_path: Path, three: Path):
    (three / "examples/jsm/loaders/OBJLoader.js").unlink()
    with pytest.raises(vendor.VendorError, match="OBJLoader"):
        vendor.install(three, tmp_path / "bundle")


def test_missing_three_explains_how_to_get_it(tmp_path, monkeypatch):
    monkeypatch.delenv("MESHMARK_THREE", raising=False)
    monkeypatch.setattr(vendor, "SEARCH", (tmp_path / "nope",))
    monkeypatch.chdir(tmp_path)
    with pytest.raises(vendor.VendorError, match="npm install three"):
        vendor.find()


# --------------------------------------------------------------------- bundle

def test_a_bundle_is_self_contained(tmp_path: Path, glb: Path, three: Path):
    out = tmp_path / "bundle"
    info = bundle.build(mesh=glb, out=out, classes="operating-room", lang="zh", three=str(three))

    assert info["scene"] == "room"
    for name in ("index.html", "app.js", "store.js", "i18n.js", "geometry.js",
                 "topdown.js", "style.css", "spec.json", "room.glb"):
        assert (out / name).is_file(), f"{name} missing from the bundle"

    spec = json.loads((out / "spec.json").read_text(encoding="utf-8"))
    assert spec["lang"] == "zh"
    assert spec["floor_z_m"] is None, "no --floor means measure it from the mesh"
    assert len(spec["classes"]["classes"]) == 25
    assert spec["mesh"]["format"] == "glb"

    html = (out / "index.html").read_text(encoding="utf-8")
    assert "http://" not in html and "https://" not in html, \
        "a bundle must make no network requests"


def test_the_baseline_changes_only_when_a_position_does(tmp_path: Path):
    a = [{"object_id": "a", "xy": [1.0, 2.0]}]
    b = [{"object_id": "a", "xy": [1.0, 2.0]}]
    c = [{"object_id": "a", "xy": [1.0, 2.001]}]
    assert bundle.baseline_digest(a) == bundle.baseline_digest(b)
    assert bundle.baseline_digest(a) != bundle.baseline_digest(c)


def test_a_scene_with_no_targets_still_builds(tmp_path: Path, glb: Path, three: Path):
    # Annotating an empty room is the common case for anyone who is not
    # correcting an existing ground truth.
    out = tmp_path / "bundle"
    info = bundle.build(mesh=glb, out=out, three=str(three))
    assert info["targets"] == 0
    assert json.loads((out / "spec.json").read_text())["targets"] == []


def test_markers_are_parsed_and_bad_ones_rejected(tmp_path: Path, glb, three):
    out = tmp_path / "bundle"
    bundle.build(mesh=glb, out=out, three=str(three), markers=["start=1.5,-2"])
    spec = json.loads((out / "spec.json").read_text())
    assert spec["markers"] == [{"name": "start", "xy": [1.5, -2.0]}]

    with pytest.raises(bundle.BundleError, match="expected two numbers"):
        bundle.build(mesh=glb, out=out, three=str(three), markers=["start=1,2,3"])


def test_link_does_not_copy_the_mesh(tmp_path: Path, glb: Path, three: Path):
    out = tmp_path / "bundle"
    bundle.build(mesh=glb, out=out, three=str(three), link=True)
    assert (out / "room.glb").is_symlink()


def test_rebuilding_over_an_existing_bundle_works(tmp_path: Path, glb: Path, three: Path):
    # Rebuilding is the normal loop -- the object list changes and the bundle is
    # made again -- and it must not trip over the mesh it staged last time.
    out = tmp_path / "bundle"
    bundle.build(mesh=glb, out=out, three=str(three), link=True)
    bundle.build(mesh=glb, out=out, three=str(three))
    assert not (out / "room.glb").is_symlink()
