"""Turn graded fixtures into the PromotionReport the ladder already speaks.

`PromotionReport.promotable()` predates this slice and is unchanged:
`pass_rate >= threshold AND critical_failures == 0`. The grader's job is to
produce honest inputs for it.
"""

from __future__ import annotations

from .grading import GradedFixture
from .runner import FixtureResult, GateOutcome, PromotionReport, summarize


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


def format_report(report: PromotionReport, graded: list[GradedFixture], threshold: float) -> str:
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
