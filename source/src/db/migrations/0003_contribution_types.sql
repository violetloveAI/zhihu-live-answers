ALTER TABLE "experiences" ADD COLUMN "contribution_kind" text DEFAULT 'experience' NOT NULL;--> statement-breakpoint
ALTER TABLE "experiences" ADD COLUMN "reply_to_probe_id" text;--> statement-breakpoint
ALTER TABLE "experiences" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "experiences" ADD COLUMN "display_avatar_url" text;--> statement-breakpoint
CREATE UNIQUE INDEX "probes_topic_id" ON "probes" USING btree ("workspace_id","topic_id","id");--> statement-breakpoint
ALTER TABLE "experiences" ADD CONSTRAINT "experiences_workspace_id_topic_id_reply_to_probe_id_probes_workspace_id_topic_id_id_fk" FOREIGN KEY ("workspace_id","topic_id","reply_to_probe_id") REFERENCES "public"."probes"("workspace_id","topic_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiences" ADD CONSTRAINT "contribution_kind" CHECK ("experiences"."contribution_kind" in ('experience','comment','evidence'));--> statement-breakpoint
ALTER TABLE "experiences" ADD CONSTRAINT "evidence_source_required" CHECK ("experiences"."contribution_kind" <> 'evidence' or "experiences"."source_url" is not null or "experiences"."withdrawn_at" is not null or "experiences"."deleted_at" is not null);--> statement-breakpoint
ALTER TABLE "experiences" ADD CONSTRAINT "avatar_identity_scope" CHECK ("experiences"."display_mode" = 'nickname' or "experiences"."display_avatar_url" is null);
