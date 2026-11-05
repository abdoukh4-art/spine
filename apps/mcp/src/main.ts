import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadMcpConfig } from './config.js';
import { createSpineMcpServer } from './server.js';
import { SpineClient } from './spine-client.js';

/**
 * Entry point: an MCP server over stdio, for local clients such as Claude Code or Claude Desktop
 * (ADR-0096). stdout carries the protocol, so diagnostics go to stderr only.
 */
async function main(): Promise<void> {
  const config = loadMcpConfig(process.env);
  const spine = new SpineClient({
    baseUrl: config.apiUrl,
    email: config.email,
    password: config.password,
    timeoutMs: config.timeoutMs,
  });
  const server = createSpineMcpServer({ spine, allowLiveRuns: config.allowLiveRuns });
  await server.connect(new StdioServerTransport());
  // stdout carries the MCP protocol: diagnostics go to stderr.
  process.stderr.write(
    `spine-mcp: connected (api ${config.apiUrl}, live runs ${config.allowLiveRuns ? 'ENABLED' : 'disabled'})\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`spine-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
