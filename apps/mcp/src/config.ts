import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const EnvSchema = z.object({
  SPINE_API_URL: z.url().default('http://localhost:8080'),
  SPINE_MCP_EMAIL: z.email('SPINE_MCP_EMAIL must be the AI analyst account email'),
  SPINE_MCP_PASSWORD: z.string().min(1, 'SPINE_MCP_PASSWORD is required'),
  SPINE_MCP_ALLOW_LIVE_RUNS: bool.default(false),
  SPINE_MCP_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(10_000),
});

/** Configuration of the Spine MCP server (ADR-0096). Secrets come only from the environment. */
export interface McpConfig {
  /** Base URL of Spine's edge (nginx) or API. */
  apiUrl: string;
  /** The AI analyst's own Spine account: a separate identity, audited as itself. */
  email: string;
  password: string;
  /**
   * Whether `propose_playbook_run` may start **live** (non-dry) runs. Off by default: the agent
   * can only rehearse. Even when on, approval steps still need a human, and the four-eyes rule
   * stops the agent approving runs it started.
   */
  allowLiveRuns: boolean;
  /** Per-request timeout towards Spine. */
  timeoutMs: number;
}

/** Reads and validates the configuration; throws with every problem listed. */
export function loadMcpConfig(env: Record<string, string | undefined>): McpConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`);
    throw new Error(`invalid Spine MCP configuration:\n${problems.join('\n')}`);
  }
  const e = parsed.data;
  return {
    apiUrl: e.SPINE_API_URL.replace(/\/+$/, ''),
    email: e.SPINE_MCP_EMAIL,
    password: e.SPINE_MCP_PASSWORD,
    allowLiveRuns: e.SPINE_MCP_ALLOW_LIVE_RUNS,
    timeoutMs: e.SPINE_MCP_TIMEOUT_MS,
  };
}
