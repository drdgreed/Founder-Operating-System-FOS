import { and, asc, eq } from "drizzle-orm";
import { enrollmentOpportunity, projection, workspaceCommand } from "@fos/db/schema";
import {
  IllegalTransitionError,
  StaleVersionError,
  transitionOpportunity,
  writeEvent,
  type Db,
  type OpportunityStage,
} from "@fos/db/services";
import type { NotionClient } from "@fos/notion";
import { projectOpportunity } from "./project-opportunity.js";

const COMMAND_TYPE = "propose_opportunity_stage_change";
const TARGET_ENTITY_TYPE = "EnrollmentOpportunity";

type WorkspaceCommandRow = typeof workspaceCommand.$inferSelect;

export interface ExecuteStageCommandsInput {
  workspaceId: string;
  /** Target Notion data source (database) id, forwarded to `projectOpportunity` for the re-projection step. */
  dataSourceId: string;
}

export interface ExecuteStageCommandsResult {
  /** `received` propose_opportunity_stage_change commands loaded this run. */
  commandsLoaded: number;
  /** Applied to canonical (transitionOpportunity succeeded); page re-projected. */
  succeeded: number;
  /** §8.3 version guard tripped (`StaleVersionError`) — canonical UNCHANGED. */
  conflicts: number;
  /** Illegal §12.1 edge (`IllegalTransitionError`) — canonical UNCHANGED. */
  rejectedIllegal: number;
  /**
   * Issue #35 latest-intent resolution: an older `received` command at the
   * same target entity, superseded by a newer one at the same entity — never
   * executed, marked `rejected`.
   */
  supersededStale: number;
  /**
   * Command whose `target_entity_id` names no opportunity in this workspace
   * (a missing/deleted target, or — defense-in-depth vs a tampered command
   * row from untrusted provider input — a cross-workspace target) — marked
   * `rejected`, canonical untouched.
   */
  rejectedInvalid: number;
  /**
   * Transition succeeded (canonical is correct) but the follow-up Notion
   * re-projection threw. The `projection` row is marked `sync_status =
   * 'failed'` (issue #38 item 1) — distinct from a genuine `'conflict'` (a
   * founder edit reconcile detected) — so the NEXT run's `retryFailedReprojections`
   * self-heals it automatically instead of parking the page in a false
   * conflict until manual intervention.
   */
  reprojectionDeferred: number;
  /** A previously-`failed` re-projection (issue #38 item 1) successfully
   * retried and healed at the start of this run. */
  reprojectionRetried: number;
  /** A previously-`failed` re-projection retried this run but still failing
   * (left `sync_status = 'failed'` for the next run). */
  reprojectionStillFailing: number;
  /**
   * An unexpected error on one entity group, isolated so it cannot abort the
   * batch (the command is left `received` for the next run to retry).
   */
  failed: number;
}

function emptyResult(): ExecuteStageCommandsResult {
  return {
    commandsLoaded: 0,
    succeeded: 0,
    conflicts: 0,
    rejectedIllegal: 0,
    supersededStale: 0,
    rejectedInvalid: 0,
    reprojectionDeferred: 0,
    reprojectionRetried: 0,
    reprojectionStillFailing: 0,
    failed: 0,
  };
}

/** Marks the `projection` row `sync_status = 'failed'` (issue #38 item 1 —
 * the enum value issue #29 flagged as never written). A no-op if no row
 * exists for this entity (can't happen for a command's target: 0.2d only
 * ever captures a command for a page that already has a `projection` row). */
async function markProjectionFailed(db: Db, workspaceId: string, entityId: string): Promise<void> {
  await db
    .update(projection)
    .set({ syncStatus: "failed", updatedAt: new Date() })
    .where(
      and(
        eq(projection.workspaceId, workspaceId),
        eq(projection.entityType, TARGET_ENTITY_TYPE),
        eq(projection.entityId, entityId),
        eq(projection.provider, "notion"),
      ),
    );
}

/**
 * Self-healing re-projection outbox (issue #38 item 1). Finds every
 * `projection` row this workspace left `sync_status = 'failed'` (a prior
 * transient Notion write failure — see `markProjectionFailed`) and retries
 * `projectOpportunity` from the entity's CURRENT canonical state. Reuses
 * `projectOpportunity` rather than reimplementing it: it's already
 * idempotent (upserts the SAME page) and always projects whatever canonical
 * says NOW, so a retry naturally catches up even if further transitions
 * happened since the original failure — no separate "what changed" tracking
 * needed. Each row is isolated (one still-broken page can't block healing
 * the rest), mirroring the per-entity-group isolation in the main loop below.
 */
export async function retryFailedReprojections(
  db: Db,
  client: NotionClient,
  input: ExecuteStageCommandsInput,
  result: ExecuteStageCommandsResult = emptyResult(),
): Promise<ExecuteStageCommandsResult> {
  const { workspaceId, dataSourceId } = input;

  const failedRows = await db
    .select()
    .from(projection)
    .where(
      and(
        eq(projection.workspaceId, workspaceId),
        eq(projection.entityType, TARGET_ENTITY_TYPE),
        eq(projection.provider, "notion"),
        eq(projection.syncStatus, "failed"),
      ),
    );

  for (const row of failedRows) {
    try {
      const [opportunity] = await db
        .select()
        .from(enrollmentOpportunity)
        .where(eq(enrollmentOpportunity.id, row.entityId))
        .limit(1);
      // Canonical vanished or moved workspaces — nothing sane to retry
      // against; leave the row for reconcile/orphan handling rather than
      // guessing at what to project.
      if (!opportunity || opportunity.workspaceId !== workspaceId) continue;

      await projectOpportunity(db, client, { opportunity, dataSourceId });
      result.reprojectionRetried += 1;
    } catch {
      // Still failing (e.g. Notion still down) — already `'failed'`, but
      // re-set defensively in case a concurrent process flipped it; isolated
      // so one stuck page can't block healing the rest.
      await markProjectionFailed(db, workspaceId, row.entityId);
      result.reprojectionStillFailing += 1;
    }
  }

  return result;
}

/**
 * ADR-01 service-account actor shim (mirrors `apps/api/lib/auth.ts`'s
 * `requireServiceAuth` principal). `executeStageCommands` runs as a
 * background poller, not behind an authenticated HTTP request, so there is no
 * `Principal` to read — but the executor is still a service principal, never
 * a human founder, so every canonical write and event it causes is
 * attributed to a stable `system` actor. Read at call time (not module load)
 * so tests can vary/omit the env var per case, same rationale as `auth.ts`.
 */
function serviceActor() {
  return {
    type: "system" as const,
    // `||` (not `??`) so a misconfigured empty-string env var also falls back
    // to the stable default rather than writing an empty actor into audit events.
    id: process.env.FOS_SERVICE_ACTOR_ID || "notion-command-executor",
  };
}

/**
 * Applies received `propose_opportunity_stage_change` `WorkspaceCommand`s
 * (captured by 0.2d's `captureStageCommands`) to canonical and re-projects
 * (issue #36, slice 0.2e). This is the EXECUTION half of the inbound loop: a
 * founder's Notion `Stage` edit, once captured, actually changes the
 * canonical `EnrollmentOpportunity`.
 *
 * Mostly ORCHESTRATION — this function does not reimplement the §12.1
 * transition matrix, the §8.3 optimistic-concurrency guard, or projection; it
 * drives `transitionOpportunity` (the executor — its thrown errors ARE this
 * command's conflict/reject outcomes) and `projectOpportunity` (the
 * re-projection step).
 *
 * Per command, per group of commands at one `target_entity_id`:
 * 1. **Issue #35 latest-intent resolution.** Poll-based capture can legally
 *    leave multiple DISTINCT `received` commands pending for one entity (the
 *    founder edited the Stage more than once before this executor ran). The
 *    command with the NEWEST `created_at` in the group is the candidate — it
 *    alone is executed. Every other `received` command in the group is
 *    marked `rejected` with a superseded reason and is NEVER executed.
 * 2. **Execute the candidate** via `transitionOpportunity`, mapping its
 *    outcome to §E1:
 *    - success -> command `status='succeeded'` (+ `execution_status`/
 *      `executed_at`), `workspace_command.executed` emitted, then
 *      RE-PROJECT so the next 0.2c reconcile doesn't see the bumped version
 *      as a false conflict.
 *    - `StaleVersionError` (§8.3 conflict) -> command `status='conflict'`,
 *      canonical UNCHANGED, `workspace_command.failed` emitted.
 *    - `IllegalTransitionError` -> command `status='rejected'` +
 *      `rejection_reason`, canonical UNCHANGED, `workspace_command.rejected`
 *      emitted.
 *
 * Idempotent: only `status='received'` commands are ever loaded, and every
 * status update above is guarded by `WHERE status = 'received'`, so a
 * `succeeded`/`rejected`/`conflict` command is never re-executed — re-running
 * `executeStageCommands` after a prior run is a no-op for every command it
 * already resolved.
 *
 * Robustness: (a) the target opportunity is re-checked to exist AND belong to
 * the command's workspace before any mutation (defense-in-depth vs a tampered/
 * cross-workspace `target_entity_id` from untrusted provider input) — a bad
 * target is `rejected`, never mutated; (b) each entity group is isolated so
 * one unexpected failure cannot abort the batch and starve other commands;
 * (c) a re-projection (Notion) failure leaves the command `succeeded`
 * (canonical is committed and correct) and is counted, not thrown — the page
 * is left for a later reconcile/re-projection rather than losing the batch.
 */
export async function executeStageCommands(
  db: Db,
  client: NotionClient,
  input: ExecuteStageCommandsInput,
): Promise<ExecuteStageCommandsResult> {
  const { workspaceId, dataSourceId } = input;
  const result = emptyResult();

  // Self-heal any re-projections a PRIOR run left `failed` (issue #38 item
  // 1) before touching new commands — cheap, and means a page that was
  // stale purely because of a transient Notion error catches up on the very
  // next poll cycle instead of sitting in a false conflict.
  await retryFailedReprojections(db, client, input, result);

  // Oldest-first per the issue's Build spec; the latest-intent resolution
  // below re-derives "current" per target entity regardless of load order.
  const received = await db
    .select()
    .from(workspaceCommand)
    .where(
      and(
        eq(workspaceCommand.workspaceId, workspaceId),
        eq(workspaceCommand.commandType, COMMAND_TYPE),
        eq(workspaceCommand.targetEntityType, TARGET_ENTITY_TYPE),
        eq(workspaceCommand.status, "received"),
      ),
    )
    // asc(id) is the deterministic tie-break for commands sharing a created_at:
    // the candidate scan below picks the last-seen max, so equal-timestamp rows
    // resolve to the highest id every run (audit-reproducible).
    .orderBy(asc(workspaceCommand.createdAt), asc(workspaceCommand.id));
  result.commandsLoaded = received.length;

  const byEntity = new Map<string, WorkspaceCommandRow[]>();
  for (const command of received) {
    const group = byEntity.get(command.targetEntityId);
    if (group) group.push(command);
    else byEntity.set(command.targetEntityId, [command]);
  }

  for (const group of byEntity.values()) {
    // #35: the newest `created_at` in the group is the founder's current
    // intent. Load order is asc(createdAt, id), so the last-seen max resolves
    // ties deterministically to the highest id.
    let candidate = group[0]!;
    for (const command of group) {
      if (command.createdAt.getTime() >= candidate.createdAt.getTime()) {
        candidate = command;
      }
    }

    // Per-group isolation: one entity's unexpected failure (e.g. a target
    // deleted out from under a transition, a DB fault) must not abort the
    // whole batch and starve every other entity's commands. The command is
    // left in whatever state it reached (a pre-mutation throw leaves it
    // `received` for the next run to retry).
    try {
      for (const stale of group) {
        if (stale.id === candidate.id) continue;
        await supersedeStaleCommand(db, stale, candidate);
        result.supersededStale += 1;
      }

      await executeCandidate(db, client, dataSourceId, candidate, result);
    } catch (err) {
      // Issue #38 item 3: a hard fault here was previously silent — visible
      // only as a `failed` count in the returned result, invisible to any
      // caller that doesn't inspect it. Log the target entity + error
      // message (never the full command payload) so a poison-pill fault is
      // never invisible, even though the batch itself is correctly isolated.
      console.error(
        `[executeStageCommands] group execution failed for target_entity_id=${candidate.targetEntityId}:`,
        err instanceof Error ? err.message : String(err),
      );
      result.failed += 1;
    }
  }

  return result;
}

async function supersedeStaleCommand(
  db: Db,
  stale: WorkspaceCommandRow,
  candidate: WorkspaceCommandRow,
): Promise<void> {
  const now = new Date();
  const rejectionReason =
    "Superseded by a newer propose_opportunity_stage_change command for the same " +
    "entity (issue #35 latest-intent resolution) — a later founder edit replaced this one";

  const updated = await db
    .update(workspaceCommand)
    .set({ status: "rejected", rejectionReason, updatedAt: now })
    .where(and(eq(workspaceCommand.id, stale.id), eq(workspaceCommand.status, "received")))
    .returning({ id: workspaceCommand.id });
  if (updated.length === 0) return; // already resolved by a concurrent/prior run

  await writeEvent(db, {
    workspaceId: stale.workspaceId,
    entityType: "WorkspaceCommand",
    entityId: stale.id,
    source: "notion_command",
    correlationId: stale.correlationId,
    causationId: null,
    actor: serviceActor(),
    type: "workspace_command.rejected",
    payload: {
      commandId: stale.id,
      targetEntityId: stale.targetEntityId,
      reason: "superseded",
      supersededByCommandId: candidate.id,
    },
  });
}

async function executeCandidate(
  db: Db,
  client: NotionClient,
  dataSourceId: string,
  command: WorkspaceCommandRow,
  result: ExecuteStageCommandsResult,
): Promise<void> {
  const payload = command.payloadJson as { from: OpportunityStage; to: OpportunityStage };

  // Defense-in-depth on the mutation path (the command row originates from
  // untrusted Notion input): the target opportunity must exist AND belong to
  // the command's workspace. `transitionOpportunity` loads by id only, so
  // without this a tampered/cross-workspace `target_entity_id` whose version
  // happened to match would be mutated. A missing target (0.2c can leave
  // orphaned commands) is likewise rejected here rather than thrown.
  const [target] = await db
    .select({ workspaceId: enrollmentOpportunity.workspaceId })
    .from(enrollmentOpportunity)
    .where(eq(enrollmentOpportunity.id, command.targetEntityId))
    .limit(1);
  if (!target || target.workspaceId !== command.workspaceId) {
    const updated = await db
      .update(workspaceCommand)
      .set({
        status: "rejected",
        rejectionReason: target
          ? "Target opportunity belongs to a different workspace"
          : "Target opportunity does not exist",
        updatedAt: new Date(),
      })
      .where(and(eq(workspaceCommand.id, command.id), eq(workspaceCommand.status, "received")))
      .returning({ id: workspaceCommand.id });
    if (updated.length === 0) return;
    await writeEvent(db, {
      workspaceId: command.workspaceId,
      entityType: "WorkspaceCommand",
      entityId: command.id,
      source: "notion_command",
      correlationId: command.correlationId,
      causationId: null,
      actor: serviceActor(),
      type: "workspace_command.rejected",
      payload: {
        commandId: command.id,
        reason: "invalid_target",
        targetEntityId: command.targetEntityId,
      },
    });
    result.rejectedInvalid += 1;
    return;
  }

  try {
    const transition = await transitionOpportunity(db, {
      opportunityId: command.targetEntityId,
      toStage: payload.to,
      expectedVersion: command.targetVersion,
      actor: serviceActor(),
      source: "notion_command",
      causationId: command.id,
    });

    const now = new Date();
    const updated = await db
      .update(workspaceCommand)
      .set({
        status: "succeeded",
        executionStatus: "succeeded",
        executedAt: now,
        updatedAt: now,
      })
      .where(and(eq(workspaceCommand.id, command.id), eq(workspaceCommand.status, "received")))
      .returning({ id: workspaceCommand.id });
    if (updated.length === 0) return; // already resolved by a concurrent/prior run

    await writeEvent(db, {
      workspaceId: command.workspaceId,
      entityType: "WorkspaceCommand",
      entityId: command.id,
      source: "notion_command",
      correlationId: command.correlationId,
      causationId: transition.eventId,
      actor: serviceActor(),
      type: "workspace_command.executed",
      payload: {
        commandId: command.id,
        opportunityId: command.targetEntityId,
        fromStage: transition.fromStage,
        toStage: transition.toStage,
        version: transition.version,
      },
    });
    result.succeeded += 1;

    // RE-PROJECT: reload the updated opportunity and refresh its Notion page
    // so `FOS Version` + `Sync Status` reflect the new canonical version —
    // otherwise the next 0.2c reconcile sees the bumped version as a false
    // §8.3 conflict. This is a SEPARATE two-system write from the (already
    // committed) transition + `succeeded` mark: if it throws, canonical is
    // still correct and durable, so we must NOT undo the command or abort the
    // batch — the page is left stale, but marked `sync_status = 'failed'`
    // (issue #38 item 1) so the NEXT run's `retryFailedReprojections`
    // self-heals it automatically instead of parking it in a false conflict.
    try {
      const [updatedOpportunity] = await db
        .select()
        .from(enrollmentOpportunity)
        .where(eq(enrollmentOpportunity.id, command.targetEntityId))
        .limit(1);
      if (!updatedOpportunity) {
        throw new Error(
          `executeStageCommands: EnrollmentOpportunity ${command.targetEntityId} vanished ` +
            "after a successful transition",
        );
      }
      await projectOpportunity(db, client, { opportunity: updatedOpportunity, dataSourceId });
    } catch {
      await markProjectionFailed(db, command.workspaceId, command.targetEntityId);
      result.reprojectionDeferred += 1;
    }
  } catch (err) {
    if (err instanceof StaleVersionError) {
      const updated = await db
        .update(workspaceCommand)
        .set({ status: "conflict", updatedAt: new Date() })
        .where(and(eq(workspaceCommand.id, command.id), eq(workspaceCommand.status, "received")))
        .returning({ id: workspaceCommand.id });
      if (updated.length === 0) return;

      await writeEvent(db, {
        workspaceId: command.workspaceId,
        entityType: "WorkspaceCommand",
        entityId: command.id,
        source: "notion_command",
        correlationId: command.correlationId,
        causationId: null,
        actor: serviceActor(),
        type: "workspace_command.failed",
        payload: {
          commandId: command.id,
          reason: "stale_version",
          expectedVersion: err.expectedVersion,
          actualVersion: err.actualVersion,
        },
      });
      result.conflicts += 1;
      return;
    }

    if (err instanceof IllegalTransitionError) {
      const updated = await db
        .update(workspaceCommand)
        .set({ status: "rejected", rejectionReason: err.message, updatedAt: new Date() })
        .where(and(eq(workspaceCommand.id, command.id), eq(workspaceCommand.status, "received")))
        .returning({ id: workspaceCommand.id });
      if (updated.length === 0) return;

      await writeEvent(db, {
        workspaceId: command.workspaceId,
        entityType: "WorkspaceCommand",
        entityId: command.id,
        source: "notion_command",
        correlationId: command.correlationId,
        causationId: null,
        actor: serviceActor(),
        type: "workspace_command.rejected",
        payload: {
          commandId: command.id,
          reason: "illegal_transition",
          from: err.from,
          to: err.to,
        },
      });
      result.rejectedIllegal += 1;
      return;
    }

    throw err;
  }
}
