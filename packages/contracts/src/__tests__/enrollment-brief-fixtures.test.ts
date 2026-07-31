import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { evalFixtureV2Schema } from "../eval-fixture.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/contracts/src/__tests__ -> fos-evals/fixtures/enrollment_brief
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

/** The gates `fosEnrollmentBriefAgentDefinition` actually declares, in order.
 * Duplicated here deliberately: @fos/contracts must not depend on @fos/agents
 * (it is the lower layer). A drift between the two is caught by the runner's
 * own declared_gate_keys emission in Task 5. */
const DECLARED_GATES = [
  "fos.enrollment_brief.mode-allowed",
  "fos.enrollment_brief.facts-resolve-to-sources",
  "fos.enrollment_brief.recommended-pathway-available",
];

describe("enrollment_brief fixtures", () => {
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json"));

  it("FOS1-EVALFIX-01: there are 9 fixtures (7 scenarios + 1 paired control + 1 D6.3 case)", () => {
    // The 9th is flag_disabled.json (F-D): the only fixture that REQUIRES a
    // block, and the only one marking `status` critical.
    expect(files).toHaveLength(9);
  });

  it.each(files)("FOS1-EVALFIX-02: %s parses as schema v2", (file) => {
    const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8"));
    expect(() => evalFixtureV2Schema.parse(raw)).not.toThrow();
  });

  it.each(files)("FOS1-EVALFIX-03: %s asserts only gates the definition declares", (file) => {
    const parsed = evalFixtureV2Schema.parse(
      JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")),
    );
    // gate_outcomes is optional for a fixture that blocks before any gate runs
    // (F-D). Absent means "gates did not run", never "anything goes".
    for (const key of Object.keys(parsed.expected.gate_outcomes ?? {})) {
      expect(DECLARED_GATES).toContain(key);
    }
  });

  it("FOS1-EVALFIX-04: the injection fixture is paired with a control and is critical", () => {
    const parsed = evalFixtureV2Schema.parse(
      JSON.parse(readFileSync(join(FIXTURE_DIR, "prompt_injection.json"), "utf8")),
    );
    expect(parsed.expected.paired_control).toBe("enrollment_brief.prompt_injection_control");
    expect(parsed.critical_if_failed).toContain("paired_control");
  });

  it("FOS1-EVALFIX-05: no fixture permits an approved artifact version", () => {
    for (const file of files) {
      const parsed = evalFixtureV2Schema.parse(
        JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")),
      );
      expect(parsed.expected.artifact_version_status).not.toContain("approved");
    }
  });
});

describe("F-D: D6.3 coverage, and the gate_outcomes invariant that makes it safe", () => {
  const fixtureFiles = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json"));
  const D63 = JSON.parse(readFileSync(join(FIXTURE_DIR, "flag_disabled.json"), "utf8")) as Record<
    string,
    unknown
  >;

  it("FOS1-EVALFIX-06: exactly one fixture REQUIRES a block and marks status critical", () => {
    // D6.3 — "a succeeded where policy_blocked was expected" — had zero
    // coverage because every other fixture lists `succeeded` as acceptable,
    // so none of them can ever fail that way. This asserts the coverage
    // exists, so deleting it is a visible act rather than a silent one.
    const requiresBlock = fixtureFiles
      .map((f: string) =>
        evalFixtureV2Schema.parse(JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8"))),
      )
      .filter(
        (fx) =>
          fx.expected.status.length === 1 &&
          fx.expected.status[0] === "policy_blocked" &&
          fx.critical_if_failed.includes("status"),
      );
    expect(requiresBlock.map((f) => f.fixture_id)).toEqual(["enrollment_brief.flag_disabled"]);
  });

  it("FOS1-EVALFIX-07: the D6.3 fixture blocks BEFORE any gate, so it asserts none", () => {
    const parsed = evalFixtureV2Schema.parse(D63);
    expect(parsed.runner?.feature_flag_enabled).toBe(false);
    expect(parsed.expected.gate_outcomes).toBeUndefined();
  });

  it("FOS1-EVALFIX-08: omitting gate_outcomes WITHOUT the pre-gate block is rejected", () => {
    // The relaxation must not degrade into "sometimes forgotten". A normal
    // fixture that drops its gate assertions is a defect, and stays one.
    const { runner: _runner, ...noLever } = D63 as { runner?: unknown };
    expect(() => evalFixtureV2Schema.parse(noLever)).toThrow(/gate_outcomes is required/);
  });

  it("FOS1-EVALFIX-09: asserting gate_outcomes WITH the pre-gate block is also rejected", () => {
    // The other direction. Asserting a gate that cannot run would grade as
    // vacuously true forever.
    const contradictory = {
      ...D63,
      expected: {
        ...(D63.expected as object),
        gate_outcomes: { "fos.enrollment_brief.mode-allowed": "fail" },
      },
    };
    expect(() => evalFixtureV2Schema.parse(contradictory)).toThrow(/must not assert gate outcomes/);
  });
});
