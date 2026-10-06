import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Anchor,
  Button,
  Code,
  Collapse,
  Group,
  PasswordInput,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { IconAlertTriangle, IconPlus, IconRefresh, IconTrash } from '@tabler/icons-react';
import {
  isMcpEnvName,
  normalizeConnection,
  providerForModel,
  type McpConnection,
  type McpConnectionInput,
  type McpServerStatusInfo,
} from '@lines/shared';
import { useStore } from '../store';
import {
  MCP_STATUS_UNKNOWN,
  mcpConnectionErrorText,
  mcpStatusMeta,
  codexUnsupportedReason,
} from '../lib/mcpConnections';
import { SettingsGroup, SettingsRow } from './SettingsLayout';

const TRANSPORTS = [
  { value: 'http', label: 'HTTP' },
  { value: 'sse', label: 'SSE' },
  { value: 'stdio', label: 'stdio (local command)' },
];

/**
 * MCP servers the user has added, with each one's live connection state.
 *
 * Adds run the same shared validator the bridge does — a row that looks right
 * but can never connect would be worse than no row at all — and header and env
 * values are write-only here, exactly like a password field: the bridge never
 * sends one back, so an existing credential shows as its name and nothing else
 * (plus, for an env var, whether this machine has a value for it).
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
  // Which engine the open session runs on — the two read status by different
  // routes, and only one of them has to start a CLI child to do it.
  const codexSession = useStore((s) => {
    const meta = selectedSessionId ? s.sessions[selectedSessionId] : undefined;
    return meta ? providerForModel(meta.model) === 'openai' : false;
  });

  // Status is a per-session reading, so it needs a session to read from. The
  // open one is the only sensible choice here.
  //
  // Not warmed: opening Settings must not spawn a CLI child as a side effect. So
  // a session that has never run a turn reads as "No status yet" here — which is
  // why the Authorize control below is no longer gated on a status at all. The
  // Refresh button is the explicit-intent version and does warm.
  useEffect(() => {
    if (selectedSessionId) requestMcpStatus(selectedSessionId);
  }, [selectedSessionId, requestMcpStatus]);

  const byName = useMemo(() => {
    const map = new Map<string, McpServerStatusInfo>();
    for (const s of statuses ?? []) map.set(s.name, s);
    return map;
  }, [statuses]);

  return (
    <>
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
      <Group justify="space-between" wrap="nowrap" px="md">
        <Text size="xs" c="dimmed">
          {!selectedSessionId
            ? 'Open a session to see connection status.'
            : codexSession
              ? // No warming on this path: codex reports for its whole home, so a
                // session that has never run a turn still has a real reading.
                'Status is read from the OpenAI agent.'
              : 'Status is read from the open session.'}
        </Text>
        {selectedSessionId && (
          <Tooltip
            label={
              codexSession
                ? 'Refresh status'
                : "Refresh status — starts this session's agent if it isn't running"
            }
          >
            <ActionIcon
              variant="subtle"
              size="sm"
              aria-label="Refresh connection status"
              onClick={() => requestMcpStatus(selectedSessionId, true)}
            >
              <IconRefresh size={14} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>

      {/* A footer rather than trimmed away: header and env values are secrets,
          and this says where they live. */}
      <SettingsGroup
        title="Servers"
        footer="Header and environment values stay on this machine and are never synced, so a connection you add here arrives on your other machines without them — an HTTP one shows as “Needs authorization” until you enter its token there too."
      >
        {connections.length === 0 ? (
          <SettingsRow
            label={
              <Text span inherit c="dimmed">
                No connections yet.
              </Text>
            }
          />
        ) : (
          connections.map((connection) => (
            <ConnectionRow
              key={connection.id}
              connection={connection}
              status={byName.get(connection.name)}
              sessionId={selectedSessionId}
              onToggle={(enabled) =>
                updateMcpConnection(connection.id, { ...withoutHeldMarks(connection), enabled })
              }
              onRemove={() => removeMcpConnection(connection.id)}
            />
          ))
        )}
      </SettingsGroup>
      <AddConnectionForm />
    </>
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
  const [editingEnv, setEditingEnv] = useState(false);
  // A disabled connection ships no tools, so the SDK never reports on it — say
  // so locally rather than showing the last reading from when it was on.
  const meta = !connection.enabled
    ? mcpStatusMeta('disabled')
    : status
      ? mcpStatusMeta(status.status)
      : MCP_STATUS_UNKNOWN;

  // OAuth is an HTTP/SSE concept — a stdio server takes its credentials from its
  // own env — and the control is offered whatever the status reading says.
  //
  // It used to appear only on a `needs-auth` reading, which made it unreachable:
  // a connection the user has just added is in no live query yet, so it reports
  // no status at all and the button never rendered. Offering it unconditionally
  // costs a wasted click at worst; gating it cost the whole feature.
  const canAuthorize = connection.enabled && connection.transport !== 'stdio';
  // Hidden only while a handshake is actually in flight or waiting on the
  // browser. A finished one leaves its note *and* the control, so re-authorizing
  // never needs a dismissal first.
  const showAuthorize = canAuthorize && !auth?.pending && !auth?.authUrl;
  const unauthorized = !status || status.status === 'needs-auth' || status.status === 'failed';
  // Codex expresses a narrower set of connections than the Claude SDK does. A
  // row it cannot express still works everywhere else, so this is a note on the
  // row rather than an error or a disabled control.
  const codexNote = connection.enabled ? codexUnsupportedReason(connection) : null;
  const openaiConnected = useStore((s) => s.openaiAuth?.loggedIn === true);

  return (
    <SettingsRow
      leftSection={
        <Tooltip label={meta.label}>
          <span
            className="status-dot"
            style={{ ['--status-dot-color' as string]: meta.color }}
            aria-label={meta.label}
          />
        </Tooltip>
      }
      label={<Code>{connection.name}</Code>}
      description={
        <Text inherit truncate>
          {connection.transport === 'stdio' ? connection.command : connection.url}
        </Text>
      }
      control={
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
      }
    >
      {connection.headerKeys?.length ? (
        <Text size="xs" c="dimmed">
          Headers: {connection.headerKeys.join(', ')}
        </Text>
      ) : null}
      {connection.transport === 'stdio' &&
        (editingEnv ? (
          <EnvEditor connection={connection} onDone={() => setEditingEnv(false)} />
        ) : (
          <EnvSummary connection={connection} onEdit={() => setEditingEnv(true)} />
        ))}
      {openaiConnected && codexNote && (
        // Only once an OpenAI account exists: until then there is no session this
        // could apply to, and the note would be noise on a working connection.
        <Text size="xs" c="dimmed">
          {codexNote}
        </Text>
      )}
      {status?.error && (
        <Text size="xs" c="red">
          {status.error}
        </Text>
      )}
      {showAuthorize && (
        <Group gap="xs" wrap="nowrap" align="flex-start">
          <Button
            size="compact-xs"
            variant={unauthorized ? 'light' : 'subtle'}
            disabled={!sessionId}
            // Mantine's button label clips rather than overflows, so a shrinkable
            // button next to the flex: 1 caveat below loses its tail — which bit
            // the longer 'Re-authorize…' string. The caveat wraps instead.
            style={{ flexShrink: 0 }}
            onClick={() => sessionId && authorizeMcpConnection(sessionId, connection.name)}
          >
            {unauthorized ? 'Authorize…' : 'Re-authorize…'}
          </Button>
          <Text size="xs" c="dimmed" style={{ flex: 1 }}>
            {sessionId
              ? // Stated up front rather than discovered as a dead redirect: the
                // callback URL is loopback on the bridge's machine, so a browser
                // anywhere else cannot complete the handshake.
                'Opens this server’s sign-in in a new tab. The redirect returns to Lines on the machine running it, so authorize from a browser there.'
              : 'Open a session to authorize.'}
          </Text>
        </Group>
      )}
      {auth?.pending && (
        <Text size="xs" c="dimmed">
          Starting authorization…
        </Text>
      )}
      {auth?.alreadyAuthorized && (
        <Text size="xs" c="teal">
          Already authorized — this server has a token on this machine.
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
          <Anchor
            component="button"
            type="button"
            size="xs"
            c="dimmed"
            // Same clipping as the Authorize button: a long provider error would
            // otherwise squeeze this link out of reach.
            style={{ flexShrink: 0 }}
            onClick={() => clearMcpAuth(connection.name)}
          >
            Dismiss
          </Anchor>
        </Group>
      )}
    </SettingsRow>
  );
}

/*
 * Environment variables for a stdio server.
 *
 * Write-only, like a header value: the bridge never sends a stored value back,
 * so a saved one is an empty box that says it is saved, and leaving the box
 * empty on save keeps it. What the bridge does send is `envValuesHeld` — which
 * names have a value on this machine — so a connection synced from elsewhere,
 * which brings its names and never its values, can say what is missing here.
 * A typed value lives in this form's state until save and nowhere else.
 */

/** One variable in an editor. */
interface EnvDraft {
  /** React key: a new variable's name is still being typed, so it cannot be one. */
  key: number;
  name: string;
  /** Typed here, never loaded — the box starts empty whatever is stored. */
  value: string;
  /** Already declared on the connection, so its name is fixed and a value may be stored. */
  declared: boolean;
  /** This machine holds a value for it. */
  held: boolean;
}

let nextEnvDraftKey = 0;

function newEnvDraft(): EnvDraft {
  return { key: nextEnvDraftKey++, name: '', value: '', declared: false, held: false };
}

/** An existing connection's variables as editor rows: every name, and no value in any box. */
function declaredEnvDrafts(connection: McpConnection): EnvDraft[] {
  const held = new Set(connection.envValuesHeld ?? []);
  return (connection.envKeys ?? []).map((name) => ({
    key: nextEnvDraftKey++,
    name,
    value: '',
    declared: true,
    held: held.has(name),
  }));
}

/** Why the variables cannot be saved as they stand, or null. */
function envDraftIssue(drafts: EnvDraft[]): string | null {
  const seen = new Set<string>();
  for (const draft of drafts) {
    const name = draft.name.trim();
    if (!name) return 'Every environment variable needs a name';
    // Checked here because the shared validator skips a bad name silently,
    // which would lose it — and the value typed beside it — on save.
    if (!isMcpEnvName(name)) return `“${name}” cannot be an environment variable name`;
    if (seen.has(name)) return `${name} is listed twice`;
    seen.add(name);
  }
  return null;
}

/** The names to declare, and a value for each box something was typed into. */
function envDraftPayload(drafts: EnvDraft[]): { envKeys: string[]; values: Record<string, string> } {
  const values: Record<string, string> = {};
  for (const draft of drafts) if (draft.value) values[draft.name.trim()] = draft.value;
  return { envKeys: drafts.map((draft) => draft.name.trim()), values };
}

/** A connection as an edit sends it back. The held marks are the bridge's to work out, not ours to claim. */
function withoutHeldMarks({ envValuesHeld: _held, ...connection }: McpConnection): McpConnectionInput {
  return connection;
}

function EnvFields({
  drafts,
  onChange,
}: {
  drafts: EnvDraft[];
  onChange: (next: EnvDraft[]) => void;
}) {
  const patch = (key: number, change: Partial<EnvDraft>) =>
    onChange(drafts.map((draft) => (draft.key === key ? { ...draft, ...change } : draft)));
  return (
    <Stack gap={6}>
      {drafts.map((draft) => (
        <Group key={draft.key} gap="xs" wrap="nowrap">
          {draft.declared ? (
            <Code style={{ flex: '0 1 40%', minWidth: 0, overflowWrap: 'anywhere' }}>{draft.name}</Code>
          ) : (
            <TextInput
              size="xs"
              style={{ flex: '0 1 40%', minWidth: 0 }}
              placeholder="API_KEY"
              aria-label="Variable name"
              value={draft.name}
              onChange={(e) => patch(draft.key, { name: e.currentTarget.value })}
            />
          )}
          <PasswordInput
            size="xs"
            style={{ flex: 1, minWidth: 0 }}
            aria-label={draft.name.trim() ? `Value of ${draft.name.trim()}` : 'Variable value'}
            // Whether a value is stored, never the value: there is none here to show.
            placeholder={
              draft.held ? 'Saved on this machine' : draft.declared ? 'Not set on this machine' : 'Value'
            }
            autoComplete="off"
            value={draft.value}
            onChange={(e) => patch(draft.key, { value: e.currentTarget.value })}
          />
          <ActionIcon
            variant="subtle"
            color="red"
            size="sm"
            aria-label={`Remove ${draft.name.trim() || 'variable'}`}
            onClick={() => onChange(drafts.filter((d) => d.key !== draft.key))}
          >
            <IconTrash size={14} />
          </ActionIcon>
        </Group>
      ))}
      <Group>
        <Button
          size="compact-xs"
          variant="subtle"
          leftSection={<IconPlus size={12} />}
          onClick={() => onChange([...drafts, newEnvDraft()])}
        >
          Add variable
        </Button>
      </Group>
    </Stack>
  );
}

/** A stdio row's one-line account of its environment, and the way into editing it. */
function EnvSummary({ connection, onEdit }: { connection: McpConnection; onEdit: () => void }) {
  const names = connection.envKeys ?? [];
  const held = new Set(connection.envValuesHeld ?? []);
  const missing = names.filter((name) => !held.has(name));
  return (
    <Group gap="xs" wrap="nowrap" align="flex-start">
      <Text size="xs" c="dimmed" style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
        {names.length ? `Environment: ${names.join(', ')}` : 'No environment variables'}
        {missing.length > 0 && (
          // Usually a connection synced from another machine: the names came
          // with it, and the values never travel.
          <Text span inherit c="orange">
            {` — not set on this machine: ${missing.join(', ')}`}
          </Text>
        )}
      </Text>
      <Anchor component="button" type="button" size="xs" style={{ flexShrink: 0 }} onClick={onEdit}>
        {names.length ? 'Edit…' : 'Add…'}
      </Anchor>
    </Group>
  );
}

/** Add or remove an existing connection's variables, and enter their values. */
function EnvEditor({ connection, onDone }: { connection: McpConnection; onDone: () => void }) {
  const updateMcpConnection = useStore((s) => s.updateMcpConnection);
  const [drafts, setDrafts] = useState(() => declaredEnvDrafts(connection));
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    const issue = envDraftIssue(drafts);
    if (issue) {
      setError(issue);
      return;
    }
    const { envKeys, values } = envDraftPayload(drafts);
    // A box left empty sends nothing, which the bridge reads as "keep the stored
    // value"; a removed row leaves its name out, which drops that value there.
    updateMcpConnection(connection.id, { ...withoutHeldMarks(connection), envKeys, env: values });
    onDone();
  };

  return (
    <Stack gap={6}>
      <Text size="xs" c="dimmed">
        Values stay on this machine and are never shown again. Leave a box empty to keep what is saved.
      </Text>
      <EnvFields
        drafts={drafts}
        onChange={(next) => {
          setDrafts(next);
          setError(null);
        }}
      />
      {error && (
        <Text size="xs" c="red">
          {error}
        </Text>
      )}
      <Group gap="xs">
        <Button size="compact-xs" onClick={save}>
          Save
        </Button>
        <Anchor component="button" type="button" size="xs" c="dimmed" onClick={onDone}>
          Cancel
        </Anchor>
      </Group>
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
  const [envDrafts, setEnvDrafts] = useState<EnvDraft[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName('');
    setTransport('http');
    setUrl('');
    setCommand('');
    setArgs('');
    setHeaderName('');
    setHeaderValue('');
    setEnvDrafts([]);
    setError(null);
  };

  const submit = () => {
    const envIssue = transport === 'stdio' ? envDraftIssue(envDrafts) : null;
    if (envIssue) {
      setError(envIssue);
      return;
    }
    const env = transport === 'stdio' ? envDraftPayload(envDrafts) : null;
    const draft: McpConnectionInput = {
      name,
      transport,
      enabled: true,
      ...(transport === 'stdio'
        ? {
            command,
            args: args.trim() ? args.trim().split(/\s+/) : undefined,
            envKeys: env?.envKeys,
          }
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
      // The validator keeps env names only, so the values go back on here: raw
      // `env` is how they reach the bridge, which files them locally.
      env && Object.keys(env.values).length ? { ...connection, env: env.values } : connection,
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
        <SettingsGroup>
          <Stack gap="xs" px="md" py="sm">
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
                <Stack gap={4}>
                  <Text size="sm" fw={500}>
                    Environment variables
                  </Text>
                  <Text size="xs" c="dimmed">
                    Optional — for servers that take a key. Values stay on this machine.
                  </Text>
                  <EnvFields
                    drafts={envDrafts}
                    onChange={(next) => {
                      setEnvDrafts(next);
                      setError(null);
                    }}
                  />
                </Stack>
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
        </SettingsGroup>
      </Collapse>
    </Stack>
  );
}
