"""Command line: build a bundle, and serve one.

    meshmark build room.glb --out .annotate/room --classes operating-room
    meshmark serve .annotate/room

``serve`` binds to 127.0.0.1 and nothing else. The bundle contains a copy of
whatever mesh it was pointed at, which for a scan of a real room is not
something to put on a listening socket by accident.
"""

from __future__ import annotations

import argparse
import sys
import webbrowser
from pathlib import Path

from . import __version__
from .bundle import BundleError, build
from .classes import PresetError
from .mesh import MeshError
from .targets import TargetError
from .vendor import VendorError

ERRORS = (BundleError, PresetError, MeshError, TargetError, VendorError)


def _build_parser(sub) -> None:
    p = sub.add_parser("build", help="assemble an annotator bundle from a mesh")
    p.add_argument("mesh", help=".glb, .gltf or .obj")
    p.add_argument("--out", required=True, help="directory to write the bundle into")
    p.add_argument("--scene", help="name for this scene (default: the mesh filename)")
    p.add_argument("--classes", default="generic",
                   help="class preset: a built-in name or a path to JSON "
                        "(default: generic)")
    p.add_argument("--targets",
                   help="existing positions to annotate against, as JSON. Each "
                        "is drawn as a ring to confirm, correct or mark absent")
    p.add_argument("--lang", default="en", choices=("en", "zh"),
                   help="language for a browser that has not chosen one yet. "
                        "The in-page switch overrides it and is remembered, so "
                        "this is a default and not a setting")
    p.add_argument("--floor", type=float, dest="floor_z_m",
                   help="floor height in metres. Omit and it is measured from "
                        "the mesh, which is the right default: a scan's floor "
                        "is rarely at zero")
    p.add_argument("--plate-pixels", type=int, default=2048,
                   help="resolution of the top-down plate (default: 2048)")
    p.add_argument("--clip-height", type=float, default=1.6, dest="clip_height_m",
                   help="metres above the floor to cut the ceiling away at, in "
                        "both views (default: 1.6)")
    p.add_argument("--reference", action="append", default=[], metavar="NAME=X,Y",
                   help="a fixed point to draw but never edit, such as a robot "
                        "start pose; repeatable")
    p.add_argument("--preload", help="an exported annotation file to open with, "
                                     "when the browser has no saved work")
    p.add_argument("--three", help="path to a three.js package directory")
    p.add_argument("--link", action="store_true",
                   help="symlink the mesh instead of copying it")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="meshmark", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--version", action="version", version=f"meshmark {__version__}")
    sub = ap.add_subparsers(dest="cmd", required=True)
    _build_parser(sub)

    s = sub.add_parser("serve", help="serve a bundle on localhost")
    s.add_argument("bundle")
    s.add_argument("--port", type=int, default=8731)
    s.add_argument("--open", action="store_true", help="open a browser at it")

    args = ap.parse_args(argv)
    try:
        if args.cmd == "build":
            return _run_build(args)
        return _run_serve(args)
    except ERRORS as exc:
        print(f"meshmark: {exc}", file=sys.stderr)
        return 2


def _run_build(args) -> int:
    info = build(
        mesh=args.mesh, out=args.out, scene=args.scene, classes=args.classes,
        targets=args.targets, lang=args.lang, floor_z_m=args.floor_z_m,
        plate_pixels=args.plate_pixels, clip_height_m=args.clip_height_m,
        reference_points=args.reference, preload=args.preload,
        three=args.three, link=args.link,
    )
    print(
        f"{info['out']}/index.html\n"
        f"  scene {info['scene']} · {info['classes']} classes · "
        f"{info['targets']} reference targets"
        + (f" · baseline {info['baseline']}" if info["targets"] else "")
        + f"\n  mesh {info['mesh_mb']:.1f} MB · three {info['three']}\n"
        f"  meshmark serve {info['out']}"
    )
    return 0


def _run_serve(args) -> int:
    import functools
    import http.server

    root = Path(args.bundle).expanduser().resolve()
    if not (root / "index.html").is_file():
        print(f"meshmark: {root} has no index.html -- is it a bundle?", file=sys.stderr)
        return 2
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(root))
    # Loopback only, deliberately: a bundle carries a copy of whatever was
    # scanned, and 0.0.0.0 would put a room on the network by accident.
    with http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler) as httpd:
        url = f"http://127.0.0.1:{args.port}/"
        print(f"serving {root} at {url}  (ctrl-c to stop)")
        if args.open:
            webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
