"""The box fitter: what it proposes, and what it refuses to propose.

Synthetic point clouds, built here rather than loaded -- no mesh, no GPU, and
every case is a pair. One half is the situation the guard exists for, the other
is the situation that looks the same and must come out differently: an
unsupported shelf against a shelf on a column, a neighbour taking its points
back against a neighbour taking ours, a crop with an object in it against a crop
with nothing in it. A guard that fires on both halves is not a guard.

The one file this reads is examples/demo_room.glb, which is checked in, and it
reads it to prove the chain from glTF node transforms to a written proposal
holds together at all.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from meshmark import fit

ROOT = Path(__file__).resolve().parents[1]
DEMO = ROOT / "examples/demo_room.glb"
DEMO_TARGETS = ROOT / "examples/demo_room_targets.json"

FLOOR_Z = 0.12

#: Deliberately not matching any label the tests use. A class prior widens the
#: crop and a neighbour's reach, and a test about the fit should not be measuring
#: a preset as well. The cases that want a prior say so.
PRESET = {"classes": [
    {"id": "cabinet", "en": "cabinet", "zh": "柜", "size_m": [0.9, 0.5, 1.8]},
    {"id": "stool", "en": "stool", "zh": "凳", "size_m": [0.55, 0.55, 0.6]},
]}


# ------------------------------------------------------------------ fixtures

def _steps(lo: float, hi: float, step: float) -> list[float]:
    n = max(1, int(round((hi - lo) / step)))
    return [lo + i * (hi - lo) / n for i in range(n + 1)]


def box_points(centre, size, z_range, yaw_deg=0.0, step=0.03, top=True) -> list:
    """The faces of an upright box, sampled the way the mesh sampler samples.

    Faces and not a filled block, on purpose. The fit takes p02-p98 spans, and
    over a solid block of evenly spread points those quantiles land 4% inside
    the real extent -- an error the fitter would never make on a mesh, because a
    mesh is a surface and its sides carry real mass at the extremes.
    """
    w, d = size
    z0, z1 = z_range
    us, vs, zs = _steps(-w / 2, w / 2, step), _steps(-d / 2, d / 2, step), _steps(z0, z1, step)
    local = []
    for z in zs:
        for u in us:
            local += [(u, -d / 2, z), (u, d / 2, z)]
        for v in vs:
            local += [(-w / 2, v, z), (w / 2, v, z)]
    if top:
        local += [(u, v, z1) for u in us for v in vs]
    c, s = math.cos(math.radians(yaw_deg)), math.sin(math.radians(yaw_deg))
    return [(centre[0] + u * c - v * s, centre[1] + u * s + v * c, z) for u, v, z in local]


def floor_points(z: float, half: float = 2.0, step: float = 0.06) -> list:
    return [(x, y, z) for x in _steps(-half, half, step) for y in _steps(-half, half, step)]


def target(oid: str, xy, radius: float, label: str = "widget") -> dict:
    return {"object_id": oid, "label": label, "xy": list(xy),
            "radius_m": radius, "extra": {}}


def run(cloud: list, targets: list, floor: float = FLOOR_Z,
        z_max_m: float = fit.DEFAULT_Z_MAX_M) -> dict:
    return {r["object_id"]: r
            for r in fit.fit_all(cloud, targets, PRESET, floor, z_max_m=z_max_m)}


# --------------------------------------------------------------- the footprint

def test_a_box_is_fitted_back_to_the_pose_it_was_built_at():
    cloud = floor_points(FLOOR_Z) + box_points((1.0, -0.5), (0.90, 0.50), (FLOOR_Z, 0.92))
    r = run(cloud, [target("a", (1.0, -0.5), 0.55)])["a"]

    assert r["box"] is not None
    assert r["box"]["centre"] == pytest.approx((1.0, -0.5), abs=0.03)
    assert r["box"]["width_m"] == pytest.approx(0.90, abs=0.04)
    assert r["box"]["depth_m"] == pytest.approx(0.50, abs=0.04)
    assert r["box"]["yaw_deg"] == pytest.approx(0.0, abs=2.0)
    # 0.92 - 0.12, quantised up to the top of its Z_BIN_M bin
    assert r["box"]["height_m"] == pytest.approx(0.80, abs=0.06)
    assert r["confidence"] == "high"
    assert r["needs_manual"] is False and r["note"] == ""


def test_a_turned_box_keeps_its_yaw_in_one_half_open_interval():
    """Thirty degrees and a hundred and twenty are the same rectangle turned by a
    right angle, and a fitter that reports them differently has published two
    boxes for one object."""
    for built, expected in ((30.0, 30.0), (120.0, -60.0)):
        cloud = floor_points(FLOOR_Z) + box_points(
            (0.0, 0.0), (0.90, 0.50), (FLOOR_Z, 0.92), yaw_deg=built)
        r = run(cloud, [target("a", (0.0, 0.0), 0.55)])["a"]

        assert -90.0 <= r["box"]["yaw_deg"] < 90.0
        assert r["box"]["yaw_deg"] == pytest.approx(expected, abs=2.0)
        assert r["box"]["width_m"] == pytest.approx(0.90, abs=0.04)


def test_the_long_side_is_published_first_whichever_way_it_was_built():
    """A width/depth swap is the same box turned by ninety degrees, so a fit
    published short-side-first has a yaw that means the short axis -- which is
    how a box comes out at right angles to the object it was fitted to."""
    cloud = floor_points(FLOOR_Z) + box_points((0.0, 0.0), (0.40, 0.90), (FLOOR_Z, 0.92))
    r = run(cloud, [target("a", (0.0, 0.0), 0.55)])["a"]

    assert r["box"]["width_m"] > r["box"]["depth_m"]
    assert r["box"]["width_m"] == pytest.approx(0.90, abs=0.04)
    assert abs(r["box"]["yaw_deg"]) == pytest.approx(90.0, abs=2.0)
    assert "axis_normalised" in r["rules"]


def test_a_square_is_not_fitted_on_its_diagonal():
    """A square has no long axis, so the axis of largest spread is whichever way
    its noise leaned -- and a 0.50 m square fitted on its diagonal comes out
    0.68 x 0.68, a third too big in both directions."""
    cloud = floor_points(FLOOR_Z) + box_points((0.0, 0.0), (0.50, 0.50), (FLOOR_Z, 0.92))
    r = run(cloud, [target("a", (0.0, 0.0), 0.4)])["a"]

    assert r["box"]["width_m"] == pytest.approx(0.50, abs=0.04)
    assert r["box"]["depth_m"] == pytest.approx(0.50, abs=0.04)


# ------------------------------------------------------------- the neighbours

def _pair_cloud() -> list:
    """Two bodies close enough that one crop holds both. Each claim covers its
    own body (half-diagonal 0.36) and stops short of the other's."""
    return (floor_points(FLOOR_Z)
            + box_points((0.0, 0.0), (0.60, 0.40), (FLOOR_Z, 0.72))
            + box_points((0.75, 0.0), (0.60, 0.40), (FLOOR_Z, 0.72)))


def test_a_neighbour_in_the_same_crop_does_not_widen_the_box():
    """Two bodies this close are one blob to any amount of looking at the points
    -- the neighbour's own claim has to tell them apart. The pair: with the
    neighbour declared the fit stops at its own end; without it, one box swallows
    whatever the window reached, which is the failure this rule exists for."""
    cloud = _pair_cloud()

    alone = run(cloud, [target("mine", (0.0, 0.0), 0.37)])["mine"]
    assert alone["box"]["width_m"] > 1.0, "without the neighbour it really is one blob"

    pair = run(cloud, [target("mine", (0.0, 0.0), 0.37),
                       target("theirs", (0.75, 0.0), 0.40)])["mine"]
    assert "neighbour_excluded" in pair["rules"]
    assert pair["box"]["width_m"] == pytest.approx(0.60, abs=0.05)
    assert pair["box"]["centre"][0] == pytest.approx(0.0, abs=0.05)


def test_points_inside_our_own_claim_are_never_yielded():
    """The neighbour's claim deliberately swallows our whole body. A rule that
    simply subtracted every claimed point would shave the box down to the part
    nobody else wanted -- here, to nothing at all."""
    greedy = run(_pair_cloud(), [target("mine", (0.0, 0.0), 0.37),
                                 target("theirs", (0.75, 0.0), 1.20)])["mine"]

    assert greedy["box"] is not None
    assert greedy["box"]["width_m"] == pytest.approx(0.60, abs=0.05)


def test_a_position_with_nothing_of_its_own_proposes_nothing():
    """A reference beside an object that is wholly claimed by another target has
    nothing left of its own, and saying so is the answer. Keeping the unfiltered
    crop in that case -- as the predecessor did, so that a subtraction could
    never empty an object out -- hands it a confident box around its neighbour.

    Note what it is NOT: a position standing *on* the neighbour keeps the disc it
    claims, because our own claim always outranks somebody else's."""
    cloud = floor_points(FLOOR_Z) + box_points((0.0, 0.0), (0.60, 0.40), (FLOOR_Z, 0.72))
    r = run(cloud, [target("mine", (0.55, 0.0), 0.10),
                    target("theirs", (0.0, 0.0), 0.40)])["mine"]

    assert r["box"] is None
    assert "too_few_points" in r["rules"]
    assert "by hand" in r["note"]


# ------------------------------------------------------------------ the height

def _tower_with_shelf(support: bool) -> list:
    """A body, a slab floating 0.40 m over it, and optionally a column between."""
    cloud = floor_points(FLOOR_Z) + box_points((0.0, 0.0), (0.50, 0.50), (FLOOR_Z, 0.92))
    cloud += box_points((0.0, 0.0), (0.50, 0.50), (1.32, 1.36))
    if support:
        cloud += box_points((0.0, 0.0), (0.08, 0.08), (0.92, 1.32))
    return cloud


def test_an_unsupported_shelf_above_it_is_not_its_top():
    """A shelf on the wall above a cabinet has nothing holding it up, so it is
    not the cabinet's top. Read as one object, the cabinet comes back 1.24 m
    tall against a real 0.80."""
    r = run(_tower_with_shelf(support=False), [target("a", (0.0, 0.0), 0.4)])["a"]

    assert r["box"]["height_m"] == pytest.approx(0.80, abs=0.06)
    assert "floating_mass_excluded" in r["rules"]


def test_a_second_tier_on_a_column_is_part_of_the_object():
    """The same slab, now standing on the object's own column: the gap is a
    waist, not a top, and the height carries on past it. The column covers
    almost none of the slab and holds a fraction of its points, so a
    share-of-the-points test would call this floating too."""
    r = run(_tower_with_shelf(support=True), [target("a", (0.0, 0.0), 0.4)])["a"]

    assert r["box"]["height_m"] == pytest.approx(1.24, abs=0.06)
    assert "floating_mass_excluded" not in r["rules"]


def test_a_column_that_never_breaks_is_a_bound_and_says_so():
    """An object welded to structure running out of the top of the crop has no
    break to find. The number is then the crop's own ceiling -- a bound, not a
    reading -- and publishing it quietly is how a fitted height gets cited as a
    measurement."""
    cloud = floor_points(FLOOR_Z) + box_points((0.0, 0.0), (0.40, 0.40), (FLOOR_Z, 3.0))
    r = {r["object_id"]: r for r in
         fit.fit_all(cloud, [target("a", (0.0, 0.0), 0.35)], PRESET, FLOOR_Z, z_max_m=2.0)}["a"]

    assert r["confidence"] == "low"
    assert "height_unbounded" in r["rules"]
    assert r["box"]["height_m"] == pytest.approx(2.0, abs=0.06)
    assert r["needs_manual"] is True and "bound" in r["note"]


def _stool_under_a_pole(pole: bool) -> list:
    """A 0.50 m stool with an unlabelled pole standing beside it, bridging every
    gap from the seat to the top of the crop. Nothing in the profile separates
    the two, which is the situation on a real theatre scan: the pole is an IV
    stand nobody put in the targets file, and the ceiling arm continues above."""
    cloud = floor_points(FLOOR_Z) + box_points((0.0, 0.0), (0.50, 0.50), (FLOOR_Z, 0.82))
    if pole:
        cloud += box_points((0.55, 0.0), (0.10, 0.10), (0.80, 2.30))
    return cloud


def test_a_pole_the_column_cannot_break_on_is_kept_out_of_the_footprint():
    """The height is a bound here -- so the plane fit was being handed the pole
    and the arm along with the stool, and the stool came back twice its width.
    A class prior says how much of an unbroken column can be one of these, and
    the fit is banded to it.

    The pair is the same scene with no class to draw a band from: there is then
    no honest width to narrow to, so the fit still takes the lot. The prior is
    the whole difference, and it must not touch the published height either way.

    What the band does here is take 1.4 m of pole out of the fit, which leaves
    the stub above the seat too light for the far end band to be anything but
    bare -- so the end trim, which could not touch a pole holding a quarter of
    the points, finishes the job. KNOWN LIMIT, measured: a pole flush against
    the object rather than standing off it stays inside the trimmed span, and
    the band alone brings that case back to 0.65 rather than 0.50.
    """
    cloud = _stool_under_a_pole(pole=True)

    banded = run(cloud, [target("a", (0.0, 0.0), 0.40, label="stool")],
                 z_max_m=2.0)["a"]
    assert banded["box"]["width_m"] == pytest.approx(0.50, rel=0.15)
    assert banded["box"]["depth_m"] == pytest.approx(0.50, rel=0.15)
    assert "prior_banded_footprint" in banded["rules"]

    # ... and the height is still the bound that was measured, not the prior.
    assert banded["box"]["height_m"] == pytest.approx(2.0, abs=0.06)
    assert banded["confidence"] == "low"
    assert "height_unbounded" in banded["rules"]
    assert banded["needs_manual"] is True

    # The control: same points, no class. Nothing to band with, so the pole is
    # still in the fit and the box is still too wide.
    unbanded = run(cloud, [target("a", (0.0, 0.0), 0.40)], z_max_m=2.0)["a"]
    assert "prior_banded_footprint" not in unbanded["rules"]
    assert unbanded["box"]["width_m"] > 0.75, "the pole is still in the fit"
    assert unbanded["points_used"] > banded["points_used"]
    assert unbanded["box"]["height_m"] == pytest.approx(2.0, abs=0.06)


def test_a_top_that_really_broke_is_never_banded_by_its_class_prior():
    """The same stool with nothing standing over it. Its column breaks, so the
    height is a reading -- and a reading is never second-guessed by a nominal
    size. A prior that could reach a fit that measured cleanly would be a preset
    quietly overwriting the mesh."""
    r = run(_stool_under_a_pole(pole=False),
            [target("a", (0.0, 0.0), 0.40, label="stool")], z_max_m=2.0)["a"]

    assert "prior_banded_footprint" not in r["rules"]
    assert "height_unbounded" not in r["rules"]
    assert r["box"]["width_m"] == pytest.approx(0.50, abs=0.04)
    assert r["box"]["depth_m"] == pytest.approx(0.50, abs=0.04)
    assert r["box"]["height_m"] == pytest.approx(0.70, abs=0.06)
    assert r["confidence"] != "low"
    assert r["needs_manual"] is False


def _column_with_a_whisker(top: float, ceiling: float) -> list:
    """A body up to ``top``, then a few stray points carrying on to ``ceiling``.

    The whisker is far too thin to count as solid, so the climb ends under it --
    but it is what makes the histogram run to the top of the crop, which is the
    difference between a profile that was seen to end and one that was cut off.
    """
    return (floor_points(FLOOR_Z)
            + box_points((0.0, 0.0), (0.40, 0.40), (FLOOR_Z, top))
            + [(0.0, 0.0, z) for z in _steps(top + 0.01, ceiling, 0.02)])


def test_a_top_needs_a_breaks_worth_of_headroom_to_count_as_a_top():
    """What ends the climb is GAP_BINS empty bins. Within that many bins of the
    crop's ceiling there is no room to see them, so the emptiness above a top is
    the crop's, not the room's -- and calling it a reading publishes a cart
    welded to a ceiling arm as a 2.39 m measurement, which is what a real scan
    did. Three pins: no headroom, exactly a break's worth, and more than that.

    The middle one is the whole reason the comparison carries a float's slack,
    and the crop is 1.93 m deep to put it there: its top edge is 38 * Z_BIN_M =
    1.9000000000000001 and the line it is measured against is 2.05 - 0.15 =
    1.9. Those are one number in metres and two floats, and an object with its
    whole break in view must not be called unmeasured by the last bit of a
    subtraction.
    """
    z_max = 1.93                      # ... so the crop's ceiling sits at 2.05
    ceiling = FLOOR_Z + z_max
    gap_m = fit.GAP_BINS * fit.Z_BIN_M

    for top, headroom_bins, bound in ((1.99, 1, True),
                                      (1.89, fit.GAP_BINS, False),
                                      (1.84, fit.GAP_BINS + 1, False)):
        cloud = _column_with_a_whisker(top, ceiling)
        r = run(cloud, [target("a", (0.0, 0.0), 0.30)], z_max_m=z_max)["a"]
        where = f"{headroom_bins} bin(s) of headroom"

        assert ("height_unbounded" in r["rules"]) is bound, where
        assert (r["confidence"] == "low") is bound, where
        if not bound:
            # measured: the top edge of the bin the body's own top fell in
            assert r["box"]["height_m"] == pytest.approx(
                math.floor(top / fit.Z_BIN_M + 1) * fit.Z_BIN_M - FLOOR_Z,
                abs=0.011), where
            assert r["box"]["height_m"] + FLOOR_Z <= ceiling - gap_m + 1e-9, where


def test_a_flat_top_does_not_make_the_body_under_it_look_empty():
    """A tabletop puts its whole area into one 5 cm bin. Measured against that
    spike the legs underneath hold a few percent each, read as a stack of gaps,
    and the table comes back as tall as its own knees."""
    cloud = (floor_points(FLOOR_Z)
             + box_points((0.0, 0.0), (0.30, 0.30), (FLOOR_Z, 0.74), top=False)
             + box_points((0.0, 0.0), (1.20, 0.80), (0.74, 0.78)))
    r = run(cloud, [target("a", (0.0, 0.0), 0.72)])["a"]

    assert r["box"]["height_m"] == pytest.approx(0.66, abs=0.06)
    assert r["box"]["width_m"] == pytest.approx(1.20, abs=0.05)


# ------------------------------------------------------------- the guard rails

def test_a_sliver_is_proposed_but_flagged():
    """A hollow rack fits a rectangle to its own rim. The predecessor refused to
    publish that at all, because its output went into a catalogue; here it is
    published flagged, because the destination is a person looking at the mesh
    and a wrong box they can drag beats an empty ring they must draw."""
    cloud = floor_points(FLOOR_Z) + box_points((0.0, 0.0), (0.90, 0.08), (FLOOR_Z, 0.72))
    r = run(cloud, [target("a", (0.0, 0.0), 0.5)])["a"]

    assert r["box"] is not None, "a flagged proposal is still a proposal"
    assert "sliver_guard" in r["rules"]
    assert r["needs_manual"] is True and "by hand" in r["note"]


def test_a_position_over_bare_floor_proposes_nothing():
    cloud = floor_points(FLOOR_Z) + box_points((1.0, -0.5), (0.90, 0.50), (FLOOR_Z, 0.92))
    r = run(cloud, [target("nothing", (-1.5, 1.0), 0.30)])["nothing"]

    assert r["box"] is None
    assert "too_few_points" in r["rules"]
    assert "mark it absent" in r["note"]
    assert r["needs_manual"] is True


def test_a_fit_far_from_its_class_nominal_is_flagged():
    """A tripwire, not a verdict: the box stands, and a person is told it is not
    the shape the preset led them to expect."""
    cloud = floor_points(FLOOR_Z) + box_points((0.0, 0.0), (1.80, 0.50), (FLOOR_Z, 0.92))
    r = run(cloud, [target("a", (0.0, 0.0), 0.95, label="cabinet")])["a"]

    assert r["box"]["width_m"] == pytest.approx(1.80, abs=0.05)
    assert "off_class_prior" in r["rules"]
    assert r["needs_manual"] is True

    # ... and the same body at the nominal size is not flagged.
    ok = run(floor_points(FLOOR_Z) + box_points((0.0, 0.0), (0.90, 0.50), (FLOOR_Z, 0.92)),
             [target("a", (0.0, 0.0), 0.55, label="cabinet")])["a"]
    assert "off_class_prior" not in ok["rules"]


def test_yaw_normalisation_matches_the_browsers():
    # Restated from geometry.js normYaw180; a proposal read back at a different
    # angle from the one it was written at is a different box.
    assert fit.norm_yaw(0.0) == pytest.approx(0.0)
    assert fit.norm_yaw(90.0) == pytest.approx(-90.0)
    assert fit.norm_yaw(120.0) == pytest.approx(-60.0)
    assert fit.norm_yaw(-100.0) == pytest.approx(80.0)
    assert fit.norm_yaw(180.0) == pytest.approx(0.0)


# ------------------------------------------------------------------- the floor

def test_the_floor_is_the_top_of_the_slab_not_its_underside():
    """A slab floor has an underside of exactly the area of its top, six
    centimetres below it. Taking the bigger histogram bin is a coin toss between
    them, and losing it puts every height in the room 6 cm out."""
    cloud = floor_points(0.06) + floor_points(FLOOR_Z) + box_points(
        (0.0, 0.0), (0.50, 0.50), (FLOOR_Z, 0.92))

    assert fit.floor_z(cloud) == pytest.approx(FLOOR_Z, abs=0.02)


def test_a_measured_floor_and_a_given_one_agree_on_the_same_room(tmp_path: Path):
    cloud = floor_points(FLOOR_Z) + box_points((1.0, -0.5), (0.90, 0.50), (FLOOR_Z, 0.92))
    measured = fit.floor_z(cloud)
    a = run(cloud, [target("a", (1.0, -0.5), 0.55)], floor=measured)["a"]
    b = run(cloud, [target("a", (1.0, -0.5), 0.55)], floor=FLOOR_Z)["a"]

    assert a["box"]["height_m"] == pytest.approx(b["box"]["height_m"], abs=0.02)


# --------------------------------------------------------------------- the glb

def test_a_glb_is_read_with_its_node_transforms():
    """Every piece of furniture in the demo room is a unit cube that a node
    scales and turns. Read without those transforms it is twenty-two overlapping
    one-metre boxes at the origin -- a cloud two metres across, not a room."""
    c = fit.cloud(DEMO)

    assert c.format == "glb"
    assert c.vertices > 0 and c.sampled > c.vertices, "a low-poly room needs face samples"
    xs = [p[0] for p in c.points]
    ys = [p[1] for p in c.points]
    zs = [p[2] for p in c.points]
    assert max(xs) - min(xs) == pytest.approx(6.5, abs=0.3)
    assert max(ys) - min(ys) == pytest.approx(5.3, abs=0.3)
    assert min(zs) == pytest.approx(0.06, abs=0.05)
    assert max(zs) == pytest.approx(3.2, abs=0.1)
    assert fit.points(DEMO) == c.points


def test_the_demo_room_measures_its_own_floor():
    # The demo's floor is at 0.12 on purpose: a room whose floor is at zero
    # cannot tell a tool that measures from one that got lucky.
    assert fit.floor_z(fit.cloud(DEMO).points) == pytest.approx(0.12, abs=0.02)


def test_the_demo_room_produces_proposals_a_person_can_open(tmp_path: Path):
    out = tmp_path / "proposals.json"
    info = fit.propose(DEMO, DEMO_TARGETS, out, classes="operating-room")

    doc = json.loads(out.read_text(encoding="utf-8"))
    assert doc["format"] == "meshmark/annotations" and doc["version"] == 1
    assert doc["source"]["floor_source"] == "measured from the mesh"
    assert doc["fit"]["constants"]["sliver_short_m"] == fit.SLIVER_SHORT_M

    # Not one of them is marked handled. The annotator reads a missing status as
    # pending, and a proposal that arrives already confirmed is a proposal nobody
    # ever opens.
    assert all("status" not in o for o in doc["objects"])
    assert {o["object_id"] for o in doc["objects"]} == {
        t["object_id"] for t in json.loads(DEMO_TARGETS.read_text())["objects"]}

    # The targets file names one object that is not in the room. It has to come
    # back with no box and a sentence, not with a box around whatever was near.
    ghost = next(o for o in doc["objects"] if o["object_id"] == "demo_infusion_pump_001")
    assert "box" not in ghost and "world_xy" not in ghost
    assert "absent" in ghost["note"]
    assert info["empty"] == 1 and info["proposals"] == len(doc["objects"]) - 1

    # ... and the table really is the table: 0.72 x 2.05, turned 12 degrees.
    table = next(o for o in doc["objects"] if o["object_id"] == "demo_operating_table_001")
    assert table["box"]["width_m"] == pytest.approx(2.05, abs=0.1)
    assert table["box"]["depth_m"] == pytest.approx(0.72, abs=0.1)
    assert table["box"]["yaw_deg"] == pytest.approx(fit.norm_yaw(102.0), abs=3.0)
    assert table["box"]["height_source"] == "fitted from the mesh"


def test_an_obj_is_read_as_vertices_and_faces(tmp_path: Path):
    p = tmp_path / "wedge.obj"
    p.write_text("v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n")
    c = fit.cloud(p)

    assert c.format == "obj"
    assert c.vertices == 4
    assert c.area_m2 == pytest.approx(1.0, abs=1e-6), "the quad must be fanned into two"
    assert c.sampled == pytest.approx(fit.SAMPLE_PER_M2, rel=0.2)


def test_a_gltf_buffer_is_found_whether_it_is_inline_or_beside_the_file(tmp_path: Path):
    """The .glb path never exercises this: a .gltf keeps its vertices in a
    separate file, or inline as base64, and a reader that only handles the
    binary chunk opens one of those as an empty room without complaining."""
    import base64
    import struct

    # One 4 m triangle in the z = 1 plane, placed by a node matrix rather than by
    # TRS -- the other half of the transform code, which glb never reaches here.
    blob = struct.pack("<9f", 0, 0, 1, 4, 0, 1, 0, 4, 1)
    doc = {
        "asset": {"version": "2.0"},
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "matrix": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1]}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}],
        "accessors": [{"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3"}],
        "bufferViews": [{"buffer": 0, "byteLength": len(blob)}],
        "buffers": [{"byteLength": len(blob), "uri": "geom.bin"}],
    }
    (tmp_path / "geom.bin").write_bytes(blob)
    (tmp_path / "beside.gltf").write_text(json.dumps(doc))

    inline = dict(doc, buffers=[{"byteLength": len(blob), "uri":
                                 "data:application/octet-stream;base64,"
                                 + base64.b64encode(blob).decode()}])
    (tmp_path / "inline.gltf").write_text(json.dumps(inline))

    for name in ("beside.gltf", "inline.gltf"):
        c = fit.cloud(tmp_path / name)
        assert c.vertices == 3, name
        assert c.area_m2 == pytest.approx(8.0, abs=1e-4), name
        # the node matrix moved it ten metres along x, and was not ignored
        assert min(p[0] for p in c.points) == pytest.approx(10.0, abs=1e-4), name
        assert c.sampled > 0, name


def test_a_gltf_that_names_a_buffer_it_does_not_have_says_which(tmp_path: Path):
    (tmp_path / "broken.gltf").write_text(json.dumps({
        "asset": {"version": "2.0"},
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}],
        "accessors": [{"bufferView": 0, "componentType": 5126, "count": 1, "type": "VEC3"}],
        "bufferViews": [{"buffer": 0, "byteLength": 12}],
        "buffers": [{"byteLength": 12, "uri": "gone.bin"}],
    }))
    with pytest.raises(fit.FitError, match="gone.bin"):
        fit.cloud(tmp_path / "broken.gltf")


def test_a_mesh_format_meshmark_cannot_read_says_how_to_convert(tmp_path: Path):
    p = tmp_path / "scan.ply"
    p.write_text("ply")
    with pytest.raises(Exception, match="glb"):
        fit.cloud(p)
