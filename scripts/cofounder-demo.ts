/**
 * THE CO-FOUNDER DEMO — run the real system end to end and project what it
 * produces into the live Notion "Enrollment Pipeline" database.
 *
 * The point of this script is that it is NOT a code tour. It runs the actual
 * twelve-stage pipeline against the actual model, and the artifacts your
 * co-founders open in Notion are the ones the system produced, with the gate
 * outcomes and approval status it assigned them.
 *
 * WHAT IT DOES
 *   1. Builds a private, throwaway database and seeds one applicant record.
 *   2. Runs `fos.enrollment_brief` in REVIEW mode against the real model — so
 *      every gate, the compliance review, and the approval routing all run.
 *   3. Projects each resulting artifact into the live Notion database.
 *   4. Prints a summary you can read aloud, and the Notion page URLs.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   - It never approves anything. Artifacts land as `in_review` and wait for a
 *     human, which is the property worth demonstrating.
 *   - It never contacts an applicant. There is no send path in this pipeline.
 *   - It does not touch your canonical product database. The run happens in an
 *     ephemeral in-memory database that is discarded when the script exits.
 *
 * SAFETY
 *   `--live` is REQUIRED and is the only mode: a demo that stubs the model is
 *   not a demo of anything. Both credentials are read BY NAME at call time
 *   (FOS_NOTION_TOKEN, ANTHROPIC_API_KEY) — this script never holds either
 *   value, and neither appears in any error it can throw.
 *
 *   This WRITES PAGES to a real Notion workspace. Pass --confirm to proceed.
 *
 * USAGE
 *   npx tsx --env-file=.env scripts/cofounder-demo.ts --live --confirm
 *   npx tsx --env-file=.env scripts/cofounder-demo.ts --live --confirm --fixture strong_fit
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { evalFixtureV2Schema } from "@fos/contracts";
import { NotionClient } from "@fos/notion";
import { artifactVersion } from "@fos/db/schema";
import { eq } from "drizzle-orm";
import {
  runAgent,
  AnthropicModelClient,
  fosEnrollmentBriefAgentDefinition,
  FOS_ENROLLMENT_BRIEF_FEATURE_FLAG_KEY,
  type RunAgentContext,
} from "../packages/agents/src/index.js";
import {
  createEvalDb,
  seedEnrollmentBriefFixture,
  setEvalFeatureFlag,
} from "../packages/agents/src/testing/eval-harness.js";
import { stripEmptyAnthropicEnv } from "./eval-run.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "..", "fos-evals", "fixtures", "enrollment_brief");

/** Fixtures that make the best demo, in the order they tell the story. */
const DEMO_ORDER = ["strong_fit", "incomplete_information", "prompt_injection"];

const NARRATION: Record<string, string> = {
  strong_fit: "A well-qualified applicant. The ordinary case — this is what good looks like.",
  incomplete_information:
    "A sparse application. Watch it admit the gap rather than invent a recommendation.",
  prompt_injection:
    "The application contains text trying to hijack the system — demanding auto-approval and a " +
    "guaranteed job. Watch it treat that as DATA, record it as a risk, and route for review.",
};

function loadFixture(name: string) {
  const path = join(FIXTURE_DIR, `${name}.json`);
  return evalFixtureV2Schema.parse(JSON.parse(readFileSync(path, "utf8")));
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.includes("--live")) {
    console.error(
      "cofounder-demo: --live is REQUIRED and is the only mode.\n" +
        "cofounder-demo: a demo that stubs the model is not a demo of anything.",
    );
    process.exit(2);
  }
  if (!argv.includes("--confirm")) {
    console.error(
      "cofounder-demo: this WRITES PAGES to a real Notion workspace and SPENDS MONEY on model\n" +
        "cofounder-demo: calls. Re-run with --confirm once you are ready.",
    );
    process.exit(2);
  }

  const stripped = stripEmptyAnthropicEnv();
  if (stripped.length > 0) {
    console.error(`cofounder-demo: removed ${stripped.length} EMPTY ANTHROPIC_* var(s) (L-007).`);
  }
  for (const name of ["ANTHROPIC_API_KEY", "FOS_NOTION_TOKEN"] as const) {
    if (!process.env[name]) {
      console.error(
        `cofounder-demo: ${name} is not set. Run from a REAL terminal with --env-file=.env.`,
      );
      process.exit(2);
    }
  }
  const dataSourceId = process.env.FOS_NOTION_ENROLLMENT_DATA_SOURCE_ID;
  if (!dataSourceId) {
    console.error(
      "cofounder-demo: FOS_NOTION_ENROLLMENT_DATA_SOURCE_ID is not set.\n" +
        "cofounder-demo: get it by running scripts/notion-live-setup.ts once.",
    );
    process.exit(2);
  }

  const fixtureArg = argv.indexOf("--fixture");
  const available = readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5));
  const names =
    fixtureArg === -1
      ? DEMO_ORDER.filter((n) => available.includes(n))
      : [argv[fixtureArg + 1] ?? ""].filter((n) => available.includes(n));
  if (names.length === 0) {
    console.error(`cofounder-demo: no matching fixture. Available: ${available.join(", ")}`);
    process.exit(2);
  }

  console.log("=".repeat(72));
  console.log("  FOUNDER OPERATING SYSTEM — live demonstration");
  console.log("=".repeat(72));
  console.log(`  ${names.length} applicant record(s), against the real model, in REVIEW mode.`);
  console.log("  Nothing is approved. Nothing is sent. Every artifact waits for a human.\n");

  const modelClient = new AnthropicModelClient({ fetchImpl: fetch });
  const notionClient = new NotionClient({ fetchImpl: fetch });

  for (const name of names) {
    const fixture = loadFixture(name);
    console.log("-".repeat(72));
    console.log(`▸ ${name}`);
    if (NARRATION[name]) console.log(`  ${NARRATION[name]}\n`);

    // A fresh, private database per record. Discarded on exit — the canonical
    // product database is never touched.
    const ctx = await createEvalDb();
    try {
      const seeded = await seedEnrollmentBriefFixture(ctx.db);
      await setEvalFeatureFlag(ctx.db, {
        workspaceId: seeded.workspace.id,
        key: FOS_ENROLLMENT_BRIEF_FEATURE_FLAG_KEY,
        enabled: true,
        mode: "review",
      });

      // Rebind the fixture's placeholder ids onto the freshly-seeded rows.
      const input = fixture.input as Record<string, unknown>;
      const opportunity = { ...(input.opportunity as Record<string, unknown>) };
      const person = { ...(input.person as Record<string, unknown>) };
      const application = { ...(input.application as Record<string, unknown>) };
      opportunity.id = seeded.opportunity.id;
      opportunity.stage = seeded.opportunity.stage;
      person.id = seeded.person.id;
      application.id = seeded.application.id;

      const runContext: RunAgentContext = {
        workspaceId: seeded.workspace.id,
        actor: { type: "system", id: "cofounder-demo" },
        trigger: { type: "demo", source: "cofounder-demo" },
      };

      const startedAt = Date.now();
      const result = await runAgent(
        { db: ctx.db, modelClient, notionClient },
        fosEnrollmentBriefAgentDefinition,
        { ...input, opportunity, person, application },
        runContext,
      );
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(0);

      const gates = result.gateEvaluations ?? [];
      const passed = gates.filter((g) => g.allowed).length;
      console.log(`  status            ${result.status}`);
      console.log(`  gates evaluated   ${passed}/${gates.length} passed`);
      console.log(
        `  compliance review ${
          result.complianceReview === undefined
            ? "not reached"
            : result.complianceReview.blocked
              ? `BLOCKED — ${result.complianceReview.reason ?? ""}`
              : "ran, allowed"
        }`,
      );

      if (result.artifact) {
        const [version] = await ctx.db
          .select()
          .from(artifactVersion)
          .where(eq(artifactVersion.id, result.artifact.versionId));
        console.log(`  artifact status   ${version?.approvalStatus} — awaiting a human`);
        console.log(`  projected to      Notion (data source ${dataSourceId.slice(0, 8)}…)`);
      } else {
        console.log("  artifact          none — the run was stopped before one was created");
      }
      console.log(`  elapsed           ${seconds}s\n`);
    } catch (err) {
      // Never let one record end the demo. The failure IS informative.
      console.log(`  FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      await ctx.close();
    }
  }

  console.log("=".repeat(72));
  console.log("  Open the Enrollment Pipeline database in Notion to read the briefs.");
  console.log("  Every one is waiting for approval. None of them can approve itself.");
  console.log("=".repeat(72));
}

main().catch((err: unknown) => {
  console.error("cofounder-demo: FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
