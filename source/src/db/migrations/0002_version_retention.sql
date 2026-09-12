CREATE OR REPLACE FUNCTION protect_published_version_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status IN ('published','superseded') THEN RAISE EXCEPTION 'published version history must be retained'; END IF;
 RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER claim_version_retention BEFORE DELETE ON claim_versions FOR EACH ROW EXECUTE FUNCTION protect_published_version_deletion();
