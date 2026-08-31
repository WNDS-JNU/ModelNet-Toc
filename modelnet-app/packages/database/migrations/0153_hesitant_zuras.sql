CREATE TABLE "agent_group_run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" text NOT NULL,
	"run_node_id" uuid,
	"attempt_id" uuid,
	"operation_id" text,
	"type" text NOT NULL,
	"status" text,
	"data" jsonb,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_group_run_events" ADD CONSTRAINT "agent_group_run_events_run_id_agent_group_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_group_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_group_run_events" ADD CONSTRAINT "agent_group_run_events_run_node_id_agent_group_run_nodes_id_fk" FOREIGN KEY ("run_node_id") REFERENCES "public"."agent_group_run_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_group_run_events" ADD CONSTRAINT "agent_group_run_events_attempt_id_agent_group_run_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."agent_group_run_attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_group_run_events_run_idempotency_unique" ON "agent_group_run_events" USING btree ("run_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "agent_group_run_events_run_created_idx" ON "agent_group_run_events" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_group_run_events_operation_idx" ON "agent_group_run_events" USING btree ("operation_id");