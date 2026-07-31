"""Load fixtures and run transcripts from disk.

The TypeScript side owns both shapes: `evalFixtureV2Schema` and
`runTranscriptSchema` in `packages/contracts`. Python re-validates only what it
must to grade safely, rather than mirroring those schemas field-for-field — a
second full schema in a second language is a drift surface, and the runner
already refuses to emit a transcript that does not parse.

What Python DOES enforce here is the pair of things a silent mismatch would
turn into a wrong grade: the fixture schema version, and the join key.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

#: The only fixture schema this grader understands. v1 fixtures carried
#: `output_schema_constraints` as English prose; grading them would mean
#: silently ignoring most of what they asserted, so they are REJECTED rather
#: than guessed at (design §6, "the grader rejects a v1 fixture").
SUPPORTED_FIXTURE_SCHEMA_VERSION = 2

#: Emitted by the runner when `runAgent` threw before inserting its `agent_run`
#: row. Mirrors `PLACEHOLDER_RUN_ID` in `@fos/contracts`. Every run that fails
#: that early carries this SAME value, which is why it is never a join key.
PLACEHOLDER_RUN_ID = "00000000-0000-4000-8000-000000000000"


class FixtureError(ValueError):
    """A fixture cannot be graded — wrong version, malformed, or unreadable."""


class TranscriptError(ValueError):
    """A transcript file cannot be graded."""


def transcript_key(fixture_id: str, repetition: int) -> str:
    """THE join key (F-B). Mirrors `transcriptKey` in `@fos/contracts`.

    Never `run_id`: a grader keyed on it looks correct on every healthy file and
    silently collapses rows on exactly the runs worth investigating, because
    `PLACEHOLDER_RUN_ID` repeats.
    """
    return f"{fixture_id} {repetition}"


@dataclass(frozen=True)
class Fixture:
    fixture_id: str
    agent_key: str
    description: str
    expected: dict[str, Any]
    critical_if_failed: tuple[str, ...]
    raw: dict[str, Any]

    @property
    def paired_control(self) -> str | None:
        value = self.expected.get("paired_control")
        return value if isinstance(value, str) else None

    @property
    def control_must_match(self) -> tuple[str, ...]:
        return tuple(self.expected.get("control_must_match") or ())


def load_fixture(path: Path) -> Fixture:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise FixtureError(f"{path.name}: unreadable or invalid JSON — {exc}") from exc

    if not isinstance(raw, dict):
        raise FixtureError(f"{path.name}: top level must be an object")

    version = raw.get("schema_version")
    if version != SUPPORTED_FIXTURE_SCHEMA_VERSION:
        # Loud, not lenient. A v1 fixture's constraints were prose this grader
        # cannot evaluate, so grading it would report a pass for assertions that
        # were never checked.
        raise FixtureError(
            f"{path.name}: schema_version {version!r} is not supported "
            f"(expected {SUPPORTED_FIXTURE_SCHEMA_VERSION}). "
            "v1 fixtures must be converted, never graded as-is."
        )

    for field in ("fixture_id", "agent_key", "description", "expected", "critical_if_failed"):
        if field not in raw:
            raise FixtureError(f"{path.name}: missing required field {field!r}")

    expected = raw["expected"]
    if not isinstance(expected, dict):
        raise FixtureError(f"{path.name}: `expected` must be an object")

    return Fixture(
        fixture_id=str(raw["fixture_id"]),
        agent_key=str(raw["agent_key"]),
        description=str(raw["description"]),
        expected=expected,
        critical_if_failed=tuple(raw["critical_if_failed"] or ()),
        raw=raw,
    )


def load_fixtures(directory: Path) -> dict[str, Fixture]:
    """Load every `*.json` fixture in `directory`, keyed by `fixture_id`."""
    if not directory.is_dir():
        raise FixtureError(f"fixture directory does not exist: {directory}")

    fixtures: dict[str, Fixture] = {}
    for path in sorted(directory.glob("*.json")):
        fixture = load_fixture(path)
        if fixture.fixture_id in fixtures:
            raise FixtureError(f"duplicate fixture_id {fixture.fixture_id!r} in {directory}")
        fixtures[fixture.fixture_id] = fixture

    if not fixtures:
        raise FixtureError(f"no fixtures found in {directory}")
    return fixtures


def load_transcripts(path: Path) -> list[dict[str, Any]]:
    """Load one JSONL transcript file.

    Each line is one `RunTranscript`. A malformed line names its own line
    number: a grader that says only "invalid JSON" for a 200-line file has
    turned a 10-second fix into a hunt.
    """
    if not path.is_file():
        raise TranscriptError(f"transcript file does not exist: {path}")

    transcripts: list[dict[str, Any]] = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            raise TranscriptError(f"{path.name}:{number}: invalid JSON — {exc}") from exc
        if not isinstance(row, dict):
            raise TranscriptError(f"{path.name}:{number}: each line must be an object")
        transcripts.append(row)

    if not transcripts:
        raise TranscriptError(f"{path.name}: no transcripts found")
    return transcripts


def load_transcript_dir(directory: Path) -> list[dict[str, Any]]:
    """Load every `*.jsonl` file in `directory`, concatenated."""
    if not directory.is_dir():
        raise TranscriptError(f"transcript directory does not exist: {directory}")

    rows: list[dict[str, Any]] = []
    for path in sorted(directory.glob("*.jsonl")):
        rows.extend(load_transcripts(path))

    if not rows:
        raise TranscriptError(f"no *.jsonl transcripts found in {directory}")
    return rows


def index_by_key(transcripts: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Index transcripts by `transcript_key`, refusing duplicates.

    A duplicate key means the same fixture/repetition was graded twice, which
    would double-count it in the pass rate. `run_id` deliberately plays no part.
    """
    index: dict[str, dict[str, Any]] = {}
    for row in transcripts:
        key = transcript_key(str(row.get("fixture_id")), int(row.get("repetition", 0)))
        if key in index:
            raise TranscriptError(
                f"duplicate transcript for {key!r} — the same fixture and repetition "
                "appears twice, which would double-count it"
            )
        index[key] = row
    return index
