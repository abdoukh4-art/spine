#!/usr/bin/env node
// Calls one tool of the Spine MCP server over stdio and prints its result, so you can see
// exactly what a model would see (tutorial 04). Needs a running stack and a built server.
//
//   node apps/mcp/scripts/call-tool.mjs list                      # list the tools
//   node apps/mcp/scripts/call-tool.mjs get_alert '{"alertId":"<uuid>"}'
//
// Env: SPINE_API_URL, SPINE_MCP_EMAIL, SPINE_MCP_PASSWORD, SPINE_MCP_ALLOW_LIVE_RUNS (the demo
// AI analyst account is the default).
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const [tool, rawArgs = '{}'] = process.argv.slice(2);
if (!tool) {
  console.error('usage: call-tool.mjs <tool|list> [json-arguments]');
  process.exit(2);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL('../dist/main.js', import.meta.url).pathname],
  env: {
    PATH: process.env.PATH ?? '',
    SPINE_API_URL: process.env.SPINE_API_URL ?? 'http://localhost:8080',
    SPINE_MCP_EMAIL: process.env.SPINE_MCP_EMAIL ?? 'ai-analyst@spine.test',
    SPINE_MCP_PASSWORD: process.env.SPINE_MCP_PASSWORD ?? 'night-owl-demo-claude-2026',
    SPINE_MCP_ALLOW_LIVE_RUNS: process.env.SPINE_MCP_ALLOW_LIVE_RUNS ?? 'false',
  },
  stderr: 'pipe',
});
const client = new Client({ name: 'spine-call-tool', version: '0.0.0' });
await client.connect(transport);
try {
  if (tool === 'list') {
    for (const t of (await client.listTools()).tools) console.log(`${t.name}: ${t.title ?? ''}`);
  } else {
    const result = await client.callTool({ name: tool, arguments: JSON.parse(rawArgs) });
    if (result.isError) console.log('TOOL ERROR:');
    for (const block of result.content ?? []) if (block.type === 'text') console.log(block.text);
  }
} finally {
  await client.close();
}
