import { describe, expect, it } from "vitest";
import { runTranscriptSchema } from "./eval-transcript.js";

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
});
