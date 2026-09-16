// SPDX-License-Identifier: AGPL-3.0-only
// Additional permission under GNU AGPL v3 section 7 — see LICENSE-EXCEPTION.

/**
 * Builds a session's in-process MCP server inside the worker.
 *
 * `createSdkMcpServer()` returns a config holding a live `McpServer` object, so
 * it cannot cross the bridge→worker socket — the server has to be constructed
 * here. What crosses instead is a JSON-Schema {@link McpToolManifest}; this file
 * converts it to Zod and points every tool handler back at the bridge.
 *
 * It is the third (and only other) member of the worker's import graph, and
 * qualifies on the same terms as workerProtocol.ts: it knows nothing about
 * workflows or any other domain, only about turning protocol-shaped schemas into
 * tool definitions. Tool names, descriptions and argument shapes all live on the
 * bridge, so tuning them never restarts the worker.
 */
import { z, type ZodTypeAny } from 'zod';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { JsonSchemaNode, McpToolManifest, McpToolResult } from './workerProtocol.ts';

/**
 * One JSON-Schema node as a Zod type.
 *
 * Never throws. This runs on the `ensureSession` path, where a throw would kill
 * the turn that triggered it rather than surface a bad schema — so an
 * unrecognised node degrades to `z.unknown()` and the tool still exists, just
 * with a laxer argument than intended.
 */
export function jsonSchemaToZod(node: JsonSchemaNode): ZodTypeAny {
  const described = (t: ZodTypeAny) => (node.description ? t.describe(node.description) : t);

  // An enum pins the value regardless of the declared type.
  if (node.enum?.length) return described(z.enum(node.enum as [string, ...string[]]));

  switch (node.type) {
    case 'string':
      return described(z.string());
    case 'number':
      return described(z.number());
    case 'integer':
      return described(z.number().int());
    case 'boolean':
      return described(z.boolean());
    case 'array':
      return described(z.array(node.items ? jsonSchemaToZod(node.items) : z.unknown()));
    case 'object':
      return described(z.object(jsonSchemaToZodShape(node)));
    default:
      return described(z.unknown());
  }
}

/**
 * The property map of an object node, as the raw Zod shape `tool()` expects.
 * Anything outside `required` is optional. A non-object node has no properties,
 * so it yields an empty shape (a tool taking no arguments).
 */
export function jsonSchemaToZodShape(node: JsonSchemaNode): Record<string, ZodTypeAny> {
  const required = new Set(node.required ?? []);
  const shape: Record<string, ZodTypeAny> = {};
  for (const [key, value] of Object.entries(node.properties ?? {})) {
    const zodType = jsonSchemaToZod(value);
    if (required.has(key)) {
      shape[key] = zodType;
      continue;
    }
    // Re-describe on the outside: the SDK's schema conversion reads the
    // description off the outermost type, so an optional() wrapper hides the
    // inner one and the model never sees it. Most of the guidance a tool gives
    // (defaults, which fields a 'ref' step needs) lives on optional arguments.
    const optional = zodType.optional();
    shape[key] = value.description ? optional.describe(value.description) : optional;
  }
  return shape;
}

/**
 * The SDK's MCP `extra` is typed `unknown`, but it is an MCP
 * `RequestHandlerExtra`, which carries the caller's AbortSignal. Read
 * defensively: losing the signal only costs cancellation, whereas assuming the
 * shape would throw inside a tool call.
 */
function signalOf(extra: unknown): AbortSignal | undefined {
  const signal = (extra as { signal?: unknown } | null | undefined)?.signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

/**
 * A server whose every tool forwards to `invoke` — the same shape as the
 * `canUseTool`/`PreToolUse` callbacks: the worker decides nothing, it just
 * carries the call to the bridge and the answer back.
 */
export function buildMcpServer(
  manifest: McpToolManifest,
  invoke: (
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<McpToolResult>,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: manifest.serverName,
    version: '1.0.0',
    instructions: manifest.instructions,
    tools: manifest.tools.map((spec) =>
      tool(
        spec.name,
        spec.description,
        jsonSchemaToZodShape(spec.inputSchema),
        async (args, extra) => {
          const result = await invoke(spec.name, args as Record<string, unknown>, signalOf(extra));
          // The SDK's CallToolResult carries an index signature for MCP's `_meta`
          // passthrough, which the protocol's narrowed result type omits on purpose.
          return result as McpToolResult & Record<string, unknown>;
        },
      ),
    ),
  });
}
