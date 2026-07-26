import { describe, expect, it } from "vitest";
import { buildPrompt, buildRepairPrompt } from "../prompt.js";
import {
  fosEnrollmentBriefAgentDefinition,
  ENROLLMENT_BRIEF_UNDETERMINED_PATHWAY,
  type EnrollmentBriefInput,
} from "../definitions/enrollment-brief.js";

const INPUT: EnrollmentBriefInput = {
  opportunity: { id: "00000000-0000-4000-8000-000000000001", stage: "reviewing" },
  person: {
    id: "00000000-0000-4000-8000-000000000002",
    firstName: "Ada",
    lastName: "Lovelace",
    currentRole: "Data Analyst",
  },
  application: {
    id: "00000000-0000-4000-8000-000000000003",
    formVersion: "v1",
    sourceReference: "website_application",
  },
  evidenceRecords: [
    { sourceRef: "person.current_role", sourceType: "person_field", content: "Data Analyst" },
    { sourceRef: "application.raw_payload.goal", sourceType: "application_field", content: "goal" },
  ],
  availablePathways: ["standard_track", "accelerated_track"],
};

const assembled = { manifest: { scopes: [] }, input: INPUT } as never;

describe("prompt vocabularies (P1.10e)", () => {
  it("FOS1-VOCAB-01: the permitted sourceRefs appear VERBATIM in the user turn", () => {
    const prompt = buildPrompt(fosEnrollmentBriefAgentDefinition, assembled);
    const parsed = JSON.parse(prompt.userContent) as {
      allowedValues: Record<string, string[]>;
    };
    // The first live run blocked 7/8 fixtures because the model cited
    // `person.currentRole` (the input schema's camelCase property) while the
    // gate only accepts `person.current_role` (the evidenceRecords spelling).
    // The exact accepted string must now be in front of the model.
    expect(parsed.allowedValues["observedFacts[].sourceRef"]).toEqual([
      "person.current_role",
      "application.raw_payload.goal",
    ]);
  });

  it("FOS1-VOCAB-02: the pathway vocabulary includes the undetermined sentinel", () => {
    const prompt = buildPrompt(fosEnrollmentBriefAgentDefinition, assembled);
    const parsed = JSON.parse(prompt.userContent) as { allowedValues: Record<string, string[]> };
    // The 8th fixture wrote a full sentence into recommendedPathway because it
    // had no legal way to say "none applies". The sentinel gives it one.
    expect(parsed.allowedValues["recommendedPathway"]).toContain(
      ENROLLMENT_BRIEF_UNDETERMINED_PATHWAY,
    );
    expect(parsed.allowedValues["recommendedPathway"]).toContain("standard_track");
  });

  it("FOS1-VOCAB-03: the RULE is static system-prompt policy; the VALUES never enter it (D9)", () => {
    const prompt = buildPrompt(fosEnrollmentBriefAgentDefinition, assembled);
    expect(prompt.systemPrompt).toContain("VERBATIM");
    // Input-derived strings must stay in the data channel. If a vocabulary
    // value could reach the system prompt, a caller-supplied sourceRef would
    // become indistinguishable from policy.
    expect(prompt.systemPrompt).not.toContain("person.current_role");
    expect(prompt.systemPrompt).not.toContain("standard_track");
  });

  it("FOS1-VOCAB-04: the vocabulary survives into the stage-6 repair prompt", () => {
    const prompt = buildPrompt(fosEnrollmentBriefAgentDefinition, assembled);
    const repair = buildRepairPrompt(prompt, ["recommendedPathway: invalid"]);
    // A repair that dropped the vocabulary would re-invite the original error.
    expect(repair.userContent).toContain("person.current_role");
    expect(repair.systemPrompt).toContain("VERBATIM");
  });

  it("FOS1-VOCAB-05: ANTI-DRIFT — the advertised vocabulary equals what the gates enforce", async () => {
    const prompt = buildPrompt(fosEnrollmentBriefAgentDefinition, assembled);
    const advertised = (
      JSON.parse(prompt.userContent) as { allowedValues: Record<string, string[]> }
    ).allowedValues;

    // Drive the REAL gates with a value taken from the advertised set. If the
    // prompt ever advertises something a gate rejects, the model is being
    // confidently told the wrong answer — worse than saying nothing. This is
    // the P-004 failure shape, caught structurally rather than by inspection.
    const gates = fosEnrollmentBriefAgentDefinition.deterministicGates;
    const factsGate = gates.find((g) => g.key.endsWith("facts-resolve-to-sources"))!;
    const pathwayGate = gates.find((g) => g.key.endsWith("recommended-pathway-available"))!;

    for (const ref of advertised["observedFacts[].sourceRef"]!) {
      const verdict = await factsGate.evaluate({
        workspaceId: "w",
        agentKey: "k",
        mode: "review",
        input: INPUT,
        output: { observedFacts: [{ statement: "s", sourceRef: ref }] },
      } as never);
      expect(verdict.allowed, `gate rejected advertised sourceRef "${ref}"`).toBe(true);
    }

    for (const pathway of advertised["recommendedPathway"]!) {
      const verdict = await pathwayGate.evaluate({
        workspaceId: "w",
        agentKey: "k",
        mode: "review",
        input: INPUT,
        output: { recommendedPathway: pathway },
      } as never);
      expect(verdict.allowed, `gate rejected advertised pathway "${pathway}"`).toBe(true);
    }
  });

  it("FOS1-VOCAB-06: a definition without promptVocabularies is unchanged (no allowedValues key)", () => {
    const prompt = buildPrompt(
      { key: "k", version: "1", objective: "o", permittedTools: [] },
      assembled,
    );
    expect(JSON.parse(prompt.userContent)).not.toHaveProperty("allowedValues");
    expect(prompt.systemPrompt).not.toContain("VERBATIM");
  });
});
