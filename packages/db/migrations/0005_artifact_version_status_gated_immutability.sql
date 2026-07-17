-- Status-gated content immutability for artifact_version
-- (PATCH-SET-02 §B; supersedes the always-immutable trigger from migration
-- 0003). Content is MUTABLE while the version is a `draft` and LOCKS the
-- moment it leaves draft.
--
-- The guard RAISES on a change to body_markdown/content_hash ONLY when the
-- row's EXISTING (pre-update) approval_status is not 'draft'. approval_status,
-- updated_at and immutable_at remain mutable so lifecycle transitions and the
-- draft-lock stamp work. Post-approval content changes go through
-- revision -> new version (§12.2), never mutation.
--
-- CREATE OR REPLACE updates the function body in place; the existing
-- BEFORE UPDATE trigger (artifact_version_no_content_update, migration 0003)
-- continues to call it.

CREATE OR REPLACE FUNCTION artifact_version_content_immutable()
RETURNS trigger AS $$
BEGIN
  IF OLD.approval_status <> 'draft'
     AND (NEW.body_markdown IS DISTINCT FROM OLD.body_markdown
          OR NEW.content_hash IS DISTINCT FROM OLD.content_hash) THEN
    RAISE EXCEPTION 'artifact_version content is immutable once out of draft: body_markdown/content_hash cannot change (create a new version instead)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
