CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"topic_id" text,
	"actor_id" text,
	"actor_mode" text NOT NULL,
	"type" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"payload_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"topic_id" text NOT NULL,
	"version_number" integer NOT NULL,
	"base_version_id" text,
	"text" text NOT NULL,
	"conditions_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"contributor_display_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reviewer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"status" text NOT NULL,
	CONSTRAINT "version_number_positive" CHECK ("claim_versions"."version_number">0)
);
--> statement-breakpoint
CREATE TABLE "conditions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"topic_id" text NOT NULL,
	"label" text NOT NULL,
	"description" text NOT NULL,
	"kind" text NOT NULL,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	CONSTRAINT "condition_kind" CHECK ("conditions"."kind" in ('support','conflict','unknown','context'))
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"purpose" text NOT NULL,
	"display_mode" text NOT NULL,
	"payload_hash" text NOT NULL,
	"preview" text,
	"expires_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"topic_id" text NOT NULL,
	"source_type" text NOT NULL,
	"provider" text NOT NULL,
	"source_id" text NOT NULL,
	"url" text,
	"title" text,
	"summary" text NOT NULL,
	"display_author" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"content_hash" text NOT NULL,
	"visibility" text DEFAULT 'public' NOT NULL,
	"provenance" jsonb NOT NULL,
	"experience_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experiences" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"topic_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"raw_text" text,
	"public_text" text NOT NULL,
	"display_mode" text NOT NULL,
	"display_name" text NOT NULL,
	"consent_id" text NOT NULL,
	"analysis_status" text DEFAULT 'pending' NOT NULL,
	"analysis_error" text,
	"extracted_conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"caveats" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "experience_display_mode" CHECK ("experiences"."display_mode" in ('nickname','anonymous','pseudonym'))
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"route" text NOT NULL,
	"key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"experience_id" text NOT NULL,
	"condition_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"relation" text NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" double precision NOT NULL,
	"model_run" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "match_two_reasons" CHECK (jsonb_array_length("matches"."reasons")>=2),
	CONSTRAINT "match_confidence" CHECK ("matches"."confidence">=0 and "matches"."confidence"<=1)
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"id_hash" text PRIMARY KEY NOT NULL,
	"browser_binding_hash" text NOT NULL,
	"return_to" text NOT NULL,
	"code_verifier_encrypted" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "probes" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"topic_id" text NOT NULL,
	"question" text NOT NULL,
	"target_unknown_id" text NOT NULL,
	"rationale" text NOT NULL,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"information_gain_explanation" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"base_version_id" text NOT NULL,
	"model_run" jsonb NOT NULL,
	"reviewer_id" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decision_reason" text
);
--> statement-breakpoint
CREATE TABLE "publications" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"topic_id" text NOT NULL,
	"probe_id" text NOT NULL,
	"approval_id" text NOT NULL,
	"approved_by_id" text NOT NULL,
	"provider_mode" text NOT NULL,
	"target_circle_id" text,
	"immutable_payload" jsonb NOT NULL,
	"preview_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"remote_id" text,
	"remote_url" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"topic_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"reporter_id" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewer_id" text,
	"resolved_at" timestamp with time zone,
	"decision_reason" text
);
--> statement-breakpoint
CREATE TABLE "revision_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"topic_id" text NOT NULL,
	"base_version_id" text NOT NULL,
	"proposed_text" text NOT NULL,
	"proposed_conditions" jsonb NOT NULL,
	"diff" jsonb NOT NULL,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"contributor_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"explanation" text NOT NULL,
	"confidence" double precision NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"model_run" jsonb NOT NULL,
	"reviewer_id" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decision_reason" text,
	"accepted_version_id" text,
	CONSTRAINT "revision_confidence" CHECK ("revision_proposals"."confidence">=0 and "revision_proposals"."confidence"<=1)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "source_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"topic_id" text NOT NULL,
	"provider" text NOT NULL,
	"mode" text NOT NULL,
	"payload" jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"template" text NOT NULL,
	"summary" text NOT NULL,
	"current_version_id" text,
	"creator_id" text,
	"circle_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topic_template" CHECK ("topics"."template" in ('learning','social'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider_mode" text NOT NULL,
	"provider_subject" text,
	"display_name" text NOT NULL,
	"avatar_url" text,
	"role" text DEFAULT 'contributor' NOT NULL,
	"encrypted_access_token" text,
	"encrypted_refresh_token" text,
	"token_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_role" CHECK ("users"."role" in ('contributor','maintainer')),
	CONSTRAINT "user_mode" CHECK ("users"."provider_mode" in ('live','replay'))
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_kind" CHECK ("workspaces"."kind" in ('preview','live','demo'))
);
--> statement-breakpoint
CREATE INDEX "audit_workspace_topic_time" ON "audit_events" USING btree ("workspace_id","topic_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "versions_workspace_id" ON "claim_versions" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "versions_topic_id" ON "claim_versions" USING btree ("workspace_id","topic_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "versions_topic_number" ON "claim_versions" USING btree ("workspace_id","topic_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "versions_one_published" ON "claim_versions" USING btree ("workspace_id","topic_id") WHERE "claim_versions"."status" = 'published';--> statement-breakpoint
CREATE UNIQUE INDEX "conditions_workspace_id" ON "conditions" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "conditions_topic_id" ON "conditions" USING btree ("workspace_id","topic_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "consents_workspace_id" ON "consents" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_workspace_id" ON "evidence" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_source_content" ON "evidence" USING btree ("workspace_id","topic_id","provider","source_id","content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "experiences_workspace_id" ON "experiences" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_actor_route_key" ON "idempotency_records" USING btree ("workspace_id","actor_id","route","key");--> statement-breakpoint
CREATE UNIQUE INDEX "probes_workspace_id" ON "probes" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "publication_approval" ON "publications" USING btree ("workspace_id","approval_id");--> statement-breakpoint
CREATE UNIQUE INDEX "publication_idempotency" ON "publications" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "publication_worker_queue" ON "publications" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "revisions_workspace_id" ON "revision_proposals" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "sessions_expiry" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "source_snapshots_latest" ON "source_snapshots" USING btree ("workspace_id","topic_id","provider","fetched_at");--> statement-breakpoint
CREATE UNIQUE INDEX "topics_workspace_id" ON "topics" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "topics_workspace_slug" ON "topics" USING btree ("workspace_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "users_workspace_id" ON "users" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_provider_subject" ON "users" USING btree ("workspace_id","provider_mode","provider_subject");--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_workspace_id_topic_id_topics_workspace_id_id_fk" FOREIGN KEY ("workspace_id","topic_id") REFERENCES "public"."topics"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_versions" ADD CONSTRAINT "claim_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_versions" ADD CONSTRAINT "claim_versions_base_version_id_claim_versions_id_fk" FOREIGN KEY ("base_version_id") REFERENCES "public"."claim_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_versions" ADD CONSTRAINT "claim_versions_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_versions" ADD CONSTRAINT "claim_versions_workspace_id_topic_id_topics_workspace_id_id_fk" FOREIGN KEY ("workspace_id","topic_id") REFERENCES "public"."topics"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conditions" ADD CONSTRAINT "conditions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conditions" ADD CONSTRAINT "conditions_workspace_id_topic_id_topics_workspace_id_id_fk" FOREIGN KEY ("workspace_id","topic_id") REFERENCES "public"."topics"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_workspace_id_user_id_users_workspace_id_id_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "public"."users"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_workspace_id_topic_id_topics_workspace_id_id_fk" FOREIGN KEY ("workspace_id","topic_id") REFERENCES "public"."topics"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_workspace_id_experience_id_experiences_workspace_id_id_fk" FOREIGN KEY ("workspace_id","experience_id") REFERENCES "public"."experiences"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiences" ADD CONSTRAINT "experiences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiences" ADD CONSTRAINT "experiences_workspace_id_topic_id_topics_workspace_id_id_fk" FOREIGN KEY ("workspace_id","topic_id") REFERENCES "public"."topics"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiences" ADD CONSTRAINT "experiences_workspace_id_owner_id_users_workspace_id_id_fk" FOREIGN KEY ("workspace_id","owner_id") REFERENCES "public"."users"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiences" ADD CONSTRAINT "experiences_workspace_id_consent_id_consents_workspace_id_id_fk" FOREIGN KEY ("workspace_id","consent_id") REFERENCES "public"."consents"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_workspace_id_actor_id_users_workspace_id_id_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "public"."users"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_workspace_id_experience_id_experiences_workspace_id_id_fk" FOREIGN KEY ("workspace_id","experience_id") REFERENCES "public"."experiences"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probes" ADD CONSTRAINT "probes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probes" ADD CONSTRAINT "probes_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probes" ADD CONSTRAINT "probes_workspace_id_topic_id_topics_workspace_id_id_fk" FOREIGN KEY ("workspace_id","topic_id") REFERENCES "public"."topics"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probes" ADD CONSTRAINT "probes_workspace_id_topic_id_target_unknown_id_conditions_workspace_id_topic_id_id_fk" FOREIGN KEY ("workspace_id","topic_id","target_unknown_id") REFERENCES "public"."conditions"("workspace_id","topic_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probes" ADD CONSTRAINT "probes_workspace_id_topic_id_base_version_id_claim_versions_workspace_id_topic_id_id_fk" FOREIGN KEY ("workspace_id","topic_id","base_version_id") REFERENCES "public"."claim_versions"("workspace_id","topic_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_workspace_id_topic_id_topics_workspace_id_id_fk" FOREIGN KEY ("workspace_id","topic_id") REFERENCES "public"."topics"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_workspace_id_probe_id_probes_workspace_id_id_fk" FOREIGN KEY ("workspace_id","probe_id") REFERENCES "public"."probes"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_workspace_id_topic_id_topics_workspace_id_id_fk" FOREIGN KEY ("workspace_id","topic_id") REFERENCES "public"."topics"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_proposals" ADD CONSTRAINT "revision_proposals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_proposals" ADD CONSTRAINT "revision_proposals_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_proposals" ADD CONSTRAINT "revision_proposals_accepted_version_id_claim_versions_id_fk" FOREIGN KEY ("accepted_version_id") REFERENCES "public"."claim_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_proposals" ADD CONSTRAINT "revision_proposals_workspace_id_topic_id_topics_workspace_id_id_fk" FOREIGN KEY ("workspace_id","topic_id") REFERENCES "public"."topics"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_proposals" ADD CONSTRAINT "revision_proposals_workspace_id_topic_id_base_version_id_claim_versions_workspace_id_topic_id_id_fk" FOREIGN KEY ("workspace_id","topic_id","base_version_id") REFERENCES "public"."claim_versions"("workspace_id","topic_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_workspace_id_user_id_users_workspace_id_id_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "public"."users"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_snapshots" ADD CONSTRAINT "source_snapshots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_snapshots" ADD CONSTRAINT "source_snapshots_workspace_id_topic_id_topics_workspace_id_id_fk" FOREIGN KEY ("workspace_id","topic_id") REFERENCES "public"."topics"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_current_version_id_claim_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."claim_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_workspace_id_id_current_version_id_claim_versions_workspace_id_topic_id_id_fk" FOREIGN KEY ("workspace_id","id","current_version_id") REFERENCES "public"."claim_versions"("workspace_id","topic_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;