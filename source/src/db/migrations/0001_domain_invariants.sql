-- Published snapshots and approved payloads are immutable; privacy is enforced by
-- visibility-aware DTOs rather than quietly rewriting already published history.
CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_events are append-only'; END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_claim_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status IN ('published','superseded') AND (
  NEW.text IS DISTINCT FROM OLD.text OR NEW.conditions_snapshot IS DISTINCT FROM OLD.conditions_snapshot OR
  NEW.evidence_ids IS DISTINCT FROM OLD.evidence_ids OR NEW.contributor_display_snapshot IS DISTINCT FROM OLD.contributor_display_snapshot OR
  NEW.topic_id IS DISTINCT FROM OLD.topic_id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.version_number IS DISTINCT FROM OLD.version_number OR
  NEW.base_version_id IS DISTINCT FROM OLD.base_version_id OR NEW.reviewer_id IS DISTINCT FROM OLD.reviewer_id OR NEW.published_at IS DISTINCT FROM OLD.published_at
 ) THEN RAISE EXCEPTION 'published claim snapshots are immutable'; END IF;
 IF OLD.status='superseded' AND NEW.status IS DISTINCT FROM OLD.status THEN RAISE EXCEPTION 'superseded versions cannot become current'; END IF;
 IF OLD.status='published' AND NEW.status NOT IN ('published','superseded') THEN RAISE EXCEPTION 'published versions can only be superseded'; END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER claim_snapshot_immutable BEFORE UPDATE ON claim_versions FOR EACH ROW EXECUTE FUNCTION protect_claim_snapshot();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_publication_payload() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.immutable_payload IS DISTINCT FROM OLD.immutable_payload OR NEW.preview_hash IS DISTINCT FROM OLD.preview_hash OR
  NEW.approval_id IS DISTINCT FROM OLD.approval_id OR NEW.approved_by_id IS DISTINCT FROM OLD.approved_by_id OR
  NEW.provider_mode IS DISTINCT FROM OLD.provider_mode OR NEW.target_circle_id IS DISTINCT FROM OLD.target_circle_id OR
  NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.probe_id IS DISTINCT FROM OLD.probe_id
 THEN RAISE EXCEPTION 'approved publication payloads are immutable'; END IF;
 IF OLD.status='sent' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.remote_id IS DISTINCT FROM OLD.remote_id OR NEW.remote_url IS DISTINCT FROM OLD.remote_url OR NEW.sent_at IS DISTINCT FROM OLD.sent_at) THEN RAISE EXCEPTION 'sent receipts are immutable'; END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER publication_payload_immutable BEFORE UPDATE ON publications FOR EACH ROW EXECUTE FUNCTION protect_publication_payload();
