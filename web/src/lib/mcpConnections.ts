import type { McpConnectionError, McpServerStatusInfo } from '@lines/shared';

/** Plain-language form copy for each refusal the shared validator can return. */
const MCP_CONNECTION_ERROR_TEXT: Record<McpConnectionError, string> = {
  'empty-name': 'Enter a name',
  'bad-name': 'Names are lowercase letters, digits, dashes and underscores, starting with a letter',
  'reserved-name': '“lines” is reserved for Lines’ own tools',
  'bad-transport': 'Pick a transport',
  'bad-url': 'Enter a full http:// or https:// URL',
  'empty-command': 'Enter a command to run',
  'bad-header-name': 'Header names are letters, digits, dashes and underscores',
  'too-many-headers': 'That is too many headers',
  'bad-timeout': 'Timeout must be between 1000 and 600000 ms',
};

export function mcpConnectionErrorText(error: McpConnectionError): string {
  return MCP_CONNECTION_ERROR_TEXT[error];
}

/**
 * Dot colour and label per connection state, in the same vocabulary
 * `sessionRowMeta` uses: green for working, red for broken, yellow for
 * something the user has to act on, grey for inert.
 */
const MCP_STATUS_META: Record<
  McpServerStatusInfo['status'],
  { color: string; label: string }
> = {
  connected: { color: 'var(--mantine-color-teal-6)', label: 'Connected' },
  failed: { color: 'var(--mantine-color-red-6)', label: 'Failed' },
  'needs-auth': { color: 'var(--mantine-color-yellow-6)', label: 'Needs authorization' },
  pending: { color: 'var(--mantine-color-blue-5)', label: 'Connecting…' },
  disabled: { color: 'var(--mantine-color-gray-5)', label: 'Disabled' },
};

export function mcpStatusMeta(status: McpServerStatusInfo['status']) {
  return MCP_STATUS_META[status];
}

/** Grey with no label — a connection no live session has reported on yet. */
export const MCP_STATUS_UNKNOWN = {
  color: 'var(--mantine-color-gray-5)',
  label: 'No status yet',
};
