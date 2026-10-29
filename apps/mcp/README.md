# @spine/mcp: the AI analyst's MCP server

An [MCP](https://modelcontextprotocol.io) server that lets an AI assistant, such as Claude in Claude
Code or Claude Desktop, help triage Spine alerts: read the queue, explain scores, rehearse playbooks,
and brief a human. Design and guardrails: [ADR-0096](../../docs/adr/0096-mcp-ai-analyst-with-guardrails.md).

**What it can't do, by design:** approve or reject approvals, close alerts, edit playbooks, manage
users. And Spine itself enforces **four eyes**: the agent can never approve a run it started, even
with its raw token.

## Tools

| Tool                     | Does                                                                          | Writes? |
| ------------------------ | ----------------------------------------------------------------------------- | ------- |
| `list_alerts`            | Filter the queue (status, severity, min score, text)                          | no      |
| `get_alert`              | Score explanation, enrichment verdicts, runs; sensor text fenced as untrusted | no      |
| `list_playbooks`         | What can be proposed                                                          | no      |
| `get_run`                | A run step by step, and whether it waits for a human                          | no      |
| `list_pending_approvals` | What humans need to decide (read only)                                        | no      |
| `get_metrics_summary`    | MTTD, MTTR, volume, playbook outcomes                                         | no      |
| `set_alert_status`       | `triaged` or `in_progress` only                                               | yes     |
| `propose_playbook_run`   | **Dry run by default**; live only if `SPINE_MCP_ALLOW_LIVE_RUNS=true`         | yes     |

Prompt: `triage_alert` (assess, explain, rehearse, recommend; never decide).

## Run it

```bash
make demo                              # a running stack with the ai-analyst@spine.test account
pnpm --filter @spine/mcp build
node apps/mcp/scripts/smoke.mjs        # drives the server like an agent and checks every guardrail
```

Claude Code, in the repository root (`.mcp.json`):

```json
{
  "mcpServers": {
    "spine": {
      "command": "node",
      "args": ["apps/mcp/dist/main.js"],
      "env": {
        "SPINE_API_URL": "http://localhost:8080",
        "SPINE_MCP_EMAIL": "ai-analyst@spine.test",
        "SPINE_MCP_PASSWORD": "night-owl-demo-claude-2026"
      }
    }
  }
}
```

Then ask: _"Use the triage_alert prompt on the highest-scoring new alert."_

| Variable                                 | Default                 | Meaning                                                |
| ---------------------------------------- | ----------------------- | ------------------------------------------------------ |
| `SPINE_API_URL`                          | `http://localhost:8080` | Spine's edge or API                                    |
| `SPINE_MCP_EMAIL` / `SPINE_MCP_PASSWORD` | required                | The agent's **own** analyst account (never a human's)  |
| `SPINE_MCP_ALLOW_LIVE_RUNS`              | `false`                 | Allow non-dry runs (approval steps still need a human) |
| `SPINE_MCP_TIMEOUT_MS`                   | `10000`                 | Per-request timeout towards Spine                      |

## Layout

`src/config.ts` (env), `src/spine-client.ts` (HTTP client: login, re-login on 401, Zod-validated
responses), `src/views.ts` (the prompt-injection boundary), `src/server.ts` (tools and prompt),
`src/main.ts` (stdio). Tests: `test/server.test.ts` runs a real MCP client against the server
in memory, with a fake Spine behind it.
