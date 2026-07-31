/**
 * The eval runner (design §7 P1.10a). Executes every fixture for one agent
 * against an ephemeral eval database and writes one run transcript per run.
 *
 * SAFETY — one of `--dry-run` or `--live` is REQUIRED; neither is the default,
 * so an incomplete command line can never spend money by accident.
 *
 *   --dry-run  the model client is a local stub and stage 7b uses an
 *              always-allow reviewer. `AnthropicModelClient` is never
 *              constructed: no Anthropic call, no spend.
 *   --live     a real `AnthropicModelClient` is constructed and stage 7b falls
 *              through to the pipeline's real guarantee classifier — TWO model
 *              calls per fixture. This SPENDS MONEY (P1.10c).
 *
 * In BOTH modes the two non-model boundaries stay stubbed, because an eval run
 * must never touch canonical state:
 *   - the Notion client is a stub whose fetch never reaches the network, so no
 *     page can be written even with a real token in the environment;
 *   - the database is in-process PGlite, discarded when the run ends;
 *     `DATABASE_URL` is never read.
 *
 * Run from the repo root, in a REAL TERMINAL (see the empty-env-var note on
 * `stripEmptyAnthropicEnv` below — a Claude Code shell breaks live runs):
 *
 *   # free, no credentials, no network:
 *   npx tsx scripts/eval-run.ts --agent fos.enrollment_brief --dry-run
 *
 *   # LIVE — costs roughly $0.05 per fixture-run (agent call + ~15 compliance checks):
 *    export ANTHROPIC_API_KEY='sk-ant-...'      # leading space keeps it out of shell history
 *   npx tsx scripts/eval-run.ts --agent fos.enrollment_brief --live -n 1 --out ./transcripts
 *   unset ANTHROPIC_API_KEY
 *
 *   # ...or keep the key in a gitignored .env instead of exporting it:
 *   npx tsx --env-file=.env scripts/eval-run.ts --agent fos.enrollment_brief --live -n 1
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  evalFixtureV2Schema,
  runTranscriptSchema,
  type RunTranscript,
  PLACEHOLDER_RUN_ID,
} from "@fos/contracts";
import type { EventActor } from "@fos/contracts";
import {
  runAgent,
  AnthropicModelClient,
  DEFAULT_MODEL,
  fosEnrollmentBriefAgentDefinition,
  FOS_ENROLLMENT_BRIEF_AGENT_KEY,
  fosObjectionIntelligenceAgentDefinition,
  FOS_OBJECTION_INTELLIGENCE_AGENT_KEY,
  FOS_OBJECTION_INTELLIGENCE_FEATURE_FLAG_KEY,
  FOS_ENROLLMENT_BRIEF_FEATURE_FLAG_KEY,
  type ModelClient,
  type GenerateStructuredResult,
  type RunAgentContext,
} from "@fos/agents";
// The eval harness is deliberately NOT re-exported from @fos/agents's root
// barrel: `export *` is eager, and it would drag @electric-sql/pglite (a
// devDependency) into the production module graph of every consumer,
// including apps/worker. Import it by direct path instead.
import {
  createEvalDb,
  seedEnrollmentBriefFixture,
  seedObjectionIntelligenceFixture,
  setEvalFeatureFlag,
  createStubNotionClient,
  stubComplianceReviewer,
} from "../packages/agents/src/testing/eval-harness.js";
import { agentRun, artifactVersion } from "@fos/db/schema";
import { eq } from "drizzle-orm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, "..", "fos-evals", "fixtures");

const ACTOR: EventActor = { type: "system", id: "fos-evals" };
const TRIGGER = { type: "eval", source: "fos-evals" } as const;

/**
 * A deterministic, offline stand-in for the model. Emits a well-formed,
 * fully-grounded output so that in dry-run mode every gate is genuinely
 * exercised against a real structured payload — the harness plumbing is what
 * is under test, not the model.
 */
export class StubModelClient implements ModelClient {
  /**
   * The payload to emit. Defaults to the enrollment-brief shape so existing
   * callers are unchanged; the registry supplies one per agent, because a stub
   * emitting another agent's shape fails stage-6 validation and turns every
   * dry-run row into `evaluation_failed` — a green-looking harness that tested
   * nothing.
   */
  constructor(private readonly payload: unknown = ENROLLMENT_BRIEF_STUB_OUTPUT) {}

  async generateStructured(): Promise<GenerateStructuredResult> {
    return { output: this.payload, usage: { inputTokens: 0, outputTokens: 0 } };
  }
}

const ENROLLMENT_BRIEF_STUB_OUTPUT = {
  candidateSummary: "Applicant is a working data analyst targeting a senior analytics role.",
  observedFacts: [
    {
      statement: "Currently working as a Data Analyst at Acme Corp.",
      sourceRef: "person.current_role",
    },
  ],
  inferences: [{ statement: "Likely ready for an accelerated pathway.", confidence: "medium" }],
  unknowns: ["Budget authority is not stated."],
  readiness: "ready_now",
  fitStatus: "strong_fit",
  fitConfidence: "medium",
  fitRationale: "Relevant current role and a clearly stated three-month target.",
  recommendedPathway: "accelerated_track",
  objections: ["Price may be a concern."],
  discoveryQuestions: ["What is your budget range for this programme?"],
  riskFlags: [],
  nextAction: "Schedule a discovery call.",
};

/**
 * Stub payload for `fos.objection_intelligence`.
 *
 * `sourceRef` is REBOUND per fixture by the registry entry, to the first
 * evidence record that fixture actually supplies. A hardcoded sourceRef would
 * fail `observed-objection-has-source` on every fixture whose evidence happens
 * to be spelled differently — which would look like a gate finding a real
 * problem, and is the run-1 failure shape (the model grounding honestly against
 * a vocabulary nobody showed it).
 */
const OBJECTION_INTELLIGENCE_STUB_OUTPUT = {
  objections: [
    {
      category: "price",
      statement: "The programme fee is higher than the applicant budgeted for.",
      classification: "observed",
      severity: "medium",
      confidence: "medium",
      sourceRef: "PLACEHOLDER",
    },
    {
      category: "time",
      statement: "The applicant may not have the weekly hours the programme needs.",
      classification: "inferred",
      severity: "low",
      confidence: "low",
    },
  ],
  summary: "One observed price objection with a cited source, and one inferred time objection.",
};

export interface RunEvalSuiteOptions {
  agentKey: string;
  repetitions: number;
  /** When set, transcripts are also written to `<outDir>/<agentKey>.jsonl`. */
  outDir?: string;
  /** Defaults to a local `StubModelClient` (no Anthropic call). `--live`
   * injects a real `AnthropicModelClient` here — this is the ONLY seam; the
   * loop body below is identical in both modes. */
  modelClient?: ModelClient;
  /**
   * When true, stage 7b (semantic compliance review) falls through to the
   * pipeline's REAL default classifier — a SECOND model call per fixture, and
   * roughly half the cost of a live run. When false or omitted, the offline
   * always-allow `stubComplianceReviewer` is injected instead.
   *
   * Deliberately a separate switch from `modelClient` rather than being
   * inferred from it: leaving the stub in place during a live run would make
   * every transcript report `compliance_review: {blocked:false}` without the
   * classifier ever having looked at the output — a green result that proves
   * nothing, and exactly the class of silent gap this harness exists to catch.
   */
  useRealComplianceReviewer?: boolean;
}

/** Maps an agent key to its fixture directory name. */
/**
 * Everything the runner needs to execute ONE agent's fixtures.
 *
 * WHY THIS EXISTS. The design called P1.10d "mechanical fan-out — convert the
 * remaining 30 fixtures". It is not. `runEvalSuite` threw for any agent other
 * than `fos.enrollment_brief`; the only seeder in the harness is
 * `seedEnrollmentBriefFixture`; and `bindFixtureInput` understood exactly three
 * input keys. Meanwhile the other five agents' fixtures carry `interaction`,
 * `availableClaims`, `allowedActionsByStage`, `consentedChannels`,
 * `scheduledActivities`, `now`, `cooldownUntil` — different shapes needing
 * different canonical rows. Each agent needs a SEEDER and a BINDER, which is
 * design work per agent, not JSON conversion.
 *
 * This registry is the seam that turns that hidden work into visible work: one
 * entry per agent, and the loop below is agent-agnostic.
 *
 * `prepare` deliberately fuses seeding and id-rebinding into one call. Exposing
 * them separately would force the registry to be generic in the seeded row
 * type, which every heterogeneous entry would then have to widen away.
 */
interface EvalAgentSetup {
  /** Directory under `fos-evals/fixtures/`. */
  fixtureDir: string;
  definition: Parameters<typeof runAgent>[1];
  featureFlagKey: string;
  /**
   * Seed the canonical rows this agent's fixture input references, then rebind
   * the fixture's PLACEHOLDER entity ids onto them. The fixture's own UUIDs
   * exist nowhere in the database.
   */
  prepare(
    db: Awaited<ReturnType<typeof createEvalDb>>["db"],
    input: Record<string, unknown>,
  ): Promise<{ workspaceId: string; input: Record<string, unknown> }>;
  /**
   * `process.env` this agent's run requires. Saved and restored around every
   * run, so a caller's own value survives (including "not set at all").
   */
  env?: Readonly<Record<string, string>>;
  /**
   * Payload the dry-run stub emits for this agent. A stub emitting another
   * agent's shape fails stage-6 validation, turning every dry-run row into
   * `evaluation_failed` — a harness that runs green while testing nothing.
   *
   * Takes the prepared input so a payload can cite something the FIXTURE
   * actually supplies (e.g. a real `sourceRef`) rather than a constant that
   * only happens to match some fixtures.
   */
  stubOutput(input: Record<string, unknown>): unknown;
}

const EVAL_AGENTS: Record<string, EvalAgentSetup> = {
  [FOS_ENROLLMENT_BRIEF_AGENT_KEY]: {
    fixtureDir: "enrollment_brief",
    definition: fosEnrollmentBriefAgentDefinition,
    featureFlagKey: FOS_ENROLLMENT_BRIEF_FEATURE_FLAG_KEY,
    env: { FOS_NOTION_ENROLLMENT_DATA_SOURCE_ID: "stub-enrollment-data-source" },
    stubOutput: () => ENROLLMENT_BRIEF_STUB_OUTPUT,
    async prepare(db, input) {
      const seeded = await seedEnrollmentBriefFixture(db);
      const opportunity = { ...(input.opportunity as Record<string, unknown>) };
      const person = { ...(input.person as Record<string, unknown>) };
      const application = { ...(input.application as Record<string, unknown>) };
      opportunity.id = seeded.opportunity.id;
      opportunity.stage = seeded.opportunity.stage;
      person.id = seeded.person.id;
      application.id = seeded.application.id;
      return {
        workspaceId: seeded.workspace.id,
        input: { ...input, opportunity, person, application },
      };
    },
  },

  [FOS_OBJECTION_INTELLIGENCE_AGENT_KEY]: {
    fixtureDir: "objection_intelligence",
    definition: fosObjectionIntelligenceAgentDefinition,
    featureFlagKey: FOS_OBJECTION_INTELLIGENCE_FEATURE_FLAG_KEY,
    // No Notion data-source env: this agent has no Notion projection target,
    // which is exactly the kind of per-agent difference the registry exists to
    // hold rather than hardcode.
    stubOutput: (input) => {
      // Cite an evidence record the FIXTURE actually supplies. A constant
      // sourceRef would fail `observed-objection-has-source` on every fixture
      // spelled differently — which looks like the gate catching a real
      // problem, and is the live-run-1 failure shape.
      const records = (input.evidenceRecords as { sourceRef?: string }[] | undefined) ?? [];
      const firstRef = records[0]?.sourceRef;
      const objections = OBJECTION_INTELLIGENCE_STUB_OUTPUT.objections.map((objection) =>
        objection.classification === "observed" && firstRef
          ? { ...objection, sourceRef: firstRef }
          : objection,
      );
      // A fixture with NO evidence cannot legitimately yield an observed
      // objection, so the stub drops it rather than emitting an ungrounded one
      // the gate would (correctly) block.
      return {
        ...OBJECTION_INTELLIGENCE_STUB_OUTPUT,
        objections: firstRef
          ? objections
          : objections.filter((o) => o.classification !== "observed"),
      };
    },
    async prepare(db, input) {
      const seeded = await seedObjectionIntelligenceFixture(db);
      const opportunity = { ...(input.opportunity as Record<string, unknown>) };
      const person = { ...(input.person as Record<string, unknown>) };
      const interaction = { ...(input.interaction as Record<string, unknown>) };
      opportunity.id = seeded.opportunity.id;
      opportunity.stage = seeded.opportunity.stage;
      person.id = seeded.person.id;
      interaction.id = seeded.interaction.id;
      return {
        workspaceId: seeded.workspace.id,
        input: { ...input, opportunity, person, interaction },
      };
    },
  },
};

function loadFixtures(agentKey: string) {
  const setup = EVAL_AGENTS[agentKey];
  if (!setup) {
    throw new Error(
      `runEvalSuite: "${agentKey}" is not registered. Add an EVAL_AGENTS entry — it needs a ` +
        "seeder and an input binder, not just fixtures.",
    );
  }
  const dir = join(FIXTURE_ROOT, setup.fixtureDir);
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => evalFixtureV2Schema.parse(JSON.parse(readFileSync(join(dir, file), "utf8"))));
}

/** `paired_control` points forward; the transcript records the reverse edge. */
function buildControlIndex(fixtures: ReturnType<typeof loadFixtures>): Map<string, string> {
  const index = new Map<string, string>();
  for (const fixture of fixtures) {
    const control = fixture.expected.paired_control;
    if (control) index.set(control, fixture.fixture_id);
  }
  return index;
}

export async function runEvalSuite(options: RunEvalSuiteOptions): Promise<RunTranscript[]> {
  const setup = EVAL_AGENTS[options.agentKey];
  if (!setup) {
    throw new Error(
      `runEvalSuite: "${options.agentKey}" is not registered. Add an EVAL_AGENTS entry — it ` +
        "needs a seeder and an input binder, not just fixtures.",
    );
  }
  const definition = setup.definition;
  const declaredGateKeys = definition.deterministicGates.map((gate) => gate.key);
  const fixtures = loadFixtures(options.agentKey);
  const controlIndex = buildControlIndex(fixtures);
  // Whether the OUTPUT came from a real model. The pipeline records
  // DEFAULT_MODEL on the run row regardless of which client it was handed, so
  // the row alone cannot distinguish a stub run from a live one — and a
  // transcript that named a real model for stub-generated output would quietly
  // corrupt the grader's record and any cost accounting built on it.
  // The stub is built PER FIXTURE (below) so its payload can cite something
  // that fixture actually supplies. An injected client is used as given.
  const usedRealModel = options.modelClient !== undefined;
  const transcripts: RunTranscript[] = [];

  // Durability (one bad transcript must not discard every transcript already
  // produced): create the output file up front and APPEND each transcript as
  // it is parsed, rather than writing once after both loops finish. A throw
  // partway through (most plausibly `runTranscriptSchema.parse`) still loses
  // its own transcript, but every prior one is already durably on disk.
  const outPath = options.outDir ? join(options.outDir, `${options.agentKey}.jsonl`) : undefined;
  if (options.outDir && outPath) {
    mkdirSync(options.outDir, { recursive: true });
    writeFileSync(outPath, "", "utf8");
  }

  for (let repetition = 0; repetition < options.repetitions; repetition += 1) {
    for (const fixture of fixtures) {
      // A FRESH database per run: no run may observe another run's rows.
      const ctx = await createEvalDb();
      // A caller's own FOS_NOTION_ENROLLMENT_DATA_SOURCE_ID must survive this
      // run: save whatever was there (including "nothing") before overwriting
      // it below, and restore exactly that in `finally`. Declared outside the
      // `try` so the `finally` block (its own scope) can still see it.
      const priorEnv = new Map<string, string | undefined>(
        Object.keys(setup.env ?? {}).map((key) => [key, process.env[key]]),
      );
      try {
        const prepared = await setup.prepare(ctx.db, fixture.input);
        const modelClient =
          options.modelClient ?? new StubModelClient(setup.stubOutput(prepared.input));
        await setEvalFeatureFlag(ctx.db, {
          workspaceId: prepared.workspaceId,
          key: setup.featureFlagKey,
          // A fixture may disable the flag to force a deterministic stage-2
          // block (F-D). Defaults to enabled, so every other fixture is
          // unaffected.
          enabled: fixture.runner?.feature_flag_enabled ?? true,
          mode: "review",
        });
        for (const [key, value] of Object.entries(setup.env ?? {})) {
          process.env[key] = value;
        }
        const { client: notionClient } = createStubNotionClient();

        const runContext: RunAgentContext = {
          workspaceId: prepared.workspaceId,
          actor: ACTOR,
          trigger: TRIGGER,
        };

        const startedAt = Date.now();
        let result;
        let errorMessage: string | null = null;
        try {
          result = await runAgent(
            {
              db: ctx.db,
              modelClient,
              notionClient,
              // Omitting the key entirely (rather than passing undefined) is
              // what lets the pipeline fall through to its real default
              // classifier under --live.
              ...(options.useRealComplianceReviewer
                ? {}
                : { complianceReviewer: stubComplianceReviewer }),
            },
            definition,
            prepared.input,
            runContext,
          );
        } catch (caught) {
          errorMessage = caught instanceof Error ? caught.message : String(caught);
        }
        const latencyMs = Date.now() - startedAt;

        // The persisted run row carries the model id and token usage the
        // pipeline recorded (`costJson`). Absent only when `runAgent` threw
        // before inserting the row (a stage-1 validation failure).
        const [runRow] = result?.runId
          ? await ctx.db.select().from(agentRun).where(eq(agentRun.id, result.runId))
          : [];
        const runUsage = ((runRow?.costJson ?? null) as {
          inputTokens?: number;
          outputTokens?: number;
          cacheCreationInputTokens?: number;
          cacheReadInputTokens?: number;
        } | null) ?? { inputTokens: 0, outputTokens: 0 };
        const usageInput = runUsage.inputTokens ?? 0;
        const usageOutput = runUsage.outputTokens ?? 0;
        // Carried through ONLY for a run that actually called the model. A stub
        // run reporting a measured cache-read of 0 would look exactly like a
        // live run whose cache never hit — the one comparison F-N turns on.
        const usageCache = usedRealModel
          ? {
              cache_creation_input_tokens: runUsage.cacheCreationInputTokens ?? 0,
              cache_read_input_tokens: runUsage.cacheReadInputTokens ?? 0,
            }
          : {};

        let artifact: RunTranscript["artifact"] = null;
        if (result?.artifact) {
          const [version] = await ctx.db
            .select()
            .from(artifactVersion)
            .where(eq(artifactVersion.id, result.artifact.versionId));
          artifact = {
            artifact_id: result.artifact.artifactId,
            version_id: result.artifact.versionId,
            version_status: version!.approvalStatus as "draft" | "in_review" | "rejected",
          };
        }

        const transcript = runTranscriptSchema.parse({
          fixture_id: fixture.fixture_id,
          agent_key: definition.key,
          agent_version: definition.version,
          repetition,
          control_for: controlIndex.get(fixture.fixture_id) ?? null,
          run_id: result?.runId ?? PLACEHOLDER_RUN_ID,
          status: result?.status ?? "error",
          mode: result?.mode ?? "shadow",
          retry_count: result?.retryCount ?? 0,
          declared_gate_keys: declaredGateKeys,
          gate_evaluations: (result?.gateEvaluations ?? []).map((evaluation) => ({
            key: evaluation.key,
            allowed: evaluation.allowed,
            ...(evaluation.reason === undefined ? {} : { reason: evaluation.reason }),
          })),
          compliance_review: result?.complianceReview
            ? {
                blocked: result.complianceReview.blocked,
                ...(result.complianceReview.reason === undefined
                  ? {}
                  : { reason: result.complianceReview.reason }),
              }
            : null,
          artifact,
          // The Zod-validated model output, so fixtures can assert about the
          // agent's actual field values and not merely about gate outcomes.
          // Present on blocked runs too — the output that triggered a block is
          // the most diagnostic thing in the transcript.
          output: result?.output ?? null,
          projection_deferred: result?.projectionDeferred ?? false,
          // Read model + token usage back from the persisted `agent_run` row
          // rather than hardcoding them. Under --live these are the real model
          // id and the real token counts; a transcript that reported "stub" and
          // zero tokens for a run that actually cost money would corrupt both
          // the grader's record and any cost accounting built on it.
          model: usedRealModel ? (runRow?.model ?? DEFAULT_MODEL) : "stub",
          usage: {
            input_tokens: usageInput,
            output_tokens: usageOutput,
            ...usageCache,
          },
          latency_ms: latencyMs,
          error: errorMessage ?? (result?.status === "error" ? (result.reason ?? "error") : null),
        });
        transcripts.push(transcript);
        if (outPath) appendFileSync(outPath, JSON.stringify(transcript) + "\n", "utf8");
      } finally {
        // Restore exactly what was there, including "nothing".
        for (const [key, value] of priorEnv) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        await ctx.close();
      }
    }
  }

  return transcripts;
}

function parseArgs(argv: string[]) {
  const get = (flag: string) => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  return {
    agentKey: get("--agent") ?? FOS_ENROLLMENT_BRIEF_AGENT_KEY,
    repetitions: Number(get("-n") ?? get("--repetitions") ?? "1"),
    outDir: get("--out"),
    dryRun: argv.includes("--dry-run"),
    live: argv.includes("--live"),
  };
}

/**
 * Deletes EMPTY `ANTHROPIC_*` variables from the environment before any client
 * is constructed, and returns the names it removed.
 *
 * Why this exists (lesson L-007, learned twice on this machine): a Claude Code
 * shell exports `ANTHROPIC_API_KEY=""` and `ANTHROPIC_AUTH_TOKEN=""` as EMPTY
 * STRINGS. Empty is not unset — the Anthropic SDK reads them straight from
 * `process.env`, builds an `Authorization: Bearer ` header with no token, and
 * the resulting local `Illegal header value` is re-wrapped as
 * `APIConnectionError: Connection error`. That reads like blocked network
 * egress and is not; the previous diagnosis burned ~6 tool calls chasing a
 * sandbox red herring while `curl` returned a perfectly healthy 401.
 *
 * Deletion is the only fix that works. Passing `undefined` to the constructor
 * does not help: the SDK falls back to `process.env` and finds the empty string
 * again.
 */
export function stripEmptyAnthropicEnv(): string[] {
  const stripped: string[] = [];
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("ANTHROPIC_") && process.env[key] === "") {
      delete process.env[key];
      stripped.push(key);
    }
  }
  return stripped;
}

/**
 * Rough per-fixture-run cost at Sonnet 5 introductory pricing ($2/$10 per MTok
 * through 2026-08-31). Illustrative — used only for the pre-flight estimate,
 * never for billing.
 *
 * CORRECTED: an earlier value of 0.027 assumed TWO model calls per run (the
 * agent plus one compliance check). Stage 7b actually classifies EVERY distinct
 * non-empty text the agent rendered — candidateSummary, fitRationale,
 * nextAction, and each objection, discovery question, observed fact, inference,
 * risk flag, and unknown. A real enrollment brief yields 12-20 of them.
 *
 *   agent call:       ~4k in, ~1.5k out                    ~= $0.023
 *   ~15 classifier calls: ~500 in / ~100 out each          ~= $0.030
 *                                                             -------
 *                                                             ~$0.053
 *
 * Gate-blocked runs never reach stage 7b and cost only the agent call, so this
 * is an upper bound per run rather than a flat rate.
 */
const ESTIMATED_USD_PER_RUN = 0.053;

const isEntrypoint = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1]);

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Fail closed on the command line BEFORE any client is built. Neither flag
  // is a default: an incomplete command can never spend money by accident,
  // and passing both is a contradiction rather than a silent precedence rule.
  if (args.dryRun && args.live) {
    console.error("eval-run: --dry-run and --live are mutually exclusive. Pick one.");
    process.exit(2);
  }
  if (!args.dryRun && !args.live) {
    console.error(
      "eval-run: one of --dry-run (free, no credentials) or --live (SPENDS MONEY) is required.",
    );
    process.exit(2);
  }

  let modelClient: ModelClient | undefined;
  if (args.live) {
    const stripped = stripEmptyAnthropicEnv();
    if (stripped.length > 0) {
      console.error(
        `eval-run: removed ${stripped.length} EMPTY ${stripped.join(", ")} variable(s) from the environment (lesson L-007).\n` +
          "eval-run: an empty ANTHROPIC_* var makes the SDK send a token-less Bearer header, which surfaces as a\n" +
          "eval-run: misleading 'APIConnectionError: Connection error'. Removed so the real key is used instead.",
      );
    }
    // Pre-flight: refuse before spending, not after. `AnthropicModelClient`
    // reads the key by NAME at call time, so a missing key would otherwise
    // fail on the first fixture, after the DB and fixtures were already set up.
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error(
        "eval-run: --live requires a non-empty ANTHROPIC_API_KEY.\n" +
          "eval-run:   export ANTHROPIC_API_KEY='sk-ant-...'   (leading space keeps it out of shell history)\n" +
          "eval-run:   ...or: npx tsx --env-file=.env scripts/eval-run.ts ... --live\n" +
          "eval-run: Run from a REAL terminal — a Claude Code shell exports empty ANTHROPIC_* vars (L-007).",
      );
      process.exit(2);
    }
    const registered = EVAL_AGENTS[args.agentKey];
    const fixtureCount = registered
      ? readdirSync(join(FIXTURE_ROOT, registered.fixtureDir)).filter((f) => f.endsWith(".json"))
          .length
      : 0;
    const totalRuns = fixtureCount * args.repetitions;
    console.log(
      `eval-run: LIVE MODE — ${totalRuns} run(s) (${fixtureCount} fixtures x ${args.repetitions} repetition(s)) ` +
        `against ${DEFAULT_MODEL}, two model calls each.`,
    );
    console.log(
      `eval-run: estimated cost ~$${(totalRuns * ESTIMATED_USD_PER_RUN).toFixed(2)} (illustrative, not billing).`,
    );
    // `fetchImpl` is injected rather than defaulted — the same seam the tests
    // use to guarantee no hermetic run can reach the network.
    modelClient = new AnthropicModelClient({ fetchImpl: fetch });
  }

  const transcripts = await runEvalSuite({
    agentKey: args.agentKey,
    repetitions: args.repetitions,
    outDir: args.outDir,
    modelClient,
    // Live runs must exercise the REAL stage-7b classifier; leaving the stub
    // in would report compliance_review: {blocked:false} without the
    // classifier ever having read the output.
    useRealComplianceReviewer: args.live,
  });
  const byStatus = transcripts.reduce<Record<string, number>>((acc, t) => {
    acc[t.status] = (acc[t.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`eval-run: ${transcripts.length} transcript(s) for ${args.agentKey}`);
  console.log(`eval-run: status counts ${JSON.stringify(byStatus)}`);

  // Prompt-cache verdict, printed rather than left for someone to dig out of
  // the JSONL. CLAUDE.md's Claude-API standard requires checking the read rate
  // before caching is called done: a zero read across repeated identical-prefix
  // calls is a silent invalidator, not a working cache (F-N).
  const measured = transcripts.filter((t) => t.usage.cache_read_input_tokens !== undefined);
  if (measured.length > 0) {
    const read = measured.reduce((sum, t) => sum + (t.usage.cache_read_input_tokens ?? 0), 0);
    const written = measured.reduce(
      (sum, t) => sum + (t.usage.cache_creation_input_tokens ?? 0),
      0,
    );
    const uncached = measured.reduce((sum, t) => sum + t.usage.input_tokens, 0);
    console.log(
      `eval-run: prompt cache — ${read} tok read, ${written} tok written, ${uncached} tok uncached ` +
        `across ${measured.length} run(s) that called the model.`,
    );
    console.log(
      read > 0
        ? "eval-run: cache is HITTING. F-N answered — record the read rate in the follow-ups doc."
        : "eval-run: cache read is ZERO. Either the stable prefix is under the model's cacheable\n" +
            "eval-run: minimum (1024 tok on Sonnet 5 — the classifier prefix was only ESTIMATED at ~1081),\n" +
            "eval-run: or something ahead of the breakpoint varies per request. Do not call caching done.",
    );
  }
  if (args.outDir)
    console.log(`eval-run: written to ${join(args.outDir, `${args.agentKey}.jsonl`)}`);
}

if (isEntrypoint) {
  main().catch((err: unknown) => {
    console.error("eval-run: FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
