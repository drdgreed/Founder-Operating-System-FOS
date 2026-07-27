import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { evalFixtureV2Schema, outputAssertionSchema } from "../eval-fixture.js";
import { runTranscriptSchema } from "../eval-transcript.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "fos-evals",
  "fixtures",
  "enrollment_brief",
);

const BASE_TRANSCRIPT = {
  fixture_id: "f",
  agent_key: "fos.enrollment_brief",
  agent_version: "1.0.0",
  repetition: 0,
  control_for: null,
  run_id: "3f0d2a1e-0000-4000-8000-000000000001",
  status: "succeeded",
  mode: "review",
  retry_count: 0,
  declared_gate_keys: ["g1"],
  gate_evaluations: [{ key: "g1", allowed: true }],
  compliance_review: { blocked: false },
  artifact: null,
  output: null,
  projection_deferred: false,
  model: "stub",
  usage: { input_tokens: 0, output_tokens: 0 },
  latency_ms: 1,
  error: null,
};

describe("output assertions (design §6.1)", () => {
  it("FOS1-OUTA-01: the transcript carries the agent's output", () => {
    const parsed = runTranscriptSchema.parse({
      ...BASE_TRANSCRIPT,
      output: { readiness: "ready_now", unknowns: [] },
    });
    expect(parsed.output).toEqual({ readiness: "ready_now", unknowns: [] });
  });

  it("FOS1-OUTA-02: output is nullable — a run blocked before stage 6 produced none", () => {
    expect(runTranscriptSchema.parse({ ...BASE_TRANSCRIPT, output: null }).output).toBeNull();
  });

  it("FOS1-OUTA-03: array ops require an array value, length ops a number", () => {
    expect(() => outputAssertionSchema.parse({ path: "a", op: "in", value: "x" })).toThrow();
    expect(() =>
      outputAssertionSchema.parse({ path: "a", op: "min_length", value: "x" }),
    ).toThrow();
    expect(() => outputAssertionSchema.parse({ path: "a", op: "equals", value: ["x"] })).toThrow();
    expect(outputAssertionSchema.parse({ path: "a", op: "in", value: ["x"] }).op).toBe("in");
  });

  it("FOS1-OUTA-04: there is NO keyword/substring operator", () => {
    // Deliberate. A `contains_any` would re-introduce exactly the brittleness
    // that leaked four times through the keyword-based prohibited-guarantee
    // gate (lesson P-004) and forced its replacement by a semantic classifier.
    for (const op of ["contains", "contains_any", "matches", "regex", "includes"]) {
      expect(() => outputAssertionSchema.parse({ path: "a", op, value: "x" })).toThrow();
    }
  });

  it("FOS1-OUTA-05: output_assertions is optional — pre-amendment fixtures still parse", () => {
    const parsed = evalFixtureV2Schema.parse({
      fixture_id: "f",
      agent_key: "a",
      schema_version: 2,
      description: "d",
      input: {},
      expected: {
        status: ["succeeded"],
        gate_outcomes: { g: "pass" },
        artifact_version_status: ["in_review"],
        max_retry_count: 1,
        compliance_review_blocked: false,
        paired_control: null,
        control_must_match: [],
      },
      critical_if_failed: [],
    });
    expect(parsed.expected.output_assertions).toEqual([]);
  });

  it("FOS1-OUTA-06: the six fixtures that lost v1 constraints have them back", () => {
    const withAssertions = readdirSync(FIXTURE_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => evalFixtureV2Schema.parse(JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8"))))
      .filter((f) => f.expected.output_assertions.length > 0);

    // Six of eight fixtures previously asserted a byte-identical tuple and were
    // indistinguishable as tests. Each now pins something about the agent's
    // actual output.
    expect(withAssertions).toHaveLength(6);
    const ids = withAssertions.map((f) => f.fixture_id).sort();
    expect(ids).not.toContain("enrollment_brief.prompt_injection");
    expect(ids).not.toContain("enrollment_brief.prompt_injection_control");
  });

  it("FOS1-OUTA-07: the restored assertions would actually FAIL a bad output", () => {
    // An assertion nobody has seen fail is not evidence. `incomplete_information`
    // exists to catch a model that fills an evidence gap by guessing; this pins
    // that its assertions reject exactly that behaviour.
    const fixture = evalFixtureV2Schema.parse(
      JSON.parse(readFileSync(join(FIXTURE_DIR, "incomplete_information.json"), "utf8")),
    );
    const assertions = fixture.expected.output_assertions;

    const goodOutput: Record<string, unknown> = {
      readiness: "insufficient_information",
      recommendedPathway: "undetermined",
      unknowns: ["no stated goal"],
    };
    // A model that guessed rather than admitting the gap.
    const badOutput: Record<string, unknown> = {
      readiness: "ready_now",
      recommendedPathway: "accelerated_track",
      unknowns: [],
    };

    const check = (out: Record<string, unknown>, a: (typeof assertions)[number]): boolean => {
      const actual = out[a.path];
      switch (a.op) {
        case "equals":
          return actual === a.value;
        case "not_equals":
          return actual !== a.value;
        case "in":
          return (a.value as string[]).includes(actual as string);
        case "not_in":
          return !(a.value as string[]).includes(actual as string);
        case "min_length":
          return Array.isArray(actual) && actual.length >= (a.value as number);
        case "max_length":
          return Array.isArray(actual) && actual.length <= (a.value as number);
      }
    };

    expect(assertions.every((a) => check(goodOutput, a))).toBe(true);
    // All three must reject the guessing output — not just one.
    expect(assertions.filter((a) => !check(badOutput, a))).toHaveLength(3);
  });
});
