-- Append-only guard for campaign_touch (spec §6.3 "Append-only touchpoint
-- record"; issue #91 P1.6). A campaign touch is an immutable historical
-- attribution fact: direct UPDATE or DELETE on this table raises at the DB
-- layer, independent of any application-layer discipline. Mirrors the
-- operational_event append-only guard (migration 0001).

CREATE OR REPLACE FUNCTION campaign_touch_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'campaign_touch is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER campaign_touch_no_update
  BEFORE UPDATE ON "campaign_touch"
  FOR EACH ROW EXECUTE FUNCTION campaign_touch_append_only();
--> statement-breakpoint
CREATE TRIGGER campaign_touch_no_delete
  BEFORE DELETE ON "campaign_touch"
  FOR EACH ROW EXECUTE FUNCTION campaign_touch_append_only();
