// `cie mcp` (F12 §8): the stdio MCP adapter as a separate process. It talks to the already-running local gateway
// over loopback HTTP and speaks MCP on stdio; it never imports Service, so the allowlist is a real boundary.
//   cie mcp [--repo <path>] [--url http://127.0.0.1:4317] [--no-auto-refresh]
// A non-loopback --url is refused (F12-A6).
import { McpAdapter } from "../mcp/adapter.ts";
import { HttpGatewayClient } from "../mcp/client.ts";
import { serveStdio } from "../mcp/protocol.ts";

export interface McpCliOptions { repo?: string; url: string; autoRefresh: boolean }

export function parseArgs(argv: string[]): McpCliOptions {
  const opts: McpCliOptions = { url: process.env.CIE_URL ?? "http://127.0.0.1:4317", autoRefresh: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") { const v = argv[++i]; if (!v) throw new Error("--repo requires a path"); opts.repo = v; }
    else if (a === "--url") { const v = argv[++i]; if (!v) throw new Error("--url requires a URL"); opts.url = v; }
    else if (a === "--no-auto-refresh") opts.autoRefresh = false;
    else if (a === "--help" || a === "-h") { console.log("usage: cie mcp [--repo <path>] [--url http://127.0.0.1:4317] [--no-auto-refresh]"); process.exit(0); }
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let opts: McpCliOptions;
  try { opts = parseArgs(argv); } catch (e) { console.error((e as Error).message); return 2; }
  let gateway: HttpGatewayClient;
  try { gateway = new HttpGatewayClient(opts.url); } catch (e) { console.error((e as Error).message); return 2; }
  const adapter = new McpAdapter(gateway, { autoRefresh: opts.autoRefresh });
  // One repository per server process (§2). --repo is accepted for host configurations that pass it; the gateway
  // resolves revisions per repository through the operations themselves.
  if (opts.repo) process.stderr.write(`cie mcp: repository ${opts.repo} (revisions resolve server-side)\n`);
  process.stderr.write(`cie mcp: gateway ${opts.url} (auto-refresh ${opts.autoRefresh ? "on" : "off"})\n`);
  await serveStdio(adapter);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
}
