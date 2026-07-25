/**
 * The eval runner (design §7 P1.10a). Executes every fixture for one agent
 * against an ephemeral eval database and writes one run transcript per run.
 *
 * SAFETY — this script is DRY-RUN ONLY. There is no `--live` flag in P1.10a:
 *   - the model client is a local stub; `AnthropicModelClient` is never
 *     constructed, so no Anthropic call and no spend can occur;
 *   - the Notion client is a stub whose fetch never reaches the network, so no
 *     page can be written even if a real token is present in the environment;
 *   - the database is in-process PGlite, discarded when the run ends;
 *     `DATABASE_URL` is never read.
 * P1.10c adds `--live` and swaps the two stubs for real clients.
 *
 * Run from the repo root:
 *   npx tsx scripts/eval-run.ts --agent fos.enrollment_brief --dry-run
 *   npx tsx scripts/eval-run.ts --agent fos.enrollment_brief --dry-run -n 5 --out ./transcripts
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { evalFixtureV2Schema, runTranscriptSchema, type RunTranscript } from "@fos/contracts";
import type { EventActor } from "@fos/contracts";
import {
  runAgent,
  fosEnrollmentBriefAgentDefinition,
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
  setEvalFeatureFlag,
  createStubNotionClient,
  stubComplianceReviewer,
} from "../packages/agents/src/testing/eval-harness.js";
import { artifactVersion } from "@fos/db/schema";
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
class StubModelClient implements ModelClient {
  async generateStructured(): Promise<GenerateStructuredResult> {
    return {
      output: {
        candidateSummary: "Applicant is a working data analyst targeting a senior analytics role.",
        observedFacts: [
          {
            statement: "Currently working as a Data Analyst at Acme Corp.",
            sourceRef: "person.current_role",
          },
        ],
        inferences: [
          { statement: "Likely ready for an accelerated pathway.", confidence: "medium" },
        ],
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
      },
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}

export interface RunEvalSuiteOptions {
  agentKey: string;
  repetitions: number;
  /** When set, transcripts are also written to `<outDir>/<agentKey>.jsonl`. */
  outDir?: string;
}

/** Maps an agent key to its fixture directory name. */
const FIXTURE_DIR_BY_AGENT: Record<string, string> = {
  "fos.enrollment_brief": "enrollment_brief",
};

function loadFixtures(agentKey: string) {
  const dirName = FIXTURE_DIR_BY_AGENT[agentKey];
  if (!dirName) throw new Error(`runEvalSuite: no fixture directory registered for "${agentKey}"`);
  const dir = join(FIXTURE_ROOT, dirName);
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => evalFixtureV2Schema.parse(JSON.parse(readFileSync(join(dir, file), "utf8"))));
}

/**
 * Rebinds a fixture's PLACEHOLDER entity IDs to the freshly-seeded canonical
 * rows (plan §A1). The fixture's own UUIDs exist nowhere in the database, and
 * `persistDomain` loads the opportunity to assert workspace ownership — so
 * without this every run would fail with `status: "error"` for reasons that
 * have nothing to do with model behavior.
 */
function bindFixtureInput(
  input: Record<string, unknown>,
  seeded: Awaited<ReturnType<typeof seedEnrollmentBriefFixture>>,
): Record<string, unknown> {
  const opportunity = { ...(input.opportunity as Record<string, unknown>) };
  const person = { ...(input.person as Record<string, unknown>) };
  const application = { ...(input.application as Record<string, unknown>) };
  opportunity.id = seeded.opportunity.id;
  opportunity.stage = seeded.opportunity.stage;
  person.id = seeded.person.id;
  application.id = seeded.application.id;
  return { ...input, opportunity, person, application };
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
  if (options.agentKey !== "fos.enrollment_brief") {
    throw new Error(
      `runEvalSuite: only fos.enrollment_brief is wired in P1.10a (got "${options.agentKey}")`,
    );
  }
  const definition = fosEnrollmentBriefAgentDefinition;
  const declaredGateKeys = definition.deterministicGates.map((gate) => gate.key);
  const fixtures = loadFixtures(options.agentKey);
  const controlIndex = buildControlIndex(fixtures);
  const transcripts: RunTranscript[] = [];

  for (let repetition = 0; repetition < options.repetitions; repetition += 1) {
    for (const fixture of fixtures) {
      // A FRESH database per run: no run may observe another run's rows.
      const ctx = await createEvalDb();
      try {
        const seeded = await seedEnrollmentBriefFixture(ctx.db);
        await setEvalFeatureFlag(ctx.db, {
          workspaceId: seeded.workspace.id,
          key: FOS_ENROLLMENT_BRIEF_FEATURE_FLAG_KEY,
          enabled: true,
          mode: "review",
        });
        process.env.FOS_NOTION_ENROLLMENT_DATA_SOURCE_ID = "stub-enrollment-data-source";
        const { client: notionClient } = createStubNotionClient();

        const runContext: RunAgentContext = {
          workspaceId: seeded.workspace.id,
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
              modelClient: new StubModelClient(),
              notionClient,
              complianceReviewer: stubComplianceReviewer,
            },
            definition,
            bindFixtureInput(fixture.input, seeded),
            runContext,
          );
        } catch (caught) {
          errorMessage = caught instanceof Error ? caught.message : String(caught);
        }
        const latencyMs = Date.now() - startedAt;

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

        transcripts.push(
          runTranscriptSchema.parse({
            fixture_id: fixture.fixture_id,
            agent_key: definition.key,
            agent_version: definition.version,
            repetition,
            control_for: controlIndex.get(fixture.fixture_id) ?? null,
            run_id: result?.runId ?? "00000000-0000-4000-8000-000000000000",
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
            projection_deferred: result?.projectionDeferred ?? false,
            model: "stub",
            usage: { input_tokens: 0, output_tokens: 0 },
            latency_ms: latencyMs,
            error: errorMessage ?? (result?.status === "error" ? (result.reason ?? "error") : null),
          }),
        );
      } finally {
        delete process.env.FOS_NOTION_ENROLLMENT_DATA_SOURCE_ID;
        await ctx.close();
      }
    }
  }

  if (options.outDir) {
    mkdirSync(options.outDir, { recursive: true });
    writeFileSync(
      join(options.outDir, `${options.agentKey}.jsonl`),
      transcripts.map((t) => JSON.stringify(t)).join("\n") + "\n",
      "utf8",
    );
  }

  return transcripts;
}

function parseArgs(argv: string[]) {
  const get = (flag: string) => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  return {
    agentKey: get("--agent") ?? "fos.enrollment_brief",
    repetitions: Number(get("-n") ?? get("--repetitions") ?? "1"),
    outDir: get("--out"),
    dryRun: argv.includes("--dry-run"),
  };
}

const isEntrypoint = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1]);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dryRun) {
    console.error(
      "eval-run: --dry-run is required. P1.10a is dry-run only; --live lands in P1.10c.",
    );
    process.exit(2);
  }
  const transcripts = await runEvalSuite({
    agentKey: args.agentKey,
    repetitions: args.repetitions,
    outDir: args.outDir,
  });
  const byStatus = transcripts.reduce<Record<string, number>>((acc, t) => {
    acc[t.status] = (acc[t.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`eval-run: ${transcripts.length} transcript(s) for ${args.agentKey}`);
  console.log(`eval-run: status counts ${JSON.stringify(byStatus)}`);
  if (args.outDir)
    console.log(`eval-run: written to ${join(args.outDir, `${args.agentKey}.jsonl`)}`);
}

if (isEntrypoint) {
  main().catch((err: unknown) => {
    console.error("eval-run: FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
