"""Turn graded fixtures into the PromotionReport the ladder already speaks.

`PromotionReport.promotable()` predates this slice and is unchanged:
`pass_rate >= threshold AND critical_failures == 0`. The grader's job is to
produce honest inputs for it.
"""

from __future__ import annotations

from typing import Any

from .grading import GradedFixture
from .runner import FixtureResult, GateOutcome, PromotionReport, summarize

#: `model` the runner writes for a dry run. A report built from these is not a
#: promotion signal, however good the numbers look.
STUB_MODEL = "stub"


def to_results(graded: list[GradedFixture]) -> list[FixtureResult]:
    results: list[FixtureResult] = []
    for item in graded:
        if item.critical:
            outcome = GateOutcome.CRITICAL_FAIL
        elif item.passed:
            outcome = GateOutcome.PASS
        else:
            outcome = GateOutcome.FAIL
        results.append(
            FixtureResult(
                fixture_id=item.fixture_id,
                outcome=outcome,
                detail="; ".join(str(f) for f in item.failures),
            )
        )
    return results


def build_report(agent_key: str, graded: list[GradedFixture]) -> PromotionReport:
    return summarize(agent_key, to_results(graded))


def is_stub_run(transcripts: list[dict[str, Any]]) -> bool:
    """True if EVERY transcript came from the offline stub.

    A dry run proves the harness plumbing works. It says nothing about the
    model, and it cannot: output assertions are claims about model behaviour,
    and a single fixed stub payload cannot satisfy fixtures that assert
    OPPOSITE behaviours (objection_heavy wants at least 3 objections;
    no_objections wants at most 2). So a PromotionReport over stub transcripts
    is not merely uninformative — treating it as a promotion signal would let
    an agent be promoted on a run that never called a model.
    """
    return bool(transcripts) and all(t.get("model") == STUB_MODEL for t in transcripts)


def format_report(
    report: PromotionReport,
    graded: list[GradedFixture],
    threshold: float,
    stub_run: bool = False,
) -> str:
    lines: list[str] = []
    lines.append(f"=== PromotionReport — {report.agent_key} ===")
    lines.append(
        f"graded {report.total}  passed {report.passed}  "
        f"critical {report.critical_failures}  pass rate {report.pass_rate * 100:.1f}%"
    )
    lines.append("")

    failures = [g for g in graded if not g.passed]
    if failures:
        lines.append("FAILURES")
        for item in sorted(failures, key=lambda g: (not g.critical, g.fixture_id)):
            head = "CRITICAL" if item.critical else "fail"
            lines.append(f"  [{head}] {item.fixture_id} (rep {item.repetition})")
            for failure in item.failures:
                lines.append(f"      - {failure}")
        lines.append("")

    if stub_run:
        lines.append(
            "NOT PROMOTABLE — every transcript came from the offline stub. A dry run exercises\n"
            "the harness, never the model, and its output assertions cannot all be satisfiable at\n"
            "once. Re-run with --live before reading this as a promotion signal."
        )
        return "\n".join(lines)

    verdict = "PROMOTABLE" if report.promotable(threshold) else "NOT PROMOTABLE"
    reason = ""
    if not report.promotable(threshold):
        if report.critical_failures:
            # Stated separately because a critical failure blocks promotion at
            # ANY pass rate. A 96% run containing a successful injection is not
            # a promotable agent (D6).
            reason = f" — {report.critical_failures} critical failure(s) block promotion outright"
        else:
            reason = f" — pass rate {report.pass_rate * 100:.1f}% is below {threshold * 100:.0f}%"
    lines.append(f"{verdict}{reason}")
    return "\n".join(lines)
