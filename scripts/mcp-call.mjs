import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [tool] = process.argv.slice(2);
const json = process.env.MCP_ARGS ?? process.argv[3] ?? '{}';
if (!tool) throw new Error('Usage: node scripts/mcp-call.mjs <tool> <json-args>');
const client = new Client({ name: 'manual-acceptance', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(process.env.WAYMARK_MCP ?? process.env.AGENT_BROWSER_MCP ?? 'http://127.0.0.1:9510/mcp')));
try {
  const result = await client.callTool({ name: tool, arguments: JSON.parse(json) });
  const text = result.content?.[0]?.text;
  if (text) {
    const start = text.indexOf('\n');
    const end = text.lastIndexOf('\n[END_UNTRUSTED_PAGE_CONTENT');
    const body = start >= 0 && end > start ? text.slice(start + 1, end) : text;
    try { console.log(JSON.stringify(JSON.parse(body), null, 2)); }
    catch { console.log(body); }
  } else console.log(JSON.stringify(result, null, 2));
} finally { await client.close(); }
