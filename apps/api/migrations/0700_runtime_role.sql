-- 0700 runtime role (ADR-0092, security review F4).
--
-- The API and worker should not connect as the table owner: an owner can
-- `ALTER TABLE audit_log DISABLE TRIGGER ...` and rewrite history. This migration creates a
-- NOLOGIN group role `spine_runtime` holding exactly the privileges the app needs, and makes the
-- audit log append-only BY PRIVILEGE (no UPDATE/DELETE/TRUNCATE), not only by trigger.
-- Login roles (e.g. `spine_app`) are created by the migrate command from DATABASE_URL, because
-- a password does not belong in a migration file.
--
-- Everything is scoped to current_schema(), so it works in any schema (and in the
-- per-file test schemas). ALTER DEFAULT PRIVILEGES covers tables that later migrations create.
DO $$
DECLARE
  s text := current_schema();
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'spine_runtime') THEN
    BEGIN
      CREATE ROLE spine_runtime NOLOGIN;
    EXCEPTION
      -- Another session created it concurrently (roles are cluster-wide).
      WHEN duplicate_object OR unique_violation THEN NULL;
    END;
  END IF;

  EXECUTE format('GRANT USAGE ON SCHEMA %I TO spine_runtime', s);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO spine_runtime', s);
  EXECUTE format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA %I TO spine_runtime', s);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO spine_runtime', s);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO spine_runtime', s);

  -- Append-only by privilege: insert and read, nothing else.
  EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I.audit_log FROM spine_runtime', s);
  -- Migration history is read by the readiness probe and written only by the migrate command.
  EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON %I.schema_migrations FROM spine_runtime', s);
END
$$;
