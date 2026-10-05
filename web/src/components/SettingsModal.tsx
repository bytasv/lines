import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Button,
  Divider,
  Group,
  Modal,
  NavLink,
  ScrollArea,
  Stack,
  Text,
  Title,
  VisuallyHidden,
} from '@mantine/core';
import {
  IconArrowsSplit,
  IconArrowUpRight,
  IconBell,
  IconBooks,
  IconChevronLeft,
  IconCircleArrowUp,
  IconCloud,
  IconDeviceLaptop,
  IconListDetails,
  IconLock,
  IconMessages,
  IconMicrophone,
  IconPlugConnected,
  IconShieldCheck,
  IconSparkles,
  IconUserCircle,
  IconUsers,
  type TablerIcon,
} from '@tabler/icons-react';
import { useStore } from '../store';
import { AccountSection } from './AccountSection';
import { GuardAllowlistSection } from './GuardAllowlistSection';
import { McpConnectionsSection } from './McpConnectionsSection';
import { useIsPhone } from '../lib/layout';
import { DevicesSection } from './DevicesSection';
import { EncryptionSection } from './EncryptionSection';
import { CollaboratorsSection } from './CollaboratorsSection';
import { NotificationsSection } from './NotificationsSection';
import { RoutingSection } from './RoutingSection';
import { SessionsSection } from './SessionsSection';
import { SyncSection } from './SyncSection';
import { TranscriptSection } from './TranscriptSection';
import { UpdatesSection } from './UpdatesSection';
import { VoiceSection } from './VoiceSection';
import { WhatsNewSection } from './WhatsNewSection';
import { DEVICE_PAIRING_ENABLED } from '../lib/storage';
import { SHARING_ENABLED } from '../lib/shares';
import { useIsGuest } from '../lib/can';

export type SettingsSection =
  | 'account'
  | 'devices'
  | 'encryption'
  | 'collaborators'
  | 'sessions'
  | 'routing'
  | 'transcript'
  | 'notifications'
  | 'allowlist'
  | 'connections'
  | 'diagnostics'
  | 'voice'
  | 'updates'
  | 'whatsNew';

interface SectionMeta {
  value: SettingsSection;
  label: string;
  /** The rail heading it sits under. Entries of one group must be adjacent. */
  group: 'Access' | 'Agent' | 'App' | 'System';
  icon: TablerIcon;
  /** The pane's subtitle — in place of an intro paragraph of its own. */
  description: string;
}

const SETTINGS_SECTIONS: SectionMeta[] = [
  {
    value: 'account',
    label: 'Account',
    group: 'Access',
    icon: IconUserCircle,
    description: 'The Claude and OpenAI accounts your sessions run on. Either one is enough.',
  },
  // Only in a hosted build. A local install talks to the bridge on this machine,
  // which is the one and only device — a list of one it cannot revoke is noise.
  ...(DEVICE_PAIRING_ENABLED
    ? [
        {
          value: 'devices' as SettingsSection,
          label: 'Machines',
          group: 'Access' as const,
          icon: IconDeviceLaptop,
          description:
            'The computers the agent runs on, yours and any shared with you. One is active at a time, and sessions live in its files.',
        },
        // Beside Machines, because enrolling a key is a property of the machine
        // this browser is pointed at — and only a hosted build has a relay in
        // the middle worth removing from the trust chain.
        {
          value: 'encryption' as SettingsSection,
          label: 'Encryption',
          group: 'Access' as const,
          icon: IconLock,
          description:
            "This browser and your machine encrypt everything between them. The relay carries the traffic but can't read it or pose as either end.",
        },
      ]
    : []),
  // Same reasoning: with no storage server there is nothing to share and nobody
  // to have shared with.
  ...(SHARING_ENABLED
    ? [
        {
          value: 'collaborators' as SettingsSection,
          label: 'Collaborators',
          group: 'Access' as const,
          icon: IconUsers,
          description:
            "People you've shared a session or machine with, kept so the share dialog can suggest them.",
        },
      ]
    : []),
  {
    value: 'sessions',
    label: 'Sessions',
    group: 'Agent',
    icon: IconMessages,
    description: 'Defaults for new sessions, and how plan mode, recovery and replies behave.',
  },
  {
    value: 'routing',
    label: 'Smart routing',
    // Not IconRoute: that one already means Workflows.
    group: 'Agent',
    icon: IconArrowsSplit,
    description:
      "Before each turn, TypeSafe's JEV picks a model and effort from the ones you allow, by your rule.",
  },
  {
    value: 'allowlist',
    label: 'Auto-mode allowlist',
    group: 'Agent',
    icon: IconShieldCheck,
    description: 'Tool calls the auto-mode guard lets through without asking. Everything else still asks.',
  },
  {
    value: 'connections',
    label: 'Connections',
    group: 'Agent',
    icon: IconPlugConnected,
    description: "MCP servers. Every enabled connection's tools are offered to every session.",
  },
  {
    value: 'transcript',
    label: 'Transcript',
    group: 'App',
    icon: IconListDetails,
    description: "How much of the agent's activity a session shows.",
  },
  {
    value: 'notifications',
    label: 'Notifications',
    group: 'App',
    icon: IconBell,
    description: 'How Lines tells you a session finished or needs you.',
  },
  {
    value: 'voice',
    label: 'Voice input',
    group: 'App',
    icon: IconMicrophone,
    description: 'Dictate prompts; whisper.cpp transcribes them on your machine.',
  },
  {
    value: 'diagnostics',
    label: 'Sync',
    group: 'System',
    icon: IconCloud,
    description:
      'Sessions, workflows and steps sync to the storage server. Local files stay the source of truth, so an outage never loses work.',
  },
  {
    value: 'updates',
    label: 'Updates',
    group: 'System',
    icon: IconCircleArrowUp,
    description: "The version of every part you're running, and the latest desktop app.",
  },
  {
    value: 'whatsNew',
    label: "What's new",
    group: 'System',
    icon: IconSparkles,
    description: 'Every update to Lines, newest first.',
  },
];

/**
 * Machines is the only pane a guest may see: it lists *their* account's machines
 * and is how they get back to one of their own. Every other pane reads or writes
 * the host's state — settings, the guard allowlist, their MCP connections, their
 * Claude account, their sync log — all of which the bridge refuses to a guest
 * anyway.
 */
const GUEST_SECTIONS = SETTINGS_SECTIONS.filter((s) => s.value === 'devices');

/**
 * `initialSection` opens straight on that pane. Without one, a phone opens on
 * the section list and a desktop on Account.
 */
export function SettingsModal({
  opened,
  onClose,
  initialSection,
}: {
  opened: boolean;
  onClose: () => void;
  initialSection?: SettingsSection;
}) {
  const openGuardReview = useStore((s) => s.openGuardReview);
  const openMcpReview = useStore((s) => s.openMcpReview);
  const guest = useIsGuest();
  const sections = guest ? GUEST_SECTIONS : SETTINGS_SECTIONS;
  const [section, setSection] = useState<SettingsSection>(initialSection ?? 'account');
  // Phone only: the list stands in for the rail, and a pane replaces it.
  const [showList, setShowList] = useState(initialSection === undefined);
  const isPhone = useIsPhone();

  // Snapshot in a ref so a guardReview that clears mid-edit cannot yank the
  // user off the allowlist pane; only an open transition picks the section.
  const initialRef = useRef(initialSection);
  initialRef.current = initialSection;
  useEffect(() => {
    if (!opened) return;
    setSection(initialRef.current ?? 'account');
    setShowList(initialRef.current === undefined);
  }, [opened]);

  // A section this user cannot see (a guest, or a local build without pairing)
  // falls back to the first one they can.
  const current = sections.find((s) => s.value === section) ?? sections[0];
  const navigable = sections.length > 1;
  const listView = isPhone && showList && navigable;
  const goTo = (value: SettingsSection) => {
    setSection(value);
    setShowList(false);
  };

  return (
    // Flex-shelled like WorkflowEditor: fixed-height nav rail + scrolling pane.
    <Modal
      opened={opened}
      onClose={onClose}
      title="Settings"
      // Full-screen on a phone: a 90%-wide modal over a 390px viewport leaves a
      // sliver of backdrop that swallows taps meant for the pane.
      fullScreen={isPhone}
      // A width rather than a share of the screen: the pane is capped at 720px,
      // so a wider modal only added empty space. Still shrinks on a narrow laptop.
      size={960}
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
      {listView ? (
        // A phone has no room for a rail beside the pane, so the rail becomes
        // the first screen: the same groups, larger targets.
        <ScrollArea style={{ flex: 1 }} type="hover" scrollbars="y" styles={{ content: { display: 'block' } }}>
          <Stack gap="lg" px="xs" py="sm">
            <SectionNav sections={sections} onSelect={goTo} comfortable />
            {!guest && (
              <Box pt="sm" style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}>
                <DocsLink onClose={onClose} comfortable />
              </Box>
            )}
          </Stack>
        </ScrollArea>
      ) : (
        <Group align="stretch" gap={0} wrap="nowrap" style={{ flex: 1, minHeight: 0 }}>
          {!isPhone && navigable && (
            <>
              <Stack gap={0} w={220} style={{ flexShrink: 0 }}>
                {/* Scrolls on its own: four groups of items outgrow a short laptop
                    screen. */}
                <ScrollArea style={{ flex: 1 }} type="hover" scrollbars="y">
                  <Box p="sm">
                    <SectionNav sections={sections} active={current.value} onSelect={goTo} />
                  </Box>
                </ScrollArea>
                {!guest && (
                  <>
                    <Divider />
                    <Box p="sm">
                      <DocsLink onClose={onClose} />
                    </Box>
                  </>
                )}
              </Stack>
              <Divider orientation="vertical" />
            </>
          )}
          {/* Keyed so a new section starts at the top. `block` content for the
              reason Transcript gives: Mantine's table wrapper grows to its widest
              nowrap row, which would push a phone pane off-screen. */}
          <ScrollArea
            key={current.value}
            style={{ flex: 1 }}
            type="hover"
            scrollbars="y"
            styles={{ content: { display: 'block' } }}
          >
            <Stack gap="lg" maw={720} px={isPhone ? 'md' : 'xl'} py={isPhone ? 'sm' : 'lg'}>
              {isPhone && navigable && (
                <Button
                  variant="subtle"
                  color="gray"
                  size="compact-sm"
                  leftSection={<IconChevronLeft size={16} />}
                  onClick={() => setShowList(true)}
                  style={{ alignSelf: 'flex-start' }}
                  ml={-6}
                >
                  Settings
                </Button>
              )}
              <PaneHeader section={current} />
              {current.value === 'account' && <AccountSection onClose={onClose} />}
              {current.value === 'devices' && <DevicesSection />}
              {current.value === 'encryption' && <EncryptionSection />}
              {current.value === 'collaborators' && <CollaboratorsSection />}
              {current.value === 'sessions' && <SessionsSection onOpenUpdates={() => goTo('updates')} />}
              {current.value === 'routing' && <RoutingSection />}
              {current.value === 'transcript' && <TranscriptSection />}
              {current.value === 'notifications' && <NotificationsSection />}
              {current.value === 'diagnostics' && <SyncSection />}
              {current.value === 'voice' && <VoiceSection />}
              {current.value === 'updates' && <UpdatesSection onOpenWhatsNew={() => goTo('whatsNew')} />}
              {current.value === 'whatsNew' && <WhatsNewSection />}
              {current.value === 'allowlist' && (
                <GuardAllowlistSection
                  onOpenReview={() => {
                    onClose();
                    openGuardReview();
                  }}
                />
              )}
              {current.value === 'connections' && (
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
      )}
    </Modal>
  );
}

function PaneHeader({ section }: { section: SectionMeta }) {
  return (
    <Stack gap={4}>
      <Title order={3} size="h5">
        {section.label}
      </Title>
      <Text size="sm" c="dimmed">
        {section.description}
      </Text>
    </Stack>
  );
}

/** Adjacent entries of one group, in order. */
function groupSections(sections: SectionMeta[]) {
  const groups: { name: SectionMeta['group']; items: SectionMeta[] }[] = [];
  for (const s of sections) {
    const last = groups[groups.length - 1];
    if (last?.name === s.group) last.items.push(s);
    else groups.push({ name: s.group, items: [s] });
  }
  return groups;
}

/**
 * The grouped section list: the desktop rail, and the phone's first screen.
 * `active` is unset on the phone list, where no pane is showing.
 */
function SectionNav({
  sections,
  active,
  onSelect,
  comfortable,
}: {
  sections: SectionMeta[];
  active?: SettingsSection;
  onSelect: (value: SettingsSection) => void;
  /** Touch-sized rows, for the phone list. */
  comfortable?: boolean;
}) {
  const guardReview = useStore((s) => s.guardReview);
  const mcpReview = useStore((s) => s.mcpReview);

  return (
    <Stack gap="md" className="lines-settings-nav">
      {groupSections(sections).map((group) => (
        <Stack key={group.name} gap={2}>
          <Text size="xs" fw={600} c="dimmed" tt="uppercase" px="sm" pb={2}>
            {group.name}
          </Text>
          {group.items.map((s) => {
            const Icon = s.icon;
            // Only the two review-bearing items carry the pending dot.
            const pending =
              (s.value === 'allowlist' && guardReview) || (s.value === 'connections' && mcpReview);
            return (
              <NavLink
                key={s.value}
                // A button, not NavLink's default anchor: an <a> with no href is
                // skipped by Tab.
                component="button"
                type="button"
                variant="light"
                color="gray"
                active={s.value === active}
                aria-current={s.value === active ? 'page' : undefined}
                noWrap
                label={s.label}
                leftSection={<Icon size={16} />}
                rightSection={pending ? <PendingDot /> : undefined}
                onClick={() => onSelect(s.value)}
                py={comfortable ? 12 : undefined}
                styles={comfortable ? { label: { fontSize: 'var(--mantine-font-size-md)' } } : undefined}
                style={{ borderRadius: 'var(--mantine-radius-sm)' }}
              />
            );
          })}
        </Stack>
      ))}
    </Stack>
  );
}

function PendingDot() {
  return (
    <>
      <Box component="span" display="block" w={6} h={6} bg="yellow" style={{ borderRadius: '50%' }} />
      <VisuallyHidden> — needs review</VisuallyHidden>
    </>
  );
}

/** Hand-off to the documentation reader — close first, like the connect and allowlist-review buttons. */
function DocsLink({ onClose, comfortable }: { onClose: () => void; comfortable?: boolean }) {
  const activeProject = useStore((s) => s.activeProject);
  const navigate = useNavigate();

  return (
    <Stack gap={2}>
      <NavLink
        component="button"
        type="button"
        variant="light"
        color="gray"
        noWrap
        label="Documentation"
        leftSection={<IconBooks size={16} />}
        rightSection={<IconArrowUpRight size={14} />}
        // NavLink's `disabled` only styles the row; a button still takes Enter,
        // hence the guard and the aria flag.
        disabled={!activeProject}
        aria-disabled={!activeProject || undefined}
        onClick={() => {
          if (!activeProject) return;
          onClose();
          navigate('/docs');
        }}
        py={comfortable ? 12 : undefined}
        styles={comfortable ? { label: { fontSize: 'var(--mantine-font-size-md)' } } : undefined}
        style={{ borderRadius: 'var(--mantine-radius-sm)' }}
      />
      {!activeProject && (
        <Text size="xs" c="dimmed" px="sm">
          Open a project to read its docs
        </Text>
      )}
    </Stack>
  );
}
