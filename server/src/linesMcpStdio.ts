/**
 * Lines' own tools, served to `codex` as a real MCP server over stdio.
 *
 * The Claude path hosts these tools *inside* the SDK, as an in-process server the
 * worker constructs (`workerMcp.ts`). Codex has no equivalent hook: it spawns
 * every MCP server as a child process named in its `config.toml`. So the same
 * tool surface needs a second front door, and this file is it.
 *
 * It is a **thin proxy, not a second implementation**. The manifest and every
 * handler stay on the bridge exactly as they are for Claude — this process asks
 * the bridge what tools exist, and forwards each call to it. That is what keeps
 * the two front doors from drifting: there is still one description of the
 * surface and one implementation behind it, and rewording a tool still needs no
 * restart of anything.
 *
 * Spawned by codex, so it must be quiet on stdout: stdout *is* the MCP
 * transport, and a stray `console.log` corrupts the stream. Diagnostics go to
 * stderr, which codex surfaces as the server's log.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'node:url';
import { runtimeFilePath } from './workerProtocol.ts';
import type { JsonSchemaNode, McpToolManifest, McpToolResult } from './workerProtocol.ts';

/** How the bridge identifies itself to a child it spawned. Mode 0600, written at
 *  boot, replaced on every restart — so a stale copy fails closed. */
interface BridgeRunFile {
  port: number;
  token: string;
}

/**
 * Marks an argv as "codex spawned this file to actually serve MCP", as opposed
 * to some other process merely importing `linesMcpServerConfig` from it. Path
 * identity (`argv[1] === this file`) used to be the guard, and broke the moment
 * a packaged build's bundler folded this file into `bridge.mjs` as a dependency:
 * `import.meta.url` then resolved to the bridge's own entrypoint, so the bridge
 * matched its own guard, tried to serve MCP on its own stdio with no run file,
 * and crash-looped. A sentinel survives any future bundling arrangement because
 * it says nothing about where this code physically lives.
 */
const LINES_MCP_STDIO_FLAG = '--lines-mcp-stdio';

/**
 * `--run-file` and `--user` are passed by whoever wrote the codex config, rather
 * than discovered here: this process must not have to know how Lines lays out its
 * state directory, and a wrong guess would be a silent connection to nothing.
 */
function readArgs(): { runFile: string; userId: string } {
  const argv = process.argv.slice(2);
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const runFile =
    value('--run-file') ?? path.join(os.homedir(), '.lines-app', 'run', 'default', 'bridge.json');
  const userId = value('--user') ?? 'local';
  return { runFile, userId };
}

function readRunFile(file: string): BridgeRunFile {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<BridgeRunFile>;
  if (typeof raw.port !== 'number' || typeof raw.token !== 'string' || !raw.token) {
    throw new Error(`run file ${file} carries no port/token`);
  }
  return { port: raw.port, token: raw.token };
}

/**
 * One call to the bridge's `/lines-mcp` route.
 *
 * Re-reads the run file per call rather than caching it. The bridge hot-reloads
 * and rebinds; this process is long-lived because codex keeps it for the life of
 * the thread, so a cached port and token would go stale under it and every tool
 * would start failing with nothing to point at.
 */
async function callBridge(
  runFile: string,
  userId: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const { port, token } = readRunFile(runFile);
  const res = await fetch(`http://127.0.0.1:${port}/lines-mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Bearer on the loopback interface, matched in constant time by the bridge.
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ ...body, userId }),
  });
  if (!res.ok) throw new Error(`bridge answered ${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * The manifest's closed JSON-Schema subset, as the JSON Schema MCP wants.
 *
 * Almost an identity function — which is the point. `workerMcp.ts` has to
 * convert the same manifest into Zod because the Claude SDK's `tool()` takes a
 * Zod shape; MCP takes JSON Schema directly, so this side only has to fill in
 * what the subset leaves implicit (`type: 'object'` and an empty property map
 * for a tool that takes no arguments).
 */
function toInputSchema(node: JsonSchemaNode): Record<string, unknown> {
  return {
    type: 'object',
    properties: (node.properties ?? {}) as Record<string, unknown>,
    ...(node.required?.length ? { required: node.required } : {}),
  };
}

async function main() {
  const { runFile, userId } = readArgs();
  // Fail loudly and immediately if the bridge is not reachable: codex reports a
  // server that dies during handshake, whereas one that starts and then answers
  // every tool call with an error looks like a broken tool.
  const manifest = (await callBridge(runFile, userId, { op: 'manifest' })) as McpToolManifest;

  const server = new Server(
    { name: manifest.serverName, version: '1.0.0' },
    { capabilities: { tools: {} }, instructions: manifest.instructions },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: manifest.tools.map((spec) => ({
      name: spec.name,
      description: spec.description,
      inputSchema: toInputSchema(spec.inputSchema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = (await callBridge(runFile, userId, {
        op: 'call',
        tool: name,
        args: args ?? {},
      })) as McpToolResult;
      // Same widening `workerMcp.ts` needs: the SDK's result type carries an
      // index signature for MCP's `_meta`/task passthrough, which the protocol's
      // narrowed result deliberately omits.
      return result as McpToolResult & Record<string, unknown>;
    } catch (err) {
      // An error the model can read and act on, rather than a transport failure
      // that reads to it as "the tool is broken".
      return {
        content: [
          {
            type: 'text',
            text: `Lines is not reachable from this session (${err instanceof Error ? err.message : String(err)}). The app may have restarted — try again.`,
          },
        ],
        isError: true,
      };
    }
  });

  await server.connect(new StdioServerTransport());
  console.error(`[lines-mcp] serving ${manifest.tools.length} tools for ${userId}`);
}

/**
 * How codex should spawn this file, as a `config.toml` MCP server entry.
 *
 * Lives here rather than beside the config writer because the answer depends on
 * how *this* module is being run, which only this module can see: under `tsx`
 * `import.meta.url` is this `.ts` file, which node cannot execute alone. In a
 * packaged build it is bundled into `bridge.mjs` as a dependency — `import.meta.url`
 * there resolves to the bridge's own entrypoint, not a standalone script, so the
 * packaged branch below points instead at `linesMcpStdio.mjs`, built alongside
 * `bridge.mjs`/`worker.mjs` for exactly this purpose (see desktop/scripts/build.mjs).
 *
 * `process.execPath` rather than `"node"`: the desktop app's node is the Electron
 * binary, and a bare `node` may not be on the PATH codex inherits at all.
 */
export function linesMcpServerConfig(userId: string): Record<string, unknown> {
  const here = fileURLToPath(import.meta.url);
  const args = here.endsWith('.ts')
    ? ['--import', 'tsx', here]
    : [path.join(path.dirname(here), 'linesMcpStdio.mjs')];
  return {
    command: process.execPath,
    args: [
      ...args,
      LINES_MCP_STDIO_FLAG,
      '--run-file',
      runtimeFilePath('bridge'),
      '--user',
      userId,
    ],
    // ELECTRON_RUN_AS_NODE is how the desktop build's Electron binary agrees to
    // behave as plain node; harmless everywhere else.
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

/**
 * Only when codex spawned this file with the sentinel flag `linesMcpServerConfig`
 * always passes. `index.ts` imports this module for `linesMcpServerConfig` alone,
 * and a bundler is free to fold it into the bridge's own entrypoint — deciding by
 * path identity (`argv[1] === this file`) broke exactly that way once already
 * (see `LINES_MCP_STDIO_FLAG`), so the flag, not the path, is what starts an MCP
 * server on stdio. Starting one on the bridge's own stdio would write protocol
 * frames into its log.
 */
if (process.argv.includes(LINES_MCP_STDIO_FLAG)) {
  main().catch((err) => {
    console.error('[lines-mcp] failed to start:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
