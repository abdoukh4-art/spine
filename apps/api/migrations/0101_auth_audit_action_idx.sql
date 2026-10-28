-- 0101 auth: index for the audit-log `action` prefix filter (GET /audit-log?action=auth.).
-- `text_pattern_ops` lets `action LIKE 'prefix%'` use the index whatever the database
-- collation; `id DESC` matches the endpoint's newest-first keyset order.
CREATE INDEX audit_log_action_idx ON audit_log (action text_pattern_ops, id DESC);
