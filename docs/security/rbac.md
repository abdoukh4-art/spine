# Role-based access control

Design: [ADR-0017](../adr/0017-rbac-model.md). Roles are hierarchical:
`viewer < analyst < admin`. A route declares the _minimum_ role in `config.access`, and
the platform enforces it ([access.ts](../../apps/api/src/platform/http/access.ts)).

**Deny by default:** the HTTP server **refuses to start** if any route lacks
`config.access`. This is enforced in [server.ts](../../apps/api/src/platform/http/server.ts)
and tested in `apps/api/test/unit/platform/http.test.ts`.

## Permission matrix

| Area                 | Endpoint(s)                                                                                                     | Minimum role                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Health               | `GET /healthz`, `GET /readyz`                                                                                   | public                                                        |
| OpenAPI              | `GET /api/v1/openapi.json`                                                                                      | public                                                        |
| Auth                 | `POST /auth/login`, `/auth/refresh`, `/auth/logout`                                                             | public (refresh/logout need the refresh cookie + CSRF header) |
| Auth                 | `GET /auth/me`                                                                                                  | viewer                                                        |
| Users                | `GET/POST/PATCH /users…`                                                                                        | admin                                                         |
| Audit                | `GET /audit-log`                                                                                                | admin                                                         |
| Alerts               | `GET /alerts`, `GET /alerts/:id`                                                                                | viewer                                                        |
| Alerts               | `PATCH /alerts/:id`, `POST /alerts/:id/enrich`                                                                  | analyst                                                       |
| Ingestion            | `POST /alerts`, `POST /ingest/batch`                                                                            | analyst                                                       |
| Ingestion            | `POST /ingest/webhooks/:sourceId`                                                                               | webhook (HMAC)                                                |
| Cases                | `GET /cases…`                                                                                                   | viewer                                                        |
| Cases                | `POST /cases`, `PATCH /cases/:id`                                                                               | analyst                                                       |
| Enrichment / scoring | `GET /enrichment/providers`, `GET /scoring/ruleset`                                                             | viewer                                                        |
| Scoring              | `POST /scoring/preview`                                                                                         | analyst                                                       |
| Playbooks            | `GET /playbooks…`, `GET /runs…`, `GET /approvals`, `GET /simulated-actions`                                     | viewer                                                        |
| Playbooks            | `POST /playbooks/validate`, `POST /playbooks/:id/runs`, `POST /runs/:id/cancel`, `POST /approvals/:id/decision` | analyst                                                       |
| Playbooks            | `POST /playbooks`, `PATCH /playbooks/:id`                                                                       | admin                                                         |
| Metrics              | `GET /metrics/summary`                                                                                          | viewer                                                        |

Keep this table in sync with the code. The auth module's RBAC matrix test reads the live
route table and compares it to the expected policies.
