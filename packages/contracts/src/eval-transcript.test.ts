import { describe, expect, it } from "vitest";
import { runTranscriptSchema, transcriptKey, PLACEHOLDER_RUN_ID } from "./eval-transcript.js";

const VALID = {
  fixture_id: "enrollment_brief.strong_fit",
  agent_key: "fos.enrollment_brief",
  agent_version: "1.0.0",
  repetition: 0,
  control_for: null,
  run_id: "3f0d2a1e-0000-4000-8000-000000000001",
  status: "succeeded",
  mode: "review",
  retry_count: 0,
  declared_gate_keys: [
    "fos.enrollment_brief.mode-allowed",
    "fos.enrollment_brief.facts-resolve-to-sources",
    "fos.enrollment_brief.recommended-pathway-available",
  ],
  gate_evaluations: [{ key: "fos.enrollment_brief.mode-allowed", allowed: true }],
  compliance_review: { blocked: false },
  artifact: {
    artifact_id: "3f0d2a1e-0000-4000-8000-000000000002",
    version_id: "3f0d2a1e-0000-4000-8000-000000000003",
    version_status: "in_review",
  },
  projection_deferred: false,
  model: "stub",
  usage: { input_tokens: 10, output_tokens: 10 },
  latency_ms: 42,
  error: null,
};

describe("runTranscriptSchema", () => {
  it("FOS1-EVALTX-01: accepts a fully-populated succeeded transcript", () => {
    expect(runTranscriptSchema.parse(VALID).fixture_id).toBe("enrollment_brief.strong_fit");
  });

  it("FOS1-EVALTX-02: accepts a policy_blocked transcript with a null artifact", () => {
    const parsed = runTranscriptSchema.parse({
      ...VALID,
      status: "policy_blocked",
      artifact: null,
      gate_evaluations: [
        { key: "fos.enrollment_brief.mode-allowed", allowed: true },
        {
          key: "fos.enrollment_brief.facts-resolve-to-sources",
          allowed: false,
          reason: "unresolvable sourceRef",
        },
      ],
    });
    expect(parsed.artifact).toBeNull();
    expect(parsed.gate_evaluations[1]!.allowed).toBe(false);
  });

  it("FOS1-EVALTX-03: rejects an unknown status", () => {
    expect(() => runTranscriptSchema.parse({ ...VALID, status: "finished" })).toThrow();
  });

  it("FOS1-EVALTX-04: rejects an artifact whose version_status is approved — no eval run may auto-approve", () => {
    expect(() =>
      runTranscriptSchema.parse({
        ...VALID,
        artifact: { ...VALID.artifact, version_status: "approved" },
      }),
    ).toThrow();
  });

  it("FOS1-EVALTX-05: rejects gate_evaluations longer than declared_gate_keys (a prefix invariant)", () => {
    expect(() =>
      runTranscriptSchema.parse({
        ...VALID,
        declared_gate_keys: ["fos.enrollment_brief.mode-allowed"],
        gate_evaluations: [
          { key: "fos.enrollment_brief.mode-allowed", allowed: true },
          { key: "fos.enrollment_brief.facts-resolve-to-sources", allowed: true },
        ],
      }),
    ).toThrow();
  });

  it("FOS1-EVALTX-06: cache accounting is preserved when present, and ABSENT stays absent", () => {
    // Absent and zero must stay distinguishable. Absent = never measured (every
    // transcript written before #135/P1.10o, and every stub run). Zero =
    // measured, and nothing was served from cache — which per the CLAUDE.md
    // Claude-API standard means a silent invalidator or a prefix under the
    // model's cacheable minimum. A required-with-default-0 field would collapse
    // the two and erase the only signal F-N turns on.
    const absent = runTranscriptSchema.parse(VALID);
    expect(absent.usage.cache_read_input_tokens).toBeUndefined();
    expect(absent.usage.cache_creation_input_tokens).toBeUndefined();

    const measuredZero = runTranscriptSchema.parse({
      ...VALID,
      model: "claude-sonnet-5",
      usage: {
        input_tokens: 4000,
        output_tokens: 1500,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
    expect(measuredZero.usage.cache_read_input_tokens).toBe(0);

    const measuredHit = runTranscriptSchema.parse({
      ...VALID,
      model: "claude-sonnet-5",
      usage: {
        input_tokens: 300,
        output_tokens: 120,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 1081,
      },
    });
    expect(measuredHit.usage.cache_read_input_tokens).toBe(1081);
  });

  it("FOS1-EVALTX-07: a negative or fractional cache count is rejected", () => {
    for (const bad of [-1, 1.5]) {
      expect(() =>
        runTranscriptSchema.parse({
          ...VALID,
          usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: bad },
        }),
      ).toThrow();
    }
  });
});

describe("F-B: transcriptKey is the grader's primary key, not run_id", () => {
  it("FOS1-EVALTX-08: two early-failure transcripts COLLIDE on run_id but not on the key", () => {
    // The whole reason this helper exists. `runAgent` can throw before it
    // inserts an agent_run row — the thrown Error carries a message and no id —
    // so the runner emits PLACEHOLDER_RUN_ID. Every run that fails that early
    // carries the SAME run_id.
    //
    // A grader keyed on run_id is correct on every healthy file and silently
    // collapses rows on precisely the runs worth investigating.
    const a = runTranscriptSchema.parse({
      ...VALID,
      fixture_id: "enrollment_brief.alpha",
      status: "error",
      artifact: null,
      run_id: PLACEHOLDER_RUN_ID,
      error: "input validation failed",
    });
    const b = runTranscriptSchema.parse({
      ...VALID,
      fixture_id: "enrollment_brief.beta",
      status: "error",
      artifact: null,
      run_id: PLACEHOLDER_RUN_ID,
      error: "input validation failed",
    });

    expect(a.run_id).toBe(b.run_id);
    expect(new Set([a.run_id, b.run_id]).size).toBe(1);
    expect(transcriptKey(a)).not.toBe(transcriptKey(b));
    expect(new Set([transcriptKey(a), transcriptKey(b)]).size).toBe(2);
  });

  it("FOS1-EVALTX-09: repetitions of one fixture are distinguished by the key", () => {
    const r0 = runTranscriptSchema.parse({ ...VALID, repetition: 0 });
    const r1 = runTranscriptSchema.parse({ ...VALID, repetition: 1 });
    expect(transcriptKey(r0)).not.toBe(transcriptKey(r1));
  });
});

describe("F-Z: an evaluation_failed transcript must say WHY", () => {
  it("FOS1-EVALTX-10: evaluation_failed WITHOUT issues is unconstructible", () => {
    // Enforced at write time, so the defect cannot reach the grader at all.
    expect(() =>
      runTranscriptSchema.parse({ ...VALID, status: "evaluation_failed", artifact: null }),
    ).toThrow(/must record the validation issues/);
  });

  it("FOS1-EVALTX-11: evaluation_failed WITH issues parses", () => {
    const parsed = runTranscriptSchema.parse({
      ...VALID,
      status: "evaluation_failed",
      artifact: null,
      evaluation_issues: ["readiness: Invalid enum value", "(root): Required"],
    });
    expect(parsed.evaluation_issues).toHaveLength(2);
  });

  it("FOS1-EVALTX-12: issues on any OTHER status are rejected", () => {
    // A runner reporting validation failures for a run that did not fail
    // validation is a bug, and a silently-accepted one would mislead the
    // grader in the opposite direction.
    expect(() =>
      runTranscriptSchema.parse({ ...VALID, evaluation_issues: ["nope: should not be here"] }),
    ).toThrow(/only meaningful for evaluation_failed/);
  });
});
