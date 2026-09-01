CREATE TABLE IF NOT EXISTS "external_agent_bindings" (
"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
"agent_id" text NOT NULL,
"user_id" text NOT NULL,
"workspace_id" text,
"endpoint_url" text NOT NULL,
"protocol_version" text DEFAULT '1.0' NOT NULL,
"transport_profile" text DEFAULT 'http-json' NOT NULL,
"interaction_mode" text DEFAULT 'stream' NOT NULL,
"auth_scheme" text DEFAULT 'none' NOT NULL,
"credential_ref" text,
"trust_policy" jsonb NOT NULL,
"enabled" boolean DEFAULT true NOT NULL,
"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
CONSTRAINT "external_agent_bindings_protocol_v1" CHECK ("external_agent_bindings"."protocol_version" = '1.0'),
CONSTRAINT "external_agent_bindings_transport_http_json" CHECK ("external_agent_bindings"."transport_profile" = 'http-json'),
CONSTRAINT "external_agent_bindings_interaction_mode" CHECK ("external_agent_bindings"."interaction_mode" IN ('stream', 'poll')),
CONSTRAINT "external_agent_bindings_auth_scheme" CHECK ("external_agent_bindings"."auth_scheme" IN ('none', 'bearer')),
CONSTRAINT "external_agent_bindings_credential_pair" CHECK (("external_agent_bindings"."auth_scheme" = 'none' AND "external_agent_bindings"."credential_ref" IS NULL) OR ("external_agent_bindings"."auth_scheme" = 'bearer' AND "external_agent_bindings"."credential_ref" IS NOT NULL))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "external_agent_bindings" ADD CONSTRAINT "external_agent_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "external_agent_bindings" ADD CONSTRAINT "external_agent_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "external_agent_bindings" ADD CONSTRAINT "external_agent_bindings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "external_agent_bindings_agent_unique" ON "external_agent_bindings" USING btree ("agent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_agent_bindings_owner_idx" ON "external_agent_bindings" USING btree ("user_id","workspace_id");
