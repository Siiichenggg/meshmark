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


def test_readme_images_exist():
    """A README whose images 404 is the first thing a visitor sees."""
    import re
    for name in ("README.md", "README.zh.md"):
        text = (ROOT / name).read_text(encoding="utf-8")
        refs = re.findall(r"!\[[^\]]*\]\(([^)]+)\)", text)
        # Badges are images too, and they live on other people's servers.
        local = [r for r in refs if not r.startswith(("http://", "https://"))]
        assert local, f"{name} shows no screenshot at all"
        for ref in local:
            assert (ROOT / ref).is_file(), f"{name} references missing image {ref}"


def test_readme_links_resolve():
    """A README that links to files which are not there wastes the reader's click."""
    import re
    for name in ("README.md", "README.zh.md"):
        text = (ROOT / name).read_text(encoding="utf-8")
        links = re.findall(r"(?<!!)\[[^\]]*\]\(([^)]+)\)", text)
        local = [l for l in links if not l.startswith(("http://", "https://", "#"))]
        broken = [l for l in local if not (ROOT / l).exists()]
        assert not broken, f"{name} links to missing files: {broken}"


def test_readme_quickstart_matches_shipped_examples():
    """The first command a reader runs must name files that are actually here."""
    text = (ROOT / "README.md").read_text(encoding="utf-8")
    for path in ("examples/demo_room.glb", "examples/demo_room_targets.json"):
        assert path in text, f"the quickstart no longer mentions {path}"
        assert (ROOT / path).is_file(), f"{path} is in the quickstart but not in the repo"


def _flags(text: str) -> set[str]:
    """Every command-line flag a document mentions, wherever it mentions it.

    Anywhere, not only inside backticks: the serve flags are documented inside
    one code span as ``[--port 8731] [--open]``, and a stricter pattern reported
    them as undocumented when they are on the page in front of you.
    """
    import re
    return set(re.findall(r"(--[a-z][a-z-]*)", text))


def test_the_two_readmes_stay_in_sync():
    """A bilingual project drifts the moment one language is updated alone.

    Not a translation check -- prose is prose. It compares the things that are
    the same in both by definition: section count, collapsible blocks, images,
    and every command-line flag either of them documents.
    """
    import re
    en = (ROOT / "README.md").read_text(encoding="utf-8")
    zh = (ROOT / "README.zh.md").read_text(encoding="utf-8")

    for what, pattern in [("sections", r"(?m)^## "), ("collapsibles", r"<details>")]:
        assert len(re.findall(pattern, en)) == len(re.findall(pattern, zh)), (
            f"the two READMEs have different numbers of {what}"
        )

    images = lambda t: sorted(re.findall(r"!\[[^\]]*\]\(([^)]+)\)", t))
    assert images(en) == images(zh), "the two READMEs show different images"

    only_en, only_zh = _flags(en) - _flags(zh), _flags(zh) - _flags(en)
    assert not only_en, f"documented in English only: {sorted(only_en)}"
    assert not only_zh, f"documented in Chinese only: {sorted(only_zh)}"


def test_every_command_line_flag_is_documented():
    """A flag the CLI accepts and the README never mentions is a hidden feature."""
    import re
    accepted = set(re.findall(r'"(--[a-z-]+)"', (ROOT / "src/meshmark/cli.py").read_text()))
    missing = accepted - _flags((ROOT / "README.md").read_text()) - {"--version"}
    assert not missing, f"accepted by the CLI, absent from the README: {sorted(missing)}"
