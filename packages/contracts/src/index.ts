import { z } from "zod";

/**
 * @fos/contracts — the single source of truth for cross-boundary schemas
 * (events, entity DTOs, API payloads). Domain entity schemas land with their
 * owning slice; this scaffold establishes the shared OperationalEvent envelope
 * from PATCH-SET-01 §S1.
 */

export const CONTRACTS_VERSION = "0.0.0";

/**
 * Common event envelope carried by every OperationalEvent (PATCH-SET-01 §S1).
 * The envelope is a subset of the persisted row; per-`type` payload schemas are
 * registered alongside their owning slice and validate the `payload` field.
 */
export const eventActorSchema = z.object({
  type: z.enum(["founder", "agent", "provider", "system"]),
  id: z.string().min(1),
});

export const eventEnvelopeSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  product_id: z.string().uuid().nullable().optional(),
  entity_type: z.string().min(1),
  entity_id: z.string().min(1),
  source: z.string().min(1),
  correlation_id: z.string().uuid(),
  causation_id: z.string().uuid().nullable(),
  occurred_at: z.string().datetime(),
  actor: eventActorSchema,
  type: z.string().min(1),
  payload: z.unknown(),
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
export type EventActor = z.infer<typeof eventActorSchema>;

/**
 * S1 payload registry for artifact events (PATCH-SET-02 §C, fulfilling §S1).
 *
 * Maps an artifact event `type` to the Zod schema its `payload` must satisfy.
 * The write path (event writer) validates each event's payload against its
 * registered schema before insert; an unregistered `artifact.*` type is
 * rejected. Only the artifact domain is registered here — event types outside
 * `artifact.*` are governed by their own slices and pass through unchecked.
 */

// The full §12.2 lifecycle state set (PATCH-SET-01 §E2), used to validate the
// from/to fields carried by lifecycle-transition event payloads.
export const artifactLifecycleStatusValues = [
  "draft",
  "in_review",
  "approved",
  "approved_with_edits",
  "rejected",
  "deferred",
  "ready_for_action",
  "executed",
  "failed",
  "superseded",
] as const;

const artifactStatusSchema = z.enum(artifactLifecycleStatusValues);

// All lifecycle-transition events share one payload shape (§C).
const artifactLifecyclePayloadSchema = z
  .object({
    artifactId: z.string().uuid(),
    versionId: z.string().uuid(),
    fromStatus: artifactStatusSchema,
    toStatus: artifactStatusSchema,
  })
  .strict();

const artifactCreatedPayloadSchema = z
  .object({
    artifactId: z.string().uuid(),
    versionId: z.string().uuid(),
    artifactType: z.string().min(1),
  })
  .strict();

const artifactVersionCreatedPayloadSchema = z
  .object({
    artifactId: z.string().uuid(),
    versionId: z.string().uuid(),
    versionNumber: z.number().int().positive(),
  })
  .strict();

const artifactDraftEditedPayloadSchema = z
  .object({
    artifactId: z.string().uuid(),
    versionId: z.string().uuid(),
    previousContentHash: z.string().min(1),
    contentHash: z.string().min(1),
  })
  .strict();

/** Registry: artifact event `type` → payload schema (PATCH-SET-02 §A/§C). */
export const ARTIFACT_EVENT_PAYLOAD_SCHEMAS = {
  "artifact.created": artifactCreatedPayloadSchema,
  "artifact.version_created": artifactVersionCreatedPayloadSchema,
  "artifact.draft_edited": artifactDraftEditedPayloadSchema,
  "artifact.approval_requested": artifactLifecyclePayloadSchema,
  "artifact.approved": artifactLifecyclePayloadSchema,
  "artifact.approved_with_edits": artifactLifecyclePayloadSchema,
  "artifact.rejected": artifactLifecyclePayloadSchema,
  "artifact.deferred": artifactLifecyclePayloadSchema,
  "artifact.revision_requested": artifactLifecyclePayloadSchema,
  "artifact.marked_ready": artifactLifecyclePayloadSchema,
  "artifact.executed": artifactLifecyclePayloadSchema,
  "artifact.failed": artifactLifecyclePayloadSchema,
  "artifact.superseded": artifactLifecyclePayloadSchema,
} as const satisfies Record<string, z.ZodTypeAny>;

export type ArtifactEventType = keyof typeof ARTIFACT_EVENT_PAYLOAD_SCHEMAS;

/**
 * Validates an event `payload` against its registered schema on the write
 * path. Scope (PATCH-SET-02 §C): only `artifact.*` types are registered here.
 * - non-`artifact.*` type → pass (governed by another slice)
 * - `artifact.*` with no registered schema → throw (unregistered type)
 * - `artifact.*` with a malformed payload → throw (ZodError)
 */
export function validateEventPayload(type: string, payload: unknown): void {
  if (!type.startsWith("artifact.")) return;
  const schema = (ARTIFACT_EVENT_PAYLOAD_SCHEMAS as Record<string, z.ZodTypeAny>)[type];
  if (!schema) {
    throw new Error(`Unregistered artifact event type: ${type}`);
  }
  schema.parse(payload);
}
