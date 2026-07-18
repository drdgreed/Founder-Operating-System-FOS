-- Same-record guard for artifact_record.current_version_id (issue #8,
-- 0.1b follow-up). `current_version_id` is nullable and deliberately WITHOUT
-- an FK (see artifact_record.ts comment: an FK there would create a circular
-- artifact_record <-> artifact_version constraint). Service code always sets
-- it to a version it just inserted/selected for the SAME record, but nothing
-- at the DB layer stopped it pointing at a version of a *different* record.
--
-- This trigger closes that gap: whenever current_version_id is set (INSERT or
-- UPDATE), it must reference an artifact_version row whose artifact_id equals
-- this record's id. A NULL current_version_id is always allowed.

CREATE OR REPLACE FUNCTION artifact_record_current_version_same_record()
RETURNS trigger AS $$
BEGIN
  IF NEW.current_version_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM artifact_version
      WHERE id = NEW.current_version_id
        AND artifact_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'artifact_record.current_version_id (%) must reference an artifact_version belonging to this record (%)', NEW.current_version_id, NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER artifact_record_current_version_same_record
  BEFORE INSERT OR UPDATE ON "artifact_record"
  FOR EACH ROW EXECUTE FUNCTION artifact_record_current_version_same_record();
