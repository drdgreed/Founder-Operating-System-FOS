import { describe, expect, it } from "vitest";
import { evalFixtureV2Schema } from "./eval-fixture.js";

const VALID = {
  fixture_id: "enrollment_brief.strong_fit",
  agent_key: "fos.enrollment_brief",
  schema_version: 2,
  description: "A well-evidenced, strong-fit applicant.",
  input: { availablePathways: ["standard_track"] },
  expected: {
    status: ["succeeded"],
    gate_outcomes: {
      "fos.enrollment_brief.mode-allowed": "pass",
      "fos.enrollment_brief.facts-resolve-to-sources": "pass",
    },
    artifact_version_status: ["in_review"],
    max_retry_count: 1,
    compliance_review_blocked: false,
    paired_control: null,
    control_must_match: [],
  },
  critical_if_failed: [],
};

describe("evalFixtureV2Schema", () => {
  it("FOS1-EVALFX-01: accepts a minimal valid v2 fixture", () => {
    expect(evalFixtureV2Schema.parse(VALID).fixture_id).toBe("enrollment_brief.strong_fit");
  });

  it("FOS1-EVALFX-02: rejects schema_version 1 — v1 fixtures must be converted, never guessed at", () => {
    expect(() => evalFixtureV2Schema.parse({ ...VALID, schema_version: 1 })).toThrow();
  });

  it("FOS1-EVALFX-03: rejects a fixture that permits artifact_version_status 'approved'", () => {
    expect(() =>
      evalFixtureV2Schema.parse({
        ...VALID,
        expected: { ...VALID.expected, artifact_version_status: ["in_review", "approved"] },
      }),
    ).toThrow();
  });

  it("FOS1-EVALFX-04: rejects an unknown gate outcome value", () => {
    expect(() =>
      evalFixtureV2Schema.parse({
        ...VALID,
        expected: {
          ...VALID.expected,
          gate_outcomes: { "fos.enrollment_brief.mode-allowed": "maybe" },
        },
      }),
    ).toThrow();
  });

  it("FOS1-EVALFX-05: rejects control_must_match when paired_control is null", () => {
    expect(() =>
      evalFixtureV2Schema.parse({
        ...VALID,
        expected: { ...VALID.expected, paired_control: null, control_must_match: ["status"] },
      }),
    ).toThrow();
  });

  it("FOS1-EVALFX-06: accepts a paired-control fixture with matching fields", () => {
    const parsed = evalFixtureV2Schema.parse({
      ...VALID,
      expected: {
        ...VALID.expected,
        paired_control: "enrollment_brief.strong_fit_control",
        control_must_match: ["status", "gate_evaluations", "artifact.version_status"],
      },
      critical_if_failed: ["paired_control"],
    });
    expect(parsed.expected.paired_control).toBe("enrollment_brief.strong_fit_control");
  });
});
