# Founder Operating System Phase 0 Replacement

This package replaces `02_FOS_Phases_0-1_Technical_Specification` with a standalone Phase 0 implementation specification.

## Principal change

Notion is the founder-facing working environment. FOS remains the canonical system of record, reasoning and workflow layer, evidence and claims authority, consent authority, approval system, event store, audit system, and analytics system.

## Refactoring required before implementation

If the earlier FOS design has already been coded, complete Work Package 0A first:

- Separate canonical domain services from administrative UI.
- Replace specialized draft records with generic `ArtifactRecord` and `ArtifactVersion` contracts.
- Generalize approvals into interface-independent commands and decisions.
- Separate FOS `workspace_id` from external `provider_workspace_id`.
- Add a provider-neutral workspace integration interface.
- Establish field ownership and projection policies.
- Expand the event taxonomy for projections, webhooks, commands, edits, conflicts, and reconciliation.

If later phases have not yet been implemented, no downstream code must be refactored before Phase 0. Their specifications must be updated before implementation.

## Downstream impact

- Phase 1: high impact; use generic artifacts, Notion projections, and WorkspaceCommands.
- Phase 2: medium impact; reuse Phase 0 consent and project summaries only.
- Phase 3: high impact; specification prose becomes artifact versions while tests and release gates remain canonical.
- Phase 4: high impact; audience, channel, CTA, voice, and campaign foundations move to Phase 0.
- Phase 5: low-medium impact; project research summaries while retaining canonical evidence.
- Phase 6: high impact; Notion becomes the initial Founder Command Center.
