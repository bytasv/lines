import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Divider,
  Group,
  Indicator,
  Loader,
  Modal,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
  Tooltip,
} from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import { IconAlertCircle, IconCopy, IconPlayerPlay } from '@tabler/icons-react';
import type { ModelProvider, PermissionMode, ReasoningEffort, RoutingMode, RoutingRule, SyncLogEntry } from '@lines/shared';
import { capabilitiesForModel, providerForModel, REASONING_EFFORTS, validateRoutingRule } from '@lines/shared';
import { emptyRoutingRule, RoutingRuleFields } from './RoutingRuleFields';
import { useStore, type CompactionLevel } from '../store';
import { ALERT_SOUND_OPTIONS } from '../lib/alerts';
import { isIos, isStandalone } from '../lib/push';
import { GuardAllowlistSection } from './GuardAllowlistSection';
import { McpConnectionsSection } from './McpConnectionsSection';
import { useIsPhone } from '../lib/layout';
import { DevicesSection } from './DevicesSection';
import { EncryptionSection } from './EncryptionSection';
import { CollaboratorsSection } from './CollaboratorsSection';
import { UpdatesSection } from './UpdatesSection';
import { VoiceSection } from './VoiceSection';
import { DEVICE_PAIRING_ENABLED } from '../lib/storage';
import { SHARING_ENABLED } from '../lib/shares';
import {
  AUTO_EFFORT,
  describedOptionRenderer,
  describedOptionStyles,
  effortSelectData,
  modelSelectData,
  renderOptionWithDescription,
} from '../lib/modelSelect';
import { PERMISSION_MODE_SEGMENTS } from '../lib/permissionModes';
import { fileRequest, send } from '../ws';
import { useIsGuest } from '../lib/can';

export type SettingsSection =
  | 'account'
  | 'devices'
  | 'encryption'
  | 'collaborators'
  | 'sessions'
  | 'transcript'
  | 'notifications'
  | 'allowlist'
  | 'connections'
  | 'diagnostics'
  | 'docs'
  | 'voice'
  | 'updates';

const SETTINGS_SECTIONS: { value: SettingsSection; label: string }[] = [
  { value: 'account', label: 'Account' },
  // Only in a hosted build. A local install talks to the bridge on this machine,
  // which is the one and only device — a list of one it cannot revoke is noise.
  ...(DEVICE_PAIRING_ENABLED
    ? [
        { value: 'devices' as SettingsSection, label: 'Machines' },
        // Beside Machines, because enrolling a key is a property of the machine
        // this browser is pointed at — and only a hosted build has a relay in
        // the middle worth removing from the trust chain.
        { value: 'encryption' as SettingsSection, label: 'Encryption' },
      ]
    : []),
  // Same reasoning: with no storage server there is nothing to share and nobody
  // to have shared with.
  ...(SHARING_ENABLED
    ? [{ value: 'collaborators' as SettingsSection, label: 'Collaborators' }]
    : []),
  { value: 'sessions', label: 'Sessions' },
  { value: 'transcript', label: 'Transcript' },
  { value: 'notifications', label: 'Notifications' },
  { value: 'voice', label: 'Voice input' },
  { value: 'allowlist', label: 'Auto-mode allowlist' },
  { value: 'connections', label: 'Connections' },
  { value: 'diagnostics', label: 'Sync' },
  { value: 'docs', label: 'Documentation' },
  { value: 'updates', label: 'Updates' },
];

/**
 * Machines is the only pane a guest may see: it lists *their* account's machines
 * and is how they get back to one of their own. Every other pane reads or writes
 * the host's state — settings, the guard allowlist, their MCP connections, their
 * Claude account, their sync log — all of which the bridge refuses to a guest
 * anyway.
 */
const GUEST_SECTIONS = SETTINGS_SECTIONS.filter((s) => s.value === 'devices');

export function SettingsModal({
  opened,
  onClose,
  initialSection = 'account',
}: {
  opened: boolean;
  onClose: () => void;
  initialSection?: SettingsSection;
}) {
  const guardReview = useStore((s) => s.guardReview);
  const openGuardReview = useStore((s) => s.openGuardReview);
  const mcpReview = useStore((s) => s.mcpReview);
  const openMcpReview = useStore((s) => s.openMcpReview);
  const guest = useIsGuest();
  const sections = guest ? GUEST_SECTIONS : SETTINGS_SECTIONS;
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const isPhone = useIsPhone();

  // Snapshot in a ref so a guardReview that clears mid-edit cannot yank the
  // user off the allowlist pane; only an open transition picks the section.
  const initialRef = useRef(initialSection);
  initialRef.current = initialSection;
  useEffect(() => {
    if (opened) setSection(initialRef.current);
  }, [opened]);

  return (
    // Flex-shelled like WorkflowEditor: fixed-height nav rail + scrolling pane.
    <Modal
      opened={opened}
      onClose={onClose}
      title="Settings"
      // Full-screen on a phone: a 90%-wide modal over a 390px viewport leaves a
      // sliver of backdrop that swallows taps meant for the pane.
      fullScreen={isPhone}
      size="90%"
      centered
      padding={0}
      transitionProps={{ transition: 'fade' }}
      // On a phone the full-screen rules in index.css own the height and the
      // header's top padding (safe-area inset), so no inline height or
      // padding-top here: inline styles would beat them.
      styles={{
        content: isPhone
          ? { display: 'flex', flexDirection: 'column' }
          : { height: '88vh', display: 'flex', flexDirection: 'column' },
        body: { flex: 1, minHeight: 0, display: 'flex', padding: 0 },
        header: isPhone
          ? {
              '--mb-padding': 'var(--mantine-spacing-md)',
              paddingBottom: 'var(--mantine-spacing-xs)',
            }
          : { padding: 'var(--mantine-spacing-md)', paddingBottom: 'var(--mantine-spacing-xs)' },
      }}
    >
      <Group align="stretch" gap={0} wrap="nowrap" style={{ flex: 1, minHeight: 0 }}>
        {/* The rail is the navigation, so it narrows rather than disappearing —
            a phone-only section picker would be a second way to do one thing. */}
        <Stack gap="xs" w={isPhone ? 132 : 200} p={isPhone ? 'xs' : 'md'} style={{ flexShrink: 0 }}>
          {sections.map((s) => {
            const button = (
              <Button
                fullWidth
                variant={s.value === section ? 'light' : 'subtle'}
                color="gray"
                justify="start"
                onClick={() => setSection(s.value)}
              >
                <Text size="xs" truncate>
                  {s.label}
                </Text>
              </Button>
            );
            return (
              <Indicator
                key={s.value}
                size={6}
                color="yellow"
                // Only the two review-bearing items carry the pending dot; the
                // rest wrap a disabled Indicator so the rail stays uniform.
                disabled={
                  !(s.value === 'allowlist' && guardReview) &&
                  !(s.value === 'connections' && mcpReview)
                }
                offset={2}
                // Block, not Indicator's default inline-block: the wrapped
                // Button has to fill the rail.
                style={{ display: 'block' }}
              >
                {button}
              </Indicator>
            );
          })}
        </Stack>
        <Divider orientation="vertical" />
        <ScrollArea style={{ flex: 1 }} type="hover">
          <Stack gap="xs" p="md" maw={620}>
            {section === 'account' && <AccountSection onClose={onClose} />}
            {section === 'devices' && <DevicesSection />}
            {section === 'encryption' && <EncryptionSection />}
            {section === 'collaborators' && <CollaboratorsSection />}
            {section === 'sessions' && <SessionsSection onOpenUpdates={() => setSection('updates')} />}
            {section === 'transcript' && <TranscriptSection />}
            {section === 'notifications' && <NotificationsSection />}
            {section === 'diagnostics' && <SyncLogSection />}
            {section === 'docs' && <DocsSection onClose={onClose} />}
            {section === 'voice' && <VoiceSection />}
            {section === 'updates' && <UpdatesSection />}
            {section === 'allowlist' && (
              <GuardAllowlistSection
                onOpenReview={() => {
                  onClose();
                  openGuardReview();
                }}
              />
            )}
            {section === 'connections' && (
              <McpConnectionsSection
                onOpenReview={() => {
                  onClose();
                  openMcpReview();
                }}
              />
            )}
          </Stack>
        </ScrollArea>
      </Group>
    </Modal>
  );
}

function AccountSection({ onClose }: { onClose: () => void }) {
  return (
    <Stack gap="xs">
      <ClaudeAccountRow onClose={onClose} />
      <OpenaiAccountRow onClose={onClose} />
    </Stack>
  );
}

/**
 * The OpenAI (ChatGPT) account, for sessions on a Codex model. A second row
 * rather than a mode of the Claude one: the two are independent connections, and
 * either alone is enough to run turns.
 */
function OpenaiAccountRow({ onClose }: { onClose: () => void }) {
  const auth = useStore((s) => s.openaiAuth);
  const openModal = useStore((s) => s.openOpenaiLoginModal);

  return auth?.loggedIn ? (
    <Group justify="space-between" wrap="nowrap">
      <Text size="sm" truncate>
        {auth.account?.email ?? 'Connected to OpenAI'}
        {auth.account?.organization ? ` · ${auth.account.organization}` : ''}
      </Text>
      <Button size="xs" variant="default" onClick={() => send({ type: 'openaiLogout' })}>
        Disconnect
      </Button>
    </Group>
  ) : (
    <Group justify="space-between" wrap="nowrap">
      <Text size="sm" c="dimmed">
        No OpenAI account connected
      </Text>
      <Button
        size="xs"
        variant="default"
        onClick={() => {
          onClose();
          openModal();
        }}
      >
        Connect…
      </Button>
    </Group>
  );
}

function ClaudeAccountRow({ onClose }: { onClose: () => void }) {
  const auth = useStore((s) => s.auth);
  const openLoginModal = useStore((s) => s.openLoginModal);

  return auth?.loggedIn ? (
    <Group justify="space-between" wrap="nowrap">
      <Text size="sm" truncate>
        {auth.account?.email ?? 'Signed in'}
        {auth.account?.organization ? ` · ${auth.account.organization}` : ''}
      </Text>
      <Button size="xs" variant="default" onClick={() => send({ type: 'authLogout' })}>
        Log out
      </Button>
    </Group>
  ) : (
    <Group justify="space-between" wrap="nowrap">
      <Text size="sm" c="dimmed">
        Not signed in to Claude
      </Text>
      <Button
        size="xs"
        onClick={() => {
          onClose();
          openLoginModal();
        }}
      >
        Sign in…
      </Button>
    </Group>
  );
}

/** Hand-off to the documentation reader — close first, like the sign-in and allowlist-review buttons. */
function DocsSection({ onClose }: { onClose: () => void }) {
  const activeProject = useStore((s) => s.activeProject);
  const navigate = useNavigate();

  return (
    <>
      <Text size="xs" fw={600} c="dimmed" tt="uppercase">
        Documentation
      </Text>
      <Text size="sm" c="dimmed">
        Read the active project’s docs/ folder in the app — feature index, doc tree, and full-text
        search.
      </Text>
      <Text size="xs" c="dimmed" ff="monospace" truncate>
        {activeProject ? `${activeProject}/docs` : 'No project open'}
      </Text>
      <Group>
        <Button
          size="xs"
          disabled={!activeProject}
          onClick={() => {
            onClose();
            navigate('/docs');
          }}
        >
          Open documentation
        </Button>
        {!activeProject && (
          <Text size="xs" c="dimmed">
            Open a project first.
          </Text>
        )}
      </Group>
    </>
  );
}

/** `onOpenUpdates` follows GuardAllowlistSection's `onOpenReview`: the pane that
 *  fixes a missing CLI is a sibling of this one, and only the parent can switch. */
function SessionsSection({ onOpenUpdates }: { onOpenUpdates: () => void }) {
  // Controlled only so the warning icon can close it before the pane switches —
  // see the composer for why this is the prop and not an injected store.
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const models = useStore((s) => s.models);
  const openaiConnected = useStore((s) => s.openaiAuth?.loggedIn === true);
  const claudeCli = useStore((s) => s.claudeCli);
  const codexCli = useStore((s) => s.codexCli);
  const defaults = useStore((s) => s.newSessionDefaults);
  const setDefaults = useStore((s) => s.setNewSessionDefaults);
  const autoContinueInterrupted = useStore((s) => s.autoContinueInterrupted);
  const setAutoContinueInterrupted = useStore((s) => s.setAutoContinueInterrupted);
  const compressResponses = useStore((s) => s.compressResponses);
  const setCompressResponses = useStore((s) => s.setCompressResponses);
  const planReasoningEffort = useStore((s) => s.planReasoningEffort);
  const setPlanReasoningEffort = useStore((s) => s.setPlanReasoningEffort);
  const planModeRejectWrites = useStore((s) => s.planModeRejectWrites);
  const setPlanModeRejectWrites = useStore((s) => s.setPlanModeRejectWrites);

  return (
    <>
      <Text size="xs" fw={600} c="dimmed" tt="uppercase">
        New session defaults
      </Text>
      <Select
        label="Model"
        // Both providers. An OpenAI model with no account connected is shown
        // disabled rather than hidden: hiding it leaves no clue the option exists,
        // and this is the pane the Connect button lives in.
        data={modelSelectData(models, defaults.model, {
          ...(openaiConnected
            ? {}
            : { unavailable: { openai: 'Connect an OpenAI account in Account above' } }),
          // A CLI this machine doesn't have warns rather than blocks, exactly as
          // the composer's picker does: it is the prerequisite the app cannot fix,
          // and the icon leads to the Updates pane that can.
          warn: {
            ...(claudeCli && claudeCli.state !== 'ok'
              ? { anthropic: `Claude Code CLI is ${claudeCli.state === 'missing' ? 'not installed' : 'out of date'}` }
              : {}),
            ...(codexCli && codexCli.state !== 'ok'
              ? { openai: `Codex CLI is ${codexCli.state === 'missing' ? 'not installed' : 'out of date'}` }
              : {}),
          },
        })}
        dropdownOpened={modelDropdownOpen}
        onDropdownOpen={() => setModelDropdownOpen(true)}
        onDropdownClose={() => setModelDropdownOpen(false)}
        renderOption={describedOptionRenderer(() => {
          setModelDropdownOpen(false);
          onOpenUpdates();
        })}
        styles={describedOptionStyles}
        value={defaults.model}
        onChange={(v) => v && setDefaults({ ...defaults, model: v })}
        allowDeselect={false}
      />
      <Select
        label="Reasoning effort"
        description="How hard a new session thinks. Auto leaves it to the model."
        // The chosen default model's own engine decides the vocabulary. The two
        // agree today; the capability is still what is asked, so they may not.
        data={effortSelectData(
          capabilitiesForModel(defaults.model, providerForModel).reasoningEfforts,
          defaults.reasoningEffort,
        )}
        renderOption={renderOptionWithDescription}
        value={defaults.reasoningEffort ?? AUTO_EFFORT}
        onChange={(v) =>
          v &&
          setDefaults({
            ...defaults,
            reasoningEffort: v === AUTO_EFFORT ? undefined : (v as ReasoningEffort),
          })
        }
        allowDeselect={false}
      />
      <Stack gap={4}>
        <Text size="sm" fw={500}>
          Permission mode
        </Text>
        <SegmentedControl
          size="xs"
          data={PERMISSION_MODE_SEGMENTS}
          value={defaults.permissionMode}
          onChange={(v) => setDefaults({ ...defaults, permissionMode: v as PermissionMode })}
        />
      </Stack>
      {/* Global, not a newSessionDefaults member — hence its own subgroup. Plan
          mode gets its own effort for the same reason codex keeps
          `plan_mode_reasoning_effort` in config rather than per thread: planning
          is the one turn worth paying more for regardless of the session. */}
      <Text size="xs" fw={600} c="dimmed" tt="uppercase" mt="sm">
        Plan mode
      </Text>
      <Select
        label="Reasoning effort"
        description="Applies to plan-mode turns in every session, overriding the session's own effort. A level the session's engine does not offer is ignored. Takes effect on the next turn."
        data={effortSelectData(REASONING_EFFORTS, planReasoningEffort)}
        renderOption={renderOptionWithDescription}
        value={planReasoningEffort ?? AUTO_EFFORT}
        onChange={(v) =>
          v && setPlanReasoningEffort(v === AUTO_EFFORT ? null : (v as ReasoningEffort))
        }
        allowDeselect={false}
      />
      <Switch
        checked={planModeRejectWrites}
        onChange={(e) => setPlanModeRejectWrites(e.currentTarget.checked)}
        label="Auto-reject writes in plan mode"
        description="Deny edits, non-read shell commands and other writes instead of asking. The agent keeps planning."
      />
      <SmartRoutingSettings />
      {/* Global, not a newSessionDefaults member — hence its own subgroup. */}
      <Text size="xs" fw={600} c="dimmed" tt="uppercase" mt="sm">
        Recovery
      </Text>
      <Switch
        checked={autoContinueInterrupted}
        onChange={(e) => setAutoContinueInterrupted(e.currentTarget.checked)}
        label="Auto-continue interrupted turns"
        description="Resume a turn that died with the app instead of waiting for the Continue button"
      />
      {/* Global, not a newSessionDefaults member — hence its own subgroup. */}
      <Text size="xs" fw={600} c="dimmed" tt="uppercase" mt="sm">
        Response style
      </Text>
      <Switch
        checked={compressResponses}
        onChange={(e) => setCompressResponses(e.currentTarget.checked)}
        label="Compress"
        description="Claude replies in a terse, compressed register — articles, filler and pleasantries dropped, technical detail kept — which cuts output tokens. Code, commits and security warnings stay in normal prose. Ruleset adapted from the MIT caveman project. Applies to every session; a change takes effect the next time a session starts a fresh turn."
      />
    </>
  );
}

const ROUTING_MODE_SEGMENTS: { value: RoutingMode; label: string }[] = [
  { value: 'off', label: 'Disabled' },
  { value: 'auto', label: 'Enabled, auto' },
  { value: 'ask', label: 'Enabled, ask' },
];

/**
 * Smart routing: JEV may move each turn to another allowed model or effort.
 * Global, one rule per connected provider. The mode applies at once; a rule is
 * saved with its own button, because the bridge refuses an incomplete one and a
 * save per keystroke would be refused until the last.
 */
function SmartRoutingSettings() {
  const models = useStore((s) => s.models);
  const openaiConnected = useStore((s) => s.openaiAuth?.loggedIn === true);
  const available = useStore((s) => s.smartRoutingAvailable);
  const routing = useStore((s) => s.smartRouting);
  const setSmartRouting = useStore((s) => s.setSmartRouting);
  const mode = routing?.mode ?? 'off';
  const rules = routing?.rules ?? {};
  const providers: ModelProvider[] = openaiConnected ? ['anthropic', 'openai'] : ['anthropic'];

  return (
    <>
      <Text size="xs" fw={600} c="dimmed" tt="uppercase" mt="sm">
        Smart routing
      </Text>
      <Text size="xs" c="dimmed">
        Before each turn, TypeSafe's JEV picks a model and effort from the lists below, by your rule.
        The turn's prompt text is sent to TypeSafe; the transcript is not. A manual model or effort
        change pauses routing for that session.
      </Text>
      {available === false && (
        <Alert color="yellow" icon={<IconAlertCircle size={16} />} p="xs">
          No TypeSafe API key on this machine. Set TYPESAFE_API_KEY for the bridge; until then every
          turn runs on its current settings.
        </Alert>
      )}
      <SegmentedControl
        size="xs"
        data={ROUTING_MODE_SEGMENTS}
        value={mode}
        onChange={(v) => setSmartRouting({ mode: v as RoutingMode, rules })}
      />
      {mode !== 'off' &&
        providers.map((provider) => (
          <ProviderRoutingRule
            key={provider}
            provider={provider}
            models={models}
            saved={rules[provider]}
            onSave={(rule) => {
              const next = { ...rules };
              if (rule) next[provider] = rule;
              else delete next[provider];
              setSmartRouting({ mode, rules: next });
            }}
          />
        ))}
    </>
  );
}

function ProviderRoutingRule({
  provider,
  models,
  saved,
  onSave,
}: {
  provider: ModelProvider;
  models: ReturnType<typeof useStore.getState>['models'];
  saved: RoutingRule | undefined;
  onSave: (rule: RoutingRule | null) => void;
}) {
  const [draft, setDraft] = useState<RoutingRule>(saved ?? emptyRoutingRule());
  // Follow a save from another tab, unless this one is mid-edit.
  const savedJson = JSON.stringify(saved ?? null);
  const [lastSaved, setLastSaved] = useState(savedJson);
  if (savedJson !== lastSaved) {
    setLastSaved(savedJson);
    setDraft(saved ?? emptyRoutingRule());
  }
  const issues = validateRoutingRule(draft, provider);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved ?? emptyRoutingRule());
  return (
    <Stack gap="xs">
      <Text size="sm" fw={500}>
        {provider === 'openai' ? 'OpenAI sessions' : 'Claude sessions'}
      </Text>
      <RoutingRuleFields provider={provider} models={models} value={draft} onChange={setDraft} />
      {dirty && issues.length > 0 && (
        <Text size="xs" c="red">
          {issues[0]}
        </Text>
      )}
      <Group gap="xs">
        <Button size="xs" disabled={!dirty || issues.length > 0} onClick={() => onSave(draft)}>
          Save rule
        </Button>
        {saved && (
          <Button size="xs" variant="subtle" color="gray" onClick={() => onSave(null)}>
            Remove rule
          </Button>
        )}
      </Group>
    </Stack>
  );
}

function TranscriptSection() {
  const compactionLevel = useStore((s) => s.compactionLevel);
  const setCompactionLevel = useStore((s) => s.setCompactionLevel);
  const turnSummariesEnabled = useStore((s) => s.turnSummariesEnabled);
  const setTurnSummariesEnabled = useStore((s) => s.setTurnSummariesEnabled);

  return (
    <>
      <Stack gap={4}>
        <Text size="sm" fw={500}>
          Compaction
        </Text>
        <SegmentedControl
          size="xs"
          data={[
            { value: 'full', label: 'Full' },
            { value: 'grouped', label: 'Grouped' },
            { value: 'compact', label: 'Compact' },
          ]}
          value={compactionLevel}
          onChange={(v) => setCompactionLevel(v as CompactionLevel)}
        />
      </Stack>
      <Switch
        checked={turnSummariesEnabled}
        onChange={(e) => setTurnSummariesEnabled(e.currentTarget.checked)}
        label="AI turn summaries"
        description="Summarize each turn's actions in a sentence; off shows the agent's own narration instead"
      />
    </>
  );
}

/**
 * Why cloud sync dropped. The bridge writes a row only for a failed storage
 * request or an availability flip, so a healthy install shows an empty list —
 * and a user seeing the amber pill has something concrete to copy into a report
 * (the bridge console isn't reachable on a desktop or VPS install).
 */
function SyncLogSection() {
  // The live status, not the one the route returns beside the rows: it is
  // broadcast on every flip, so this pane can't go stale while it is open.
  const status = useStore((s) => s.storageStatus);
  const [entries, setEntries] = useState<SyncLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const clipboard = useClipboard({ timeout: 1500 });

  useEffect(() => {
    let cancelled = false;
    fileRequest('syncLog', {})
      .then(({ status: code, body }) => {
        if (cancelled) return;
        if (code !== 200) {
          setError(`The bridge answered ${code}.`);
          return;
        }
        setEntries((body as { entries?: SyncLogEntry[] })?.entries ?? []);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Newest first: an outage is read from its most recent row backwards.
  const rows = entries ? [...entries].reverse() : [];

  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        Cloud sync keeps your sessions, workflows and steps on the storage server. Local files
        stay the source of truth, so an outage never loses work — these are the failures behind
        the “cloud sync unavailable” notice.
      </Text>

      <Group gap="xs">
        <Badge color={status?.available === false ? 'yellow' : 'green'} variant="light">
          {status?.available === false ? `unavailable${status.kind ? ` · ${status.kind}` : ''}` : 'connected'}
        </Badge>
        {status?.available === false && status.reason && (
          <Text size="xs" c="dimmed" style={{ minWidth: 0 }} truncate>
            {status.reason}
          </Text>
        )}
      </Group>

      {error && (
        <Alert color="red" icon={<IconAlertCircle size={16} />} variant="light">
          {error}
        </Alert>
      )}

      {!entries && !error ? (
        <Group justify="center" p="md">
          <Loader size="sm" />
        </Group>
      ) : rows.length === 0 ? (
        <Text size="sm" c="dimmed">
          No sync failures recorded.
        </Text>
      ) : (
        <>
          <Group>
            <Button
              size="xs"
              variant="light"
              leftSection={<IconCopy size={14} />}
              onClick={() => clipboard.copy(rows.map((e) => JSON.stringify(e)).join('\n'))}
            >
              {clipboard.copied ? 'Copied' : 'Copy log'}
            </Button>
          </Group>
          <Stack gap={4}>
            {rows.map((entry, i) => (
              <Group key={`${entry.at}-${i}`} gap="xs" wrap="nowrap" align="baseline">
                <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                  {new Date(entry.at).toLocaleString()}
                </Text>
                <Badge size="xs" variant="light" color={EVENT_COLOR[entry.event]} style={{ flexShrink: 0 }}>
                  {entry.event}
                </Badge>
                <Text size="xs" style={{ minWidth: 0 }}>
                  {syncLogDetail(entry)}
                </Text>
              </Group>
            ))}
          </Stack>
        </>
      )}
    </Stack>
  );
}

const EVENT_COLOR: Record<SyncLogEntry['event'], string> = {
  fail: 'gray',
  down: 'yellow',
  up: 'green',
};

/** One row as a line: what was tried, what came back, how long it took. */
function syncLogDetail(entry: SyncLogEntry): string {
  const parts: string[] = [];
  if (entry.kind) parts.push(entry.kind);
  if (entry.method && entry.path) parts.push(`${entry.method} ${entry.path}`);
  if (entry.status !== undefined) parts.push(String(entry.status));
  if (entry.ms !== undefined) parts.push(`${entry.ms}ms`);
  if (entry.downMs !== undefined) parts.push(`down ${Math.round(entry.downMs / 1000)}s`);
  if (entry.failures !== undefined) parts.push(`${entry.failures} failed`);
  if (entry.reason) parts.push(entry.reason);
  return parts.join(' · ');
}

function NotificationsSection() {
  const alertsEnabled = useStore((s) => s.alertsEnabled);
  const notifyPermission = useStore((s) => s.notifyPermission);
  const setAlertsEnabled = useStore((s) => s.setAlertsEnabled);
  const alertSound = useStore((s) => s.alertSound);
  const setAlertSound = useStore((s) => s.setAlertSound);
  const testAlertSound = useStore((s) => s.testAlertSound);

  const alertsDescription =
    alertsEnabled && notifyPermission !== 'granted'
      ? 'Sound only — notifications blocked in browser settings'
      : 'Chime and desktop notification when a session finishes or needs input';
  // iOS only delivers Web Push to the home-screen app, never to a Safari tab.
  const needsHomeScreen = isIos() && !isStandalone();

  return (
    <>
      <Switch
        checked={alertsEnabled}
        onChange={(e) => void setAlertsEnabled(e.currentTarget.checked)}
        label="Alerts"
        description={alertsDescription}
      />
      {needsHomeScreen && (
        <Text size="xs" c="dimmed">
          Add to Home Screen to receive notifications on this device.
        </Text>
      )}
      <Group gap="xs" align="flex-end" wrap="nowrap">
        <Select
          label="Sound"
          size="sm"
          data={ALERT_SOUND_OPTIONS}
          value={alertSound}
          onChange={(v) => v && setAlertSound(v as typeof alertSound)}
          allowDeselect={false}
          style={{ flex: 1 }}
        />
        <Tooltip label="Test sound">
          <ActionIcon
            variant="default"
            size="input-sm"
            aria-label="Test sound"
            onClick={testAlertSound}
          >
            <IconPlayerPlay size={16} />
          </ActionIcon>
        </Tooltip>
      </Group>
    </>
  );
}
