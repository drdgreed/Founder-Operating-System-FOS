import { describe, expect, it } from "vitest";
import { runTranscriptSchema } from "@fos/contracts";
import { runEvalSuite } from "../eval-run.js";

describe("eval runner (dry-run)", () => {
  it("FOS1-EVALRUN-01: emits one schema-valid transcript per fixture", async () => {
    const transcripts = await runEvalSuite({ agentKey: "fos.enrollment_brief", repetitions: 1 });
    expect(transcripts).toHaveLength(8);
    for (const transcript of transcripts) {
      expect(() => runTranscriptSchema.parse(transcript)).not.toThrow();
    }
  }, 120_000);

  it("FOS1-EVALRUN-02: emits N transcripts per fixture when repetitions > 1", async () => {
    const transcripts = await runEvalSuite({ agentKey: "fos.enrollment_brief", repetitions: 2 });
    expect(transcripts).toHaveLength(16);
    expect(new Set(transcripts.map((t) => t.repetition))).toEqual(new Set([0, 1]));
  }, 180_000);

  it("FOS1-EVALRUN-03: every transcript carries the definition's three declared gate keys", async () => {
    const transcripts = await runEvalSuite({ agentKey: "fos.enrollment_brief", repetitions: 1 });
    for (const transcript of transcripts) {
      expect(transcript.declared_gate_keys).toEqual([
        "fos.enrollment_brief.mode-allowed",
        "fos.enrollment_brief.facts-resolve-to-sources",
        "fos.enrollment_brief.recommended-pathway-available",
      ]);
    }
  }, 120_000);

  it("FOS1-EVALRUN-04: gate_evaluations is always an ordered prefix of declared_gate_keys", async () => {
    const transcripts = await runEvalSuite({ agentKey: "fos.enrollment_brief", repetitions: 1 });
    for (const transcript of transcripts) {
      transcript.gate_evaluations.forEach((evaluation, index) => {
        expect(evaluation.key).toBe(transcript.declared_gate_keys[index]);
      });
    }
  }, 120_000);

  it("FOS1-EVALRUN-05: the control transcript is tagged control_for its injection fixture", async () => {
    const transcripts = await runEvalSuite({ agentKey: "fos.enrollment_brief", repetitions: 1 });
    const control = transcripts.find(
      (t) => t.fixture_id === "enrollment_brief.prompt_injection_control",
    );
    expect(control!.control_for).toBe("enrollment_brief.prompt_injection");
  }, 120_000);

  it("FOS1-EVALRUN-06: no transcript reports an approved artifact version", async () => {
    const transcripts = await runEvalSuite({ agentKey: "fos.enrollment_brief", repetitions: 1 });
    for (const transcript of transcripts) {
      expect(transcript.artifact?.version_status).not.toBe("approved");
    }
  }, 120_000);

  it("FOS1-EVALRUN-07: runs actually execute — no transcript errors, and the happy path succeeds", async () => {
    const transcripts = await runEvalSuite({ agentKey: "fos.enrollment_brief", repetitions: 1 });

    // `error` means the harness itself broke (a failed seed, an unbound entity id,
    // a thrown runAgent). It is never a legitimate dry-run outcome, so any
    // occurrence is a harness defect rather than a model-behaviour signal.
    const errored = transcripts.filter((t) => t.status === "error");
    expect(errored.map((t) => `${t.fixture_id}: ${t.error}`)).toEqual([]);

    // At least one fixture must reach `succeeded`, which requires the model
    // output to satisfy the agent's Zod schema AND every gate to pass AND the
    // artifact to persist. Without this, an all-`evaluation_failed` run — the
    // exact failure this suite hit during development — reads as green.
    expect(transcripts.some((t) => t.status === "succeeded")).toBe(true);
  }, 120_000);
});
