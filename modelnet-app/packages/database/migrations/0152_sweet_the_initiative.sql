CREATE TABLE "agent_group_run_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_node_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"operation_id" text NOT NULL,
	"runtime_kind" text NOT NULL,
	"execution_target_snapshot" jsonb,
	"external_execution_ref" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" jsonb,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_group_run_attempts_attempt_no_positive" CHECK ("agent_group_run_attempts"."attempt_no" > 0)
);
--> statement-breakpoint
CREATE TABLE "agent_group_run_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" text NOT NULL,
	"node_key" text NOT NULL,
	"agent_id" text,
	"role" text,
	"instruction" text NOT NULL,
	"dependencies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"barrier_key" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"execution_policy_snapshot" jsonb,
	"tool_policy_snapshot" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"completion_reason" text,
	"error" jsonb,
	"max_attempts" integer DEFAULT 1 NOT NULL,
	"timeout_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_group_run_nodes_sort_order_nonnegative" CHECK ("agent_group_run_nodes"."sort_order" >= 0),
	CONSTRAINT "agent_group_run_nodes_max_attempts_positive" CHECK ("agent_group_run_nodes"."max_attempts" > 0),
	CONSTRAINT "agent_group_run_nodes_timeout_positive" CHECK ("agent_group_run_nodes"."timeout_ms" IS NULL OR "agent_group_run_nodes"."timeout_ms" > 0)
);
--> statement-breakpoint
CREATE TABLE "agent_group_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"chat_group_id" text NOT NULL,
	"topic_id" text,
	"thread_id" text,
	"supervisor_agent_id" text,
	"supervisor_operation_id" text NOT NULL,
	"protocol" text NOT NULL,
	"plan_version" integer NOT NULL,
	"plan_snapshot" jsonb NOT NULL,
	"plan_hash" varchar(64) NOT NULL,
	"policy_snapshot" jsonb,
	"budget_snapshot" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"completion_reason" text,
	"error" jsonb,
	"idempotency_key" text NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_group_runs_plan_version_positive" CHECK ("agent_group_runs"."plan_version" > 0),
	CONSTRAINT "agent_group_runs_plan_hash_sha256" CHECK ("agent_group_runs"."plan_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "agent_group_run_attempts" ADD CONSTRAINT "agent_group_run_attempts_run_node_id_agent_group_run_nodes_id_fk" FOREIGN KEY ("run_node_id") REFERENCES "public"."agent_group_run_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_group_run_nodes" ADD CONSTRAINT "agent_group_run_nodes_run_id_agent_group_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_group_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_group_run_nodes" ADD CONSTRAINT "agent_group_run_nodes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_group_runs" ADD CONSTRAINT "agent_group_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_group_runs" ADD CONSTRAINT "agent_group_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_group_runs" ADD CONSTRAINT "agent_group_runs_chat_group_id_chat_groups_id_fk" FOREIGN KEY ("chat_group_id") REFERENCES "public"."chat_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_group_runs" ADD CONSTRAINT "agent_group_runs_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_group_runs" ADD CONSTRAINT "agent_group_runs_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_group_runs" ADD CONSTRAINT "agent_group_runs_supervisor_agent_id_agents_id_fk" FOREIGN KEY ("supervisor_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_group_run_attempts_node_attempt_unique" ON "agent_group_run_attempts" USING btree ("run_node_id","attempt_no");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_group_run_attempts_operation_unique" ON "agent_group_run_attempts" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "agent_group_run_attempts_node_status_idx" ON "agent_group_run_attempts" USING btree ("run_node_id","status");--> statement-breakpoint
CREATE INDEX "agent_group_run_attempts_status_updated_idx" ON "agent_group_run_attempts" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_group_run_nodes_run_key_unique" ON "agent_group_run_nodes" USING btree ("run_id","node_key");--> statement-breakpoint
CREATE INDEX "agent_group_run_nodes_run_status_order_idx" ON "agent_group_run_nodes" USING btree ("run_id","status","sort_order");--> statement-breakpoint
CREATE INDEX "agent_group_run_nodes_agent_id_idx" ON "agent_group_run_nodes" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_group_runs_personal_idempotency_unique" ON "agent_group_runs" USING btree ("user_id","idempotency_key") WHERE "agent_group_runs"."workspace_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_group_runs_workspace_idempotency_unique" ON "agent_group_runs" USING btree ("workspace_id","idempotency_key") WHERE "agent_group_runs"."workspace_id" is not null;--> statement-breakpoint
CREATE INDEX "agent_group_runs_chat_group_created_idx" ON "agent_group_runs" USING btree ("chat_group_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_group_runs_topic_created_idx" ON "agent_group_runs" USING btree ("topic_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_group_runs_supervisor_operation_idx" ON "agent_group_runs" USING btree ("supervisor_operation_id");--> statement-breakpoint
CREATE INDEX "agent_group_runs_status_updated_idx" ON "agent_group_runs" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "agent_group_runs_user_id_idx" ON "agent_group_runs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_group_runs_workspace_id_idx" ON "agent_group_runs" USING btree ("workspace_id");