-- 0100 auth: users, refresh tokens (rotation + reuse detection), append-only audit log (ADR-0016, ADR-0017).
CREATE TABLE users (
  id             uuid        PRIMARY KEY,
  email          citext      NOT NULL UNIQUE,
  display_name   text        NOT NULL,
  role           text        NOT NULL CHECK (role IN ('viewer', 'analyst', 'admin')),
  password_hash  text        NOT NULL,
  disabled       boolean     NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz
);

CREATE TABLE refresh_tokens (
  id           uuid        PRIMARY KEY,
  user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  family_id    uuid        NOT NULL,
  token_hash   bytea       NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  replaced_by  uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

CREATE TABLE audit_log (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  actor_id        uuid,
  actor_type      text        NOT NULL CHECK (actor_type IN ('user', 'system', 'webhook', 'anonymous')),
  action          text        NOT NULL,
  target_type     text,
  target_id       text,
  outcome_status  integer,
  request_id      text,
  ip              inet,
  user_agent      text,
  details         jsonb       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_occurred_idx ON audit_log (occurred_at DESC, id DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id, occurred_at DESC);

-- Append-only enforcement at the database level: even a compromised app cannot rewrite history.
CREATE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
