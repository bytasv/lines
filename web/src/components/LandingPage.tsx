import {
  Badge,
  Box,
  Button,
  Card,
  Container,
  Divider,
  Group,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { SignInButton, SignUpButton } from '@clerk/clerk-react';
import {
  IconAdjustmentsHorizontal,
  IconBolt,
  IconBook2,
  IconBrain,
  IconCloud,
  IconCoin,
  IconDeviceDesktop,
  IconFolders,
  IconGauge,
  IconGitCompare,
  IconRepeat,
  IconShieldCheck,
  IconStack2,
  IconTerminal2,
} from '@tabler/icons-react';
import { BrandMark } from './BrandMark';

type Feature = {
  icon: typeof IconBolt;
  title: string;
  description: string;
};

const FEATURES: Feature[] = [
  {
    icon: IconBolt,
    title: 'Parallel sessions, live',
    description:
      'Run several Claude sessions at once, one per project directory, with token-level streaming into a markdown transcript and live status badges.',
  },
  {
    icon: IconGitCompare,
    title: 'Diffs you can actually read',
    description:
      'Every Edit/Write/MultiEdit shows +N/−N stats and zooms into a full-screen Monaco diff editor with faithful pre-edit snapshots — no raw JSON tool dumps.',
  },
  {
    icon: IconShieldCheck,
    title: 'Permissions stay yours',
    description:
      'Every tool call can pause for Allow/Deny. Pre-approve safe patterns with a synced allowlist; plan review and questions always still ask.',
  },
  {
    icon: IconStack2,
    title: 'Multi-step workflows',
    description:
      'Chain steps like Plan → Implement → Tests → Review, each with its own prompt template, model, and permission mode. Stuck steps recover in one click.',
  },
  {
    icon: IconBook2,
    title: 'A shareable recipe library',
    description:
      'Publish versioned prompts with tags and screenshots, browse what others published, and run one alone or bundle several into a synthesized workflow.',
  },
  {
    icon: IconAdjustmentsHorizontal,
    title: 'Model & mode control',
    description:
      'Switch models and Agent / Accept-edits / Plan / Bypass mid-session, per session or per workflow step, without losing context.',
  },
  {
    icon: IconCoin,
    title: 'Know what it costs',
    description:
      'A plan-usage chip, per-session cost and tokens, spend-by-model, and per-step cost in the workflow stepper — spend visibility everywhere you look.',
  },
  {
    icon: IconGauge,
    title: 'Context under control',
    description:
      'A live context-occupancy ring shows what is filling the window, warns near the limit, and compacts on demand instead of hitting a wall mid-turn.',
  },
  {
    icon: IconFolders,
    title: 'Multi-root, multi-repo',
    description:
      'One project tab spans several folders; commit steps group changes by git work tree so a multi-repo change lands as separate, correct commits.',
  },
  {
    icon: IconRepeat,
    title: 'Turns that recover themselves',
    description:
      'A crashed query, a dead token, or an app restart mid-turn gets a one-click Retry or an auto-resume banner instead of a dead session.',
  },
  {
    icon: IconBrain,
    title: 'Memory that follows you',
    description:
      'Your ~/.claude agent memory — global CLAUDE.md and per-project auto-memory — syncs across every machine you pair.',
  },
  {
    icon: IconCloud,
    title: 'Outbound-only, no exposure',
    description:
      'The hosted app never opens a port on your machine — your bridge dials out to the relay, so there is nothing to forward, no NAT, no dynamic DNS.',
  },
];

type Mode = {
  icon: typeof IconTerminal2;
  title: string;
  where: string;
  description: string;
};

const MODES: Mode[] = [
  {
    icon: IconTerminal2,
    title: 'Local dev',
    where: 'runs on your machine',
    description: 'Clone the repo, npm install, npm run dev. Full control, own your data.',
  },
  {
    icon: IconDeviceDesktop,
    title: 'Desktop app',
    where: 'runs on your machine',
    description: 'A menu-bar app that supervises the agent for you — no terminal required.',
  },
  {
    icon: IconCloud,
    title: 'Hosted',
    where: 'agent still runs on a machine you pair',
    description:
      'Sign in from any browser. This site only relays and stores metadata — your code, your git, your Claude login never leave your machine.',
  },
];

/**
 * Marketing landing page shown on SignedOut instead of an immediate redirect to
 * Clerk's hosted sign-in. Kept in this file (not a separate static site) so it
 * shares the app's theme, brand assets, and Clerk instance instead of drifting
 * from a second copy.
 */
export function LandingPage() {
  return (
    <Box style={{ minHeight: '100vh', overflowY: 'auto' }}>
      <Box
        component="header"
        h={56}
        px="md"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid var(--mantine-color-default-border)',
          position: 'sticky',
          top: 0,
          background: 'var(--mantine-color-body)',
          zIndex: 1,
        }}
      >
        <BrandMark />
        <SignInButton mode="modal">
          <Button variant="subtle">Sign in</Button>
        </SignInButton>
      </Box>

      <Container size="lg" py={80}>
        <Stack align="center" gap="lg" ta="center" mb={96}>
          <Badge variant="light" size="lg" radius="sm">
            Built on the Claude Agent SDK
          </Badge>
          <Title order={1} fz={{ base: 32, sm: 48 }} maw={720} lh={1.15}>
            Run Claude Code from anywhere. Your machine still does the work.
          </Title>
          <Text size="lg" c="dimmed" maw={620}>
            Lines is a web GUI for Claude Code: parallel sessions, live streaming, inline
            diffs, multi-step workflows, and a shareable prompt library — while every
            agent turn executes on your own filesystem, your own git, your own Claude
            login.
          </Text>
          <Group>
            <SignUpButton mode="modal">
              <Button size="md">Get started</Button>
            </SignUpButton>
            <SignInButton mode="modal">
              <Button size="md" variant="default">
                Sign in
              </Button>
            </SignInButton>
          </Group>
        </Stack>

        <Stack gap="xl" mb={96}>
          <Stack gap={4} ta="center">
            <Title order={2} fz={26}>
              Three ways to run it
            </Title>
            <Text c="dimmed">Same app, same features — pick where the agent lives.</Text>
          </Stack>
          <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="lg">
            {MODES.map((mode) => (
              <Card key={mode.title} withBorder radius="md" p="lg">
                <Stack gap="sm">
                  <ThemeIcon variant="light" size={40} radius="md">
                    <mode.icon size={22} stroke={1.5} />
                  </ThemeIcon>
                  <Stack gap={2}>
                    <Text fw={600}>{mode.title}</Text>
                    <Text size="xs" c="dimmed" fs="italic">
                      {mode.where}
                    </Text>
                  </Stack>
                  <Text size="sm" c="dimmed">
                    {mode.description}
                  </Text>
                </Stack>
              </Card>
            ))}
          </SimpleGrid>
        </Stack>

        <Divider mb={96} />

        <Stack gap="xl" mb={96}>
          <Stack gap={4} ta="center">
            <Title order={2} fz={26}>
              Everything a long agent session needs
            </Title>
            <Text c="dimmed" maw={560} mx="auto">
              Not just a chat window — the tooling to run Claude Code for real work, at scale,
              without losing track of cost, context, or control.
            </Text>
          </Stack>
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="lg">
            {FEATURES.map((feature) => (
              <Card key={feature.title} withBorder radius="md" p="lg" h="100%">
                <Stack gap="sm">
                  <ThemeIcon variant="light" size={36} radius="md">
                    <feature.icon size={20} stroke={1.5} />
                  </ThemeIcon>
                  <Text fw={600}>{feature.title}</Text>
                  <Text size="sm" c="dimmed">
                    {feature.description}
                  </Text>
                </Stack>
              </Card>
            ))}
          </SimpleGrid>
        </Stack>

        <Card withBorder radius="md" p="xl">
          <Stack align="center" gap="sm" ta="center">
            <Title order={3}>Your code never has to leave your machine.</Title>
            <Text c="dimmed" maw={560}>
              Sign in, pair a machine, and start a session — or run Lines entirely locally
              with nothing hosted at all.
            </Text>
            <SignUpButton mode="modal">
              <Button size="md" mt="xs">
                Get started
              </Button>
            </SignUpButton>
          </Stack>
        </Card>
      </Container>
    </Box>
  );
}
