CREATE TYPE "public"."agent_run_feature_mode" AS ENUM('shadow', 'review', 'live');--> statement-breakpoint
CREATE TYPE "public"."agent_run_status" AS ENUM('queued', 'running', 'succeeded', 'evaluation_failed', 'policy_blocked', 'error');--> statement-breakpoint
CREATE TYPE "public"."feature_flag_mode" AS ENUM('shadow', 'review', 'live');--> statement-breakpoint
CREATE TABLE "agent_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_key" text NOT NULL,
	"agent_version" text NOT NULL,
	"prompt_version" text NOT NULL,
	"trigger" text NOT NULL,
	"actor_json" jsonb NOT NULL,
	"feature_mode" "agent_run_feature_mode" NOT NULL,
	"context_manifest_json" jsonb NOT NULL,
	"input_ref" text,
	"status" "agent_run_status" DEFAULT 'queued' NOT NULL,
	"model" text,
	"output_ref" text,
	"deterministic_eval_json" jsonb,
	"secondary_eval_json" jsonb,
	"latency_ms" integer,
	"cost_json" jsonb,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"correlation_id" uuid NOT NULL,
	"causation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_flag" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"mode" "feature_flag_mode" DEFAULT 'shadow' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enrollment_assessment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"agent_run_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"observed_facts_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"inferences_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fit_status" text,
	"fit_confidence" text,
	"fit_rationale" text,
	"recommended_pathway" text,
	"unknowns_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"risk_flags_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "enrollment_opportunity" ADD COLUMN "campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "enrollment_opportunity" ADD COLUMN "first_touch_source" text;--> statement-breakpoint
ALTER TABLE "enrollment_opportunity" ADD COLUMN "last_touch_source" text;--> statement-breakpoint
ALTER TABLE "enrollment_opportunity" ADD COLUMN "attribution_confidence" text;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_workspace_id_fos_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fos_workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flag" ADD CONSTRAINT "feature_flag_workspace_id_fos_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fos_workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_assessment" ADD CONSTRAINT "enrollment_assessment_opportunity_id_enrollment_opportunity_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."enrollment_opportunity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_assessment" ADD CONSTRAINT "enrollment_assessment_agent_run_id_agent_run_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feature_flag_workspace_id_key_unique" ON "feature_flag" USING btree ("workspace_id","key");