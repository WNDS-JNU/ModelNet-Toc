DROP INDEX "agent_group_run_events_run_created_idx";--> statement-breakpoint
ALTER TABLE "agent_group_run_events" ADD COLUMN "sequence" bigserial NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_group_run_events_run_sequence_idx" ON "agent_group_run_events" USING btree ("run_id","sequence");