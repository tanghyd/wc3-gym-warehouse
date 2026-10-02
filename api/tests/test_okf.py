"""The docs/okf bundle conforms to OKF v0.2 and is safe to publish: every concept has a
type, a title, a description and tags from the vocabulary; index files carry no
frontmatter (the root one only its version) and list their directory with each concept's
own description; every relative link and source path resolves; no file holds an id, a
credential, a hostname or an IP address; and every dbt model is named in a Data Model
concept. Needs no server."""

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
BUNDLE = ROOT / "docs" / "okf"
LINK = re.compile(r"\]\(([^)\s]+)\)")
RESOURCE = re.compile(r"^\s*resource: (\S+)\s*$", re.MULTILINE)
files = sorted(BUNDLE.rglob("*.md"))
CONCEPTS = [p for p in files if p.name not in ("index.md", "log.md")]
INDEXES = [p for p in files if p.name == "index.md"]
# YAML reads a bare `a: b` value as a nested key, so a value that holds `: ` is quoted
UNQUOTED_COLON = re.compile(r"^\s*(?:- )?[\w-]+: (?![\"'\[{|>]).*: ", re.MULTILINE)
INDEX_ENTRY = re.compile(r"^\* \[[^\]]+\]\(([^)]+)\) - (.+)$", re.MULTILINE)
# The areas a concept may be tagged with; `type` already says what kind of file it is
TAGS = {"pipeline", "data", "api", "web", "deploy", "observability", "testing", "tooling"}
# Content that must never appear in a public bundle: an id-shaped digit run, an email, a
# connection string, a token, a deployment hostname, an IP address.
SENSITIVE = re.compile(
    r"[0-9]{10,}"
    r"|[\w.+-]+@[\w-]+\.[a-z]{2,}"
    r"|(postgres(ql)?|mysql|redis|mongodb|clickhouse)://"
    r"|eyJ[A-Za-z0-9_-]{10,}"
    r"|\b(sk|pk|whsec|ghp|gho|github_pat)_[A-Za-z0-9]"
    r"|Bearer [A-Za-z0-9._-]{20,}"
    r"|\.(vercel\.app|r2\.cloudflarestorage\.com|hetzner\.cloud|trycloudflare\.com)\b"
    r"|\b(\d{1,3}\.){3}\d{1,3}\b",
    re.IGNORECASE,
)


def frontmatter(text: str) -> str | None:
    if not text.startswith("---\n"):
        return None
    end = text.find("\n---\n", 4)
    return text[4:end] if end > 0 else None


def description(path: Path) -> str:
    found = re.search(r"^description: (.+)$", frontmatter(path.read_text()) or "", re.MULTILINE)
    assert found, f"{path.name} has no description"
    text = found.group(1).strip()
    return text[1:-1].replace('\\"', '"') if text.startswith('"') else text


@pytest.mark.parametrize("path", files, ids=lambda p: str(p.relative_to(BUNDLE)))
def test_frontmatter(path: Path) -> None:
    fm = frontmatter(path.read_text())
    if path.name == "index.md":
        allowed = 'okf_version: "0.2"' if path.parent == BUNDLE else None
        assert fm is None or fm.strip() == allowed, "index.md carries no frontmatter"
        return
    if path.name == "log.md":
        assert fm is None, "log.md carries no frontmatter"
        return
    assert fm is not None, "a concept starts with a YAML block"
    assert re.search(r"^type: \S", fm, re.MULTILINE), "a concept names its type"
    assert re.search(r"^title: \S", fm, re.MULTILINE), "a concept has a title"
    tags = re.search(r"^tags: \[(.*)\]$", fm, re.MULTILINE)
    assert tags, "tags is a list"
    unknown = {t.strip() for t in tags.group(1).split(",")} - TAGS
    assert not unknown, f"tags outside the vocabulary: {sorted(unknown)}"
    description(path)
    hit = UNQUOTED_COLON.search(fm)
    assert hit is None, f"quote the value: {hit.group().strip()!r}"


@pytest.mark.parametrize("path", files, ids=lambda p: str(p.relative_to(BUNDLE)))
def test_links_resolve(path: Path) -> None:
    text = path.read_text()
    for target in LINK.findall(text) + RESOURCE.findall(text):
        if target.startswith(("http://", "https://", "#", "mailto:")) or not target.startswith((".", "/")):
            continue
        assert (path.parent / target.split("#")[0]).exists(), f"{target} does not resolve"


@pytest.mark.parametrize("path", INDEXES, ids=lambda p: str(p.relative_to(BUNDLE)))
def test_index_lists_its_directory(path: Path) -> None:
    listed = dict(INDEX_ENTRY.findall(path.read_text()))
    for concept in sorted(path.parent.glob("*.md")):
        if concept.name in ("index.md", "log.md"):
            continue
        assert concept.name in listed, f"{concept.name} is not in the index"
        assert listed[concept.name] == description(concept), f"the index line for {concept.name} is not its description"


@pytest.mark.parametrize("path", files, ids=lambda p: str(p.relative_to(BUNDLE)))
def test_no_sensitive_content(path: Path) -> None:
    hit = SENSITIVE.search(path.read_text())
    assert hit is None, f"looks sensitive: {hit.group()!r}"


def test_every_dbt_model_is_named_in_a_data_model_concept() -> None:
    models = sorted(p.stem for p in (ROOT / "dbt" / "models").rglob("*.sql"))
    assert models, "no dbt models found"
    text = "\n".join(p.read_text() for p in (BUNDLE / "data").glob("*.md") if p.name != "index.md")
    missing = [m for m in models if f"`{m}`" not in text]
    assert not missing, f"models in no Data Model concept: {missing}"
