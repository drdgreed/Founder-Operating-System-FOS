import { and, asc, eq } from "drizzle-orm";
import { enrollmentOpportunity, workspaceCommand } from "@fos/db/schema";
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
}

function emptyResult(): ExecuteStageCommandsResult {
  return {
    commandsLoaded: 0,
    succeeded: 0,
    conflicts: 0,
    rejectedIllegal: 0,
    supersededStale: 0,
  };
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
    id: process.env.FOS_SERVICE_ACTOR_ID ?? "notion-command-executor",
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
 */
export async function executeStageCommands(
  db: Db,
  client: NotionClient,
  input: ExecuteStageCommandsInput,
): Promise<ExecuteStageCommandsResult> {
  const { workspaceId, dataSourceId } = input;
  const result = emptyResult();

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
    .orderBy(asc(workspaceCommand.createdAt));
  result.commandsLoaded = received.length;

  const byEntity = new Map<string, WorkspaceCommandRow[]>();
  for (const command of received) {
    const group = byEntity.get(command.targetEntityId);
    if (group) group.push(command);
    else byEntity.set(command.targetEntityId, [command]);
  }

  for (const group of byEntity.values()) {
    // #35: the newest `created_at` in the group is the founder's current
    // intent. Ties (identical timestamps) resolve to the last one seen in
    // the oldest-first load order — deterministic, though not spec-defined.
    let candidate = group[0]!;
    for (const command of group) {
      if (command.createdAt.getTime() >= candidate.createdAt.getTime()) {
        candidate = command;
      }
    }

    for (const stale of group) {
      if (stale.id === candidate.id) continue;
      await supersedeStaleCommand(db, stale, candidate);
      result.supersededStale += 1;
    }

    await executeCandidate(db, client, dataSourceId, candidate, result);
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
    // §8.3 conflict.
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
