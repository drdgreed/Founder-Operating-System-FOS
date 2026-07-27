import { describe, expect, it } from "vitest";
import { runTranscriptSchema } from "@fos/contracts";
import { runEvalSuite, stripEmptyAnthropicEnv, StubModelClient } from "../eval-run.js";

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

describe("P1.10c — live-mode plumbing", () => {
  it("FOS1-EVALRUN-08: stripEmptyAnthropicEnv removes EMPTY ANTHROPIC_* vars and leaves real ones (L-007)", () => {
    const saved = { ...process.env };
    try {
      process.env.ANTHROPIC_API_KEY = "";
      process.env.ANTHROPIC_AUTH_TOKEN = "";
      process.env.ANTHROPIC_REAL_VALUE = "keep-me";
      process.env.UNRELATED_EMPTY = "";

      const stripped = stripEmptyAnthropicEnv();

      // Empty ANTHROPIC_* vars must be DELETED, not set to undefined: the SDK
      // reads process.env directly and an empty string produces a token-less
      // "Authorization: Bearer " header, surfacing as a misleading
      // APIConnectionError rather than an auth failure.
      expect(stripped.sort()).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);
      expect("ANTHROPIC_API_KEY" in process.env).toBe(false);
      expect("ANTHROPIC_AUTH_TOKEN" in process.env).toBe(false);
      // Non-empty ANTHROPIC_* and empty non-ANTHROPIC vars are untouched.
      expect(process.env.ANTHROPIC_REAL_VALUE).toBe("keep-me");
      expect(process.env.UNRELATED_EMPTY).toBe("");
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });

  it("FOS1-EVALRUN-09: a run with no injected modelClient reports model 'stub', never a real model id", async () => {
    const transcripts = await runEvalSuite({ agentKey: "fos.enrollment_brief", repetitions: 1 });
    // The pipeline stamps DEFAULT_MODEL on the agent_run row regardless of
    // which client it was handed, so reading the row alone would misattribute
    // stub-generated output to a real model and corrupt the grader's record.
    expect(new Set(transcripts.map((t) => t.model))).toEqual(new Set(["stub"]));
  }, 120_000);

  it("FOS1-EVALRUN-10: an injected client's cache accounting reaches the transcript (F-N)", async () => {
    // The reason this test exists: `AnthropicModelClient` reports cache tokens
    // and `pipeline.ts` writes them to `agent_run.costJson`, but the transcript
    // is what SURVIVES a run — the eval database is a fresh PGlite instance
    // that is closed and discarded per fixture. Before P1.10o the transcript
    // dropped both fields, so a live run collected the data and threw it away,
    // and F-N could not be answered no matter how much was spent on it.
    //
    // Zod strips unknown keys from a non-strict object SILENTLY, so a schema
    // change alone proves nothing about the runner. This asserts the value
    // makes it all the way out.
    class CachingStub extends StubModelClient {
      override async generateStructured() {
        const result = await super.generateStructured();
        return {
          ...result,
          usage: {
            inputTokens: 300,
            outputTokens: 120,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 1081,
          },
        };
      }
    }

    const transcripts = await runEvalSuite({
      agentKey: "fos.enrollment_brief",
      repetitions: 1,
      modelClient: new CachingStub(),
    });

    // Only runs that reached the model carry the fields; a gate-blocked run
    // before stage 5 legitimately has none.
    const withUsage = transcripts.filter((t) => t.usage.output_tokens > 0);
    expect(withUsage.length).toBeGreaterThan(0);
    for (const t of withUsage) {
      expect(t.usage.cache_read_input_tokens).toBe(1081);
      expect(t.usage.cache_creation_input_tokens).toBe(0);
    }
  }, 120_000);
});
