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

  it("FOS1-EVALFIX-01: there are 8 fixtures (7 scenarios + 1 paired control)", () => {
    expect(files).toHaveLength(8);
  });

  it.each(files)("FOS1-EVALFIX-02: %s parses as schema v2", (file) => {
    const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8"));
    expect(() => evalFixtureV2Schema.parse(raw)).not.toThrow();
  });

  it.each(files)("FOS1-EVALFIX-03: %s asserts only gates the definition declares", (file) => {
    const parsed = evalFixtureV2Schema.parse(
      JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")),
    );
    for (const key of Object.keys(parsed.expected.gate_outcomes)) {
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
