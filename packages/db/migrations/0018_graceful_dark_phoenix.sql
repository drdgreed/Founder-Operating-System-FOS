CREATE TABLE "campaign" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"campaign_key" text NOT NULL,
	"name" text NOT NULL,
	"objective" text,
	"offer_id" uuid,
	"audience_segment_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"narrative_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"content_pillar_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"channel_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"secondary_cta_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"primary_cta_id" uuid,
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"status" text DEFAULT 'draft' NOT NULL,
	"success_metrics_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"budget_amount" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_status_valid" CHECK ("campaign"."status" IN ('draft', 'active', 'paused', 'complete'))
);
--> statement-breakpoint
CREATE TABLE "campaign_touch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"person_id" uuid,
	"opportunity_id" uuid,
	"artifact_record_id" uuid,
	"publication_reference" text,
	"channel" text,
	"cta_id" uuid,
	"touch_type" text,
	"occurred_at" timestamp with time zone,
	"utm_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"referrer" text,
	"confidence" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaign" ADD CONSTRAINT "campaign_workspace_id_fos_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fos_workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign" ADD CONSTRAINT "campaign_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_touch" ADD CONSTRAINT "campaign_touch_campaign_id_campaign_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaign"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_touch" ADD CONSTRAINT "campaign_touch_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_touch" ADD CONSTRAINT "campaign_touch_opportunity_id_enrollment_opportunity_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."enrollment_opportunity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_touch" ADD CONSTRAINT "campaign_touch_artifact_record_id_artifact_record_id_fk" FOREIGN KEY ("artifact_record_id") REFERENCES "public"."artifact_record"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaign_workspace_id_idx" ON "campaign" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "campaign_product_id_idx" ON "campaign" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "campaign_touch_campaign_id_idx" ON "campaign_touch" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "campaign_touch_person_id_idx" ON "campaign_touch" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "campaign_touch_opportunity_id_idx" ON "campaign_touch" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "campaign_touch_artifact_record_id_idx" ON "campaign_touch" USING btree ("artifact_record_id");--> statement-breakpoint
ALTER TABLE "enrollment_opportunity" ADD CONSTRAINT "enrollment_opportunity_campaign_id_campaign_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaign"("id") ON DELETE no action ON UPDATE no action;