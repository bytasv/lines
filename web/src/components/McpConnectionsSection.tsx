import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Anchor,
  Button,
  Code,
  Collapse,
  Group,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { IconAlertTriangle, IconPlus, IconRefresh, IconTrash } from '@tabler/icons-react';
import {
  normalizeConnection,
  type McpConnection,
  type McpConnectionInput,
  type McpServerStatusInfo,
} from '@lines/shared';
import { useStore } from '../store';
import {
  MCP_STATUS_UNKNOWN,
  mcpConnectionErrorText,
  mcpStatusMeta,
} from '../lib/mcpConnections';

const TRANSPORTS = [
  { value: 'http', label: 'HTTP' },
  { value: 'sse', label: 'SSE' },
  { value: 'stdio', label: 'stdio (local command)' },
];

/**
 * MCP servers the user has added, with each one's live connection state.
 *
 * Adds run the same shared validator the bridge does — a row that looks right
 * but can never connect would be worse than no row at all — and header values
 * are write-only here, exactly like a password field: the bridge never sends one
 * back, so an existing credential shows as its name and nothing else.
 *
 * `.mcp.json` and `~/.claude/settings.json` still reach sessions on their own
 * (the bridge sets `settingSources`), so this list is additive rather than the
 * only way in.
 */
export function McpConnectionsSection({ onOpenReview }: { onOpenReview: () => void }) {
  const connections = useStore((s) => s.mcpConnections);
  const review = useStore((s) => s.mcpReview);
  const removeMcpConnection = useStore((s) => s.removeMcpConnection);
  const updateMcpConnection = useStore((s) => s.updateMcpConnection);
  const selectedSessionId = useStore((s) => s.selectedSessionId);
  const requestMcpStatus = useStore((s) => s.requestMcpStatus);
  const statuses = useStore((s) => (selectedSessionId ? s.mcpStatus[selectedSessionId] : undefined));

  // Status is a per-session reading, so it needs a session to read from. The
  // open one is the only sensible choice here, and a refresh is offered because
  // the answer changes when a query starts.
  useEffect(() => {
    if (selectedSessionId) requestMcpStatus(selectedSessionId);
  }, [selectedSessionId, requestMcpStatus]);

  const byName = useMemo(() => {
    const map = new Map<string, McpServerStatusInfo>();
    for (const s of statuses ?? []) map.set(s.name, s);
    return map;
  }, [statuses]);

  return (
    <Stack gap="xs">
      {review && (
        <Alert color="yellow" icon={<IconAlertTriangle size={16} />} p="xs">
          <Group justify="space-between" wrap="nowrap" gap="xs">
            <Text size="sm">This list changed on another machine.</Text>
            <Button size="xs" variant="default" onClick={onOpenReview}>
              Review…
            </Button>
          </Group>
        </Alert>
      )}
      <Text size="xs" c="dimmed">
        Every enabled connection’s tools are offered to every session. Header values stay on this
        machine and are never synced, so a connection you add here shows as “Needs authorization”
        on your other machines until you enter its token there too.
      </Text>
      <Group justify="space-between" wrap="nowrap">
        <Text size="xs" c="dimmed">
          {selectedSessionId
            ? 'Status is read from the open session.'
            : 'Open a session to see connection status.'}
        </Text>
        {selectedSessionId && (
          <Tooltip label="Refresh status">
            <ActionIcon
              variant="subtle"
              size="sm"
              aria-label="Refresh connection status"
              onClick={() => requestMcpStatus(selectedSessionId)}
            >
              <IconRefresh size={14} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>

      {connections.length === 0 ? (
        <Text size="sm" c="dimmed">
          No connections yet.
        </Text>
      ) : (
        connections.map((connection) => (
          <ConnectionRow
            key={connection.id}
            connection={connection}
            status={byName.get(connection.name)}
            sessionId={selectedSessionId}
            onToggle={(enabled) => updateMcpConnection(connection.id, { ...connection, enabled })}
            onRemove={() => removeMcpConnection(connection.id)}
          />
        ))
      )}
      <AddConnectionForm />
    </Stack>
  );
}

function ConnectionRow({
  connection,
  status,
  sessionId,
  onToggle,
  onRemove,
}: {
  connection: McpConnection;
  status?: McpServerStatusInfo;
  /** The session whose live query drives an OAuth handshake; null = none open. */
  sessionId: string | null;
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
}) {
  const auth = useStore((s) => s.mcpAuth[connection.name]);
  const authorizeMcpConnection = useStore((s) => s.authorizeMcpConnection);
  const clearMcpAuth = useStore((s) => s.clearMcpAuth);
  // A disabled connection ships no tools, so the SDK never reports on it — say
  // so locally rather than showing the last reading from when it was on.
  const meta = !connection.enabled
    ? mcpStatusMeta('disabled')
    : status
      ? mcpStatusMeta(status.status)
      : MCP_STATUS_UNKNOWN;

  return (
    <Stack gap={2}>
      <Group justify="space-between" wrap="nowrap">
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <Tooltip label={meta.label}>
            <span
              className="status-dot"
              style={{ ['--status-dot-color' as string]: meta.color }}
              aria-label={meta.label}
            />
          </Tooltip>
          <Code>{connection.name}</Code>
          <Text size="xs" c="dimmed" truncate>
            {connection.transport === 'stdio' ? connection.command : connection.url}
          </Text>
        </Group>
        <Group gap="xs" wrap="nowrap">
          <Switch
            size="xs"
            checked={connection.enabled}
            onChange={(e) => onToggle(e.currentTarget.checked)}
            aria-label={`${connection.enabled ? 'Disable' : 'Enable'} ${connection.name}`}
          />
          <Tooltip label="Remove">
            <ActionIcon
              variant="subtle"
              color="red"
              size="sm"
              aria-label={`Remove ${connection.name}`}
              onClick={onRemove}
            >
              <IconTrash size={14} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>
      {connection.headerKeys?.length ? (
        <Text size="xs" c="dimmed">
          Headers: {connection.headerKeys.join(', ')}
        </Text>
      ) : null}
      {status?.error && (
        <Text size="xs" c="red">
          {status.error}
        </Text>
      )}
      {status?.status === 'needs-auth' && !auth && (
        <Group gap="xs" wrap="nowrap">
          <Button
            size="compact-xs"
            variant="light"
            disabled={!sessionId}
            onClick={() => sessionId && authorizeMcpConnection(sessionId, connection.name)}
          >
            Authorize…
          </Button>
          <Text size="xs" c="dimmed">
            {sessionId
              ? 'Opens this server’s sign-in in a new tab.'
              : 'Open a session with a running turn to authorize.'}
          </Text>
        </Group>
      )}
      {auth?.pending && (
        <Text size="xs" c="dimmed">
          Starting authorization…
        </Text>
      )}
      {auth?.authUrl && (
        <Group gap="xs" wrap="nowrap">
          {/* A plain link, not an auto-open: a popup blocker eats window.open
              here, and the user should see where they are being sent. */}
          <Anchor href={auth.authUrl} target="_blank" rel="noreferrer noopener" size="xs">
            Sign in to {connection.name} ↗
          </Anchor>
          <Text size="xs" c="dimmed">
            Lines finishes the handshake when the tab redirects back.
          </Text>
        </Group>
      )}
      {auth?.ok && (
        <Text size="xs" c="teal">
          Authorized.
        </Text>
      )}
      {auth?.error && (
        <Group gap="xs" wrap="nowrap" align="flex-start">
          <Text size="xs" c="red" style={{ flex: 1 }}>
            {auth.error}
          </Text>
          <Anchor component="button" type="button" size="xs" c="dimmed" onClick={() => clearMcpAuth(connection.name)}>
            Dismiss
          </Anchor>
        </Group>
      )}
    </Stack>
  );
}

/** The add form. Kept in its own component so its draft state resets on submit. */
function AddConnectionForm() {
  const addMcpConnection = useStore((s) => s.addMcpConnection);
  const connections = useStore((s) => s.mcpConnections);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [transport, setTransport] = useState('http');
  const [url, setUrl] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [headerName, setHeaderName] = useState('');
  const [headerValue, setHeaderValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName('');
    setTransport('http');
    setUrl('');
    setCommand('');
    setArgs('');
    setHeaderName('');
    setHeaderValue('');
    setError(null);
  };

  const submit = () => {
    const draft: McpConnectionInput = {
      name,
      transport,
      enabled: true,
      ...(transport === 'stdio'
        ? { command, args: args.trim() ? args.trim().split(/\s+/) : undefined }
        : { url, headerKeys: headerName.trim() ? [headerName.trim()] : undefined }),
    };
    const result = normalizeConnection(draft);
    if ('error' in result) {
      setError(mcpConnectionErrorText(result.error));
      return;
    }
    if (connections.some((c) => c.name === result.connection.name)) {
      setError('A connection with that name already exists');
      return;
    }
    // The id the validator minted is thrown away: the bridge mints its own, and
    // this one only existed so the client could run the identical rules.
    const { id: _minted, ...connection } = result.connection;
    addMcpConnection(
      connection,
      headerName.trim() && headerValue ? { [headerName.trim()]: headerValue } : undefined,
    );
    reset();
    setOpen(false);
  };

  return (
    <Stack gap="xs">
      <Group>
        <Button
          size="xs"
          variant="default"
          leftSection={<IconPlus size={14} />}
          onClick={() => setOpen((o) => !o)}
        >
          Add connection
        </Button>
      </Group>
      <Collapse expanded={open}>
        <Stack gap="xs">
          <Group gap="xs" grow wrap="nowrap" align="flex-start">
            <TextInput
              label="Name"
              size="sm"
              placeholder="figma"
              description="Tools arrive as mcp__<name>__*"
              value={name}
              onChange={(e) => {
                setName(e.currentTarget.value);
                setError(null);
              }}
            />
            <Select
              label="Transport"
              size="sm"
              data={TRANSPORTS}
              value={transport}
              allowDeselect={false}
              onChange={(v) => {
                setTransport(v ?? 'http');
                setError(null);
              }}
            />
          </Group>
          {transport === 'stdio' ? (
            <>
              <TextInput
                label="Command"
                size="sm"
                placeholder="npx"
                value={command}
                onChange={(e) => {
                  setCommand(e.currentTarget.value);
                  setError(null);
                }}
              />
              <TextInput
                label="Arguments"
                size="sm"
                placeholder="-y some-mcp-server"
                description="Space-separated"
                value={args}
                onChange={(e) => setArgs(e.currentTarget.value)}
              />
            </>
          ) : (
            <>
              <TextInput
                label="URL"
                size="sm"
                placeholder="https://mcp.figma.com/mcp"
                value={url}
                onChange={(e) => {
                  setUrl(e.currentTarget.value);
                  setError(null);
                }}
              />
              <Group gap="xs" grow wrap="nowrap" align="flex-start">
                <TextInput
                  label="Header name"
                  size="sm"
                  placeholder="Authorization"
                  description="Optional — for servers that take a token"
                  value={headerName}
                  onChange={(e) => {
                    setHeaderName(e.currentTarget.value);
                    setError(null);
                  }}
                />
                <TextInput
                  label="Header value"
                  size="sm"
                  type="password"
                  placeholder="Bearer …"
                  description="Stays on this machine"
                  value={headerValue}
                  onChange={(e) => setHeaderValue(e.currentTarget.value)}
                />
              </Group>
            </>
          )}
          {error && (
            <Text size="xs" c="red">
              {error}
            </Text>
          )}
          <Group gap="xs">
            <Button size="xs" onClick={submit}>
              Add
            </Button>
            <Anchor
              component="button"
              type="button"
              size="xs"
              c="dimmed"
              onClick={() => {
                reset();
                setOpen(false);
              }}
            >
              Cancel
            </Anchor>
          </Group>
        </Stack>
      </Collapse>
    </Stack>
  );
}
