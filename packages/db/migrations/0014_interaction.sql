CREATE TABLE "interaction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"interaction_type" text NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"occurred_at" timestamp with time zone,
	"notes" text,
	"transcript_ref" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "interaction" ADD CONSTRAINT "interaction_workspace_id_fos_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fos_workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction" ADD CONSTRAINT "interaction_opportunity_id_enrollment_opportunity_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."enrollment_opportunity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "interaction_workspace_id_idx" ON "interaction" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "interaction_opportunity_id_idx" ON "interaction" USING btree ("opportunity_id");