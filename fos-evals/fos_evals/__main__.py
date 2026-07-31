"""CLI: python -m fos_evals grade <transcript-dir> --fixtures <dir>"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .grading import grade_all
from .loading import (
    FixtureError,
    TranscriptError,
    index_by_key,
    load_fixtures,
    load_transcript_dir,
)
from .report import build_report, format_report

#: Promotion threshold (design §2). A critical failure blocks regardless.
DEFAULT_THRESHOLD = 0.95

#: Exit codes are the contract with CI and with a human reading a terminal.
EXIT_PROMOTABLE = 0
EXIT_NOT_PROMOTABLE = 1
#: A load/usage error is NOT the same as "not promotable" — conflating them
#: would let a typo'd path read as a failing agent.
EXIT_USAGE = 2


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="fos_evals", description="Grade FOS eval transcripts.")
    sub = parser.add_subparsers(dest="command", required=True)

    grade = sub.add_parser("grade", help="grade a transcript directory against fixtures")
    grade.add_argument("transcript_dir", type=Path, help="directory of *.jsonl transcripts")
    grade.add_argument("--fixtures", type=Path, required=True, help="directory of *.json fixtures")
    grade.add_argument("--agent", default=None, help="agent key for the report (default: inferred)")
    grade.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD)

    args = parser.parse_args(argv)

    try:
        fixtures = load_fixtures(args.fixtures)
        transcripts = load_transcript_dir(args.transcript_dir)
        by_key = index_by_key(transcripts)
    except (FixtureError, TranscriptError) as exc:
        print(f"fos_evals: {exc}", file=sys.stderr)
        return EXIT_USAGE

    graded = grade_all(fixtures, by_key)
    agent_key = args.agent or next(iter(fixtures.values())).agent_key
    report = build_report(agent_key, graded)
    print(format_report(report, graded, args.threshold))
    return EXIT_PROMOTABLE if report.promotable(args.threshold) else EXIT_NOT_PROMOTABLE


if __name__ == "__main__":
    raise SystemExit(main())
