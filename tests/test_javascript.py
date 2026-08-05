"""Run the JavaScript through a parser and a test runner.

The bug that started this project was an identifier deleted from one line and
still read on another. It could not be caught, because the whole application
lived inside a Python string: no parser ever saw it, no linter, no test.

It is caught here twice over -- ``node --check`` sees the file as a module, and
``node --test`` runs the units that have no DOM in them. If node is not
installed the tests skip rather than pass, because a skipped check that reports
green is how this class of bug survives in the first place.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "src/meshmark/web"

node = pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")


@node
@pytest.mark.parametrize("path", sorted(WEB.glob("*.js")), ids=lambda p: p.name)
def test_parses_as_a_module(path: Path):
    result = subprocess.run(
        ["node", "--input-type=module", "--check"],
        input=path.read_text(encoding="utf-8"),
        capture_output=True, text=True,
    )
    assert result.returncode == 0, f"{path.name} does not parse:\n{result.stderr}"


@node
def test_unit_tests_pass():
    files = sorted(str(p.relative_to(ROOT)) for p in (ROOT / "tests/js").glob("*.test.mjs"))
    assert files, "no JavaScript tests found -- an empty run reports green"
    result = subprocess.run(
        ["node", "--test", *files], cwd=ROOT, capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_every_web_file_is_referenced():
    """A module nobody imports is dead weight in every bundle built."""
    text = "\n".join(
        p.read_text(encoding="utf-8") for p in [*WEB.glob("*.js"), WEB / "index.html"]
    )
    for path in WEB.iterdir():
        if path.name in ("index.html",):
            continue
        assert path.name in text, f"{path.name} is shipped but never referenced"


def test_no_language_is_hardcoded_in_the_markup():
    """Visible text in index.html must come from i18n, or it cannot be switched."""
    import re
    html = (WEB / "index.html").read_text(encoding="utf-8")
    body = html.split("<body>", 1)[1].split("</body>", 1)[0]
    # Scripts first -- their contents are not inside a tag, so tag-stripping
    # alone would hand back JavaScript and call it user-visible text.
    body = re.sub(r"<script\b.*?</script>", " ", body, flags=re.S)
    # Then strip tags, leaving whatever a user would read on the page.
    text = re.sub(r"<[^>]+>", " ", body)
    # The product name, the unit symbol, and a number the page overwrites on
    # load. Anything else in the markup is text nobody can switch the language of.
    allowed = {"meshmark", "m", "1.60"}
    leftovers = [w for w in text.split() if w not in allowed]
    assert leftovers == [], f"untranslatable text in index.html: {leftovers}"
