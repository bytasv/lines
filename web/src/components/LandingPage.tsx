import {
  Anchor,
  Box,
  Button,
  Container,
  Group,
  SimpleGrid,
  Stack,
  Text,
  Title,
  VisuallyHidden,
} from '@mantine/core';
import { SignedIn, SignedOut, SignInButton, SignUpButton } from '@clerk/clerk-react';
import type { ComponentType, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { IconArrowRight, IconBrandGithub, IconCheck } from '@tabler/icons-react';
import { AgentRotator, type RotatorWord } from './AgentRotator';
import { BrandMark } from './BrandMark';
import { DownloadDesktopApp } from './DownloadDesktopApp';
import { ANTHROPIC_CLAY } from './ProviderMark';
import {
  AnywhereArt,
  AutomateArt,
  ControlArt,
  ParallelSessionsArt,
  ReviewArt,
} from './landing/FeatureArt';
import { DesktopAppArt, HostedArt, LocalDevArt } from './landing/RunModeArt';
import { EncryptionArt, LocalOnlyArt, OpenSourceArt, OutboundArt } from './landing/SecurityArt';
import { InstallArt, PairArt, RunArt } from './landing/StepArt';
import classes from './LandingPage.module.css';

const REPO_URL = 'https://github.com/bytasv/lines';
// Supported agent CLIs, in the order the hero cycles through them. Adding a
// provider to the landing copy is one entry here. `gradient` is the hero word's,
// in the vendor's own palette, as ProviderMark draws their marks: tints and
// shades of Anthropic's clay, and OpenAI's monochrome — text colour with a grey
// sheen through the middle, which inverts with the theme.
const AGENTS: (RotatorWord & { setupUrl: string })[] = [
  {
    name: 'Claude Code',
    setupUrl: 'https://docs.claude.com/en/docs/claude-code/setup',
    gradient: [
      `color-mix(in oklab, ${ANTHROPIC_CLAY} 78%, white)`,
      ANTHROPIC_CLAY,
      `color-mix(in oklab, ${ANTHROPIC_CLAY} 80%, black)`,
    ],
  },
  {
    name: 'Codex',
    setupUrl: 'https://github.com/openai/codex',
    gradient: ['var(--mantine-color-text)', 'var(--mantine-color-dimmed)', 'var(--mantine-color-text)'],
  },
];

type FeatureGroup = {
  art: ComponentType;
  eyebrow: string;
  title: string;
  blurb: string;
  items: string[];
};

// Each group summarises a set of shipped features (docs/codebase/features). Keep
// the caveats: model switching hands over a summary, not the full context; the
// phone app is a web app, not a native one; one machine is active at a time.
const GROUPS: FeatureGroup[] = [
  {
    art: ParallelSessionsArt,
    eyebrow: 'Run agents',
    title: 'Parallel sessions, live',
    blurb:
      'Claude Code and Codex sessions side by side, streaming token by token into a readable transcript.',
    items: [
      'Background subagents and commands you can see and stop',
      '“Send now” drops a message into the turn that is already running',
      'A dead turn gets one-click Retry or resumes on its own',
    ],
  },
  {
    art: AutomateArt,
    eyebrow: 'Automate',
    title: 'Workflows and recipes',
    blurb: 'Chain versioned steps into multi-step workflows, or start from the recipe library.',
    items: [
      'MCP connections with OAuth in Settings → Connections',
      'Ask the agent to edit your workflows, with approval for every edit',
      '@ mentions, an in-app docs reader and Cmd/Ctrl+P',
    ],
  },
  {
    art: ControlArt,
    eyebrow: 'Control',
    title: 'You decide what runs',
    blurb: 'Tool calls pause for Allow or Deny, and plans wait for your review.',
    items: [
      'A synced allowlist for the safe stuff',
      'Model picker and reasoning effort per session',
      'Cost, usage and a context ring with compaction',
      'Switch between Claude and OpenAI with a summarized hand-off',
    ],
  },
  {
    art: ReviewArt,
    eyebrow: 'Review',
    title: 'Every change, readable',
    blurb:
      'Diffs instead of raw tool dumps, and a single view of everything a session has changed so far.',
    items: [
      'Optional git worktree and branch per session',
      'Multi-root projects with per-repo commits',
      'Rewind to an earlier prompt, edit it and send again',
    ],
  },
  {
    art: AnywhereArt,
    eyebrow: 'From anywhere',
    title: 'Your desk, in your pocket',
    blurb:
      'A phone-ready web app you can add to your home screen, with optional push alerts (iOS 16.4+ from the home screen).',
    items: [
      'Voice dictation with whisper running on your own machine',
      'Switch between paired machines, one at a time',
      'Invite others into a live session to view, prompt or collaborate',
      'Claude memory syncs across machines, and you approve incoming changes',
    ],
  },
];

const SECURITY = [
  {
    art: OutboundArt,
    title: 'Outbound only',
    description:
      'The bridge on your machine dials out to the relay. No open port, no forwarding, no dynamic DNS.',
  },
  {
    art: LocalOnlyArt,
    title: 'Runs on your machine',
    description:
      'The agent, your code, your git and your agent logins stay local. Every turn executes there.',
  },
  {
    art: EncryptionArt,
    title: 'End-to-end encrypted by default',
    description:
      'Every browser enrols with a one-time code from your machine; the relay carries traffic it can’t read or forge.',
  },
  {
    art: OpenSourceArt,
    title: 'Open source',
    description: 'Licensed under AGPL-3.0. Read every line that touches your machine.',
  },
];

const HOW_IT_WORKS = [
  {
    art: InstallArt,
    title: 'Install the desktop app',
    description: 'It runs the bridge that supervises your agent.',
  },
  {
    art: PairArt,
    title: 'Pair the machine',
    description: 'Sign in and link it to your account in one step.',
  },
  {
    art: RunArt,
    title: 'Run from any browser',
    description: 'Start sessions from your laptop or your phone.',
  },
];

type Mode = {
  art: ComponentType;
  title: string;
  where: string;
  description: string;
};

const MODES: Mode[] = [
  {
    art: LocalDevArt,
    title: 'Local dev',
    where: 'runs on your machine',
    description: 'Clone the repo, npm install, npm run dev. Full control, own your data.',
  },
  {
    art: DesktopAppArt,
    title: 'Mac app (Apple Silicon)',
    where: 'runs on your machine',
    description: 'A menu-bar app that supervises the agent for you, no terminal required.',
  },
  {
    art: HostedArt,
    title: 'Hosted',
    where: 'agent still runs on a machine you pair',
    description:
      'Sign in from any browser. This site only relays and stores metadata; your code, git and agent logins stay on your machine.',
  },
];

function SectionHeading({ eyebrow, title, blurb }: { eyebrow: string; title: string; blurb?: string }) {
  return (
    <Stack gap={8} ta="center" maw={620} mx="auto">
      <Text className={classes.eyebrow}>{eyebrow}</Text>
      {/* Balanced, so a title that does wrap on a phone splits into two even
          lines instead of stranding its last word on a line of its own. */}
      <Title order={2} fz={{ base: 28, sm: 36 }} lts="-0.02em" lh={1.15} textWrap="balance">
        {title}
      </Title>
      {blurb && <Text c="dimmed">{blurb}</Text>}
    </Stack>
  );
}

/** A card with one of the landing drawings on a dotted canvas above its text.
 *  Every illustrated section uses it, so the cards line up across the page. */
function ArtCard({
  art: Drawing,
  className,
  children,
}: {
  art: ComponentType;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={[classes.panel, classes.artCard, className].filter(Boolean).join(' ')}>
      <div className={classes.artCanvas}>
        <Drawing />
      </div>
      <div className={classes.artBody}>{children}</div>
    </div>
  );
}

function GetStartedButtons() {
  return (
    <Group justify="center">
      <SignUpButton mode="modal">
        <Button size="lg" rightSection={<IconArrowRight size={18} />}>
          Get started
        </Button>
      </SignUpButton>
      <SignInButton mode="modal">
        <Button size="lg" variant="outline">
          Sign in
        </Button>
      </SignInButton>
    </Group>
  );
}

/**
 * Marketing landing page shown on SignedOut instead of an immediate redirect to
 * Clerk's hosted sign-in. Kept in this file (not a separate static site) so it
 * shares the app's theme, brand assets, and Clerk instance instead of drifting
 * from a second copy.
 */
export function LandingPage() {
  return (
    <Box className={`lines-safe-top ${classes.page}`} style={{ minHeight: 'var(--lines-viewport)' }}>
      <Box component="header" className={classes.header}>
        <div className={classes.headerBrand}>
          <BrandMark />
        </div>
        <Group gap="lg" visibleFrom="sm" className={classes.headerNav}>
          <a className={classes.navLink} href="#features">
            Features
          </a>
          <a className={classes.navLink} href="#security">
            Security
          </a>
          <a className={classes.navLink} href="#get-started">
            Get started
          </a>
        </Group>
        {/* This page also renders at /welcome for an already-signed-in visitor,
            so the header action has to work in both states. */}
        <div className={classes.headerAction}>
          <SignedIn>
            <Button component={Link} to="/" variant="default" size="sm">
              Open app
            </Button>
          </SignedIn>
          <SignedOut>
            <SignInButton mode="modal">
              <Button variant="default" size="sm">
                Sign in
              </Button>
            </SignInButton>
          </SignedOut>
        </div>
      </Box>

      <Box component="section" className={classes.hero}>
        <Container size="lg" pt={{ base: 64, sm: 112 }} pb={{ base: 64, sm: 96 }}>
          <Stack align="center" gap="xl" ta="center">
            <span className={classes.pill}>
              <span className={classes.pillDot} />
              Works with Claude Code and Codex
            </span>
            <Title order={1} fz={{ base: 40, sm: 64 }} lts="-0.03em" lh={1.05} maw={880}>
              <VisuallyHidden>
                Your machine does the work. Run it from anywhere with{' '}
                {AGENTS.map((agent) => agent.name).join(' or ')}.
              </VisuallyHidden>
              {/* The rotating word gets a line of its own: each word centres itself,
                  so a short one leaves no gap and a long one never re-wraps the
                  text around it. */}
              <span aria-hidden="true">
                <span style={{ display: 'block' }}>Your machine does the work.</span>
                Run it from anywhere with
                <AgentRotator words={AGENTS} />
              </span>
            </Title>
            <Text size="lg" c="dimmed" maw={640}>
              Lines is a web GUI for coding agents: parallel sessions, readable diffs, multi-step
              workflows and a recipe library, while every agent turn runs on your own filesystem,
              your own git and your own agent login.
            </Text>
            <GetStartedButtons />
          </Stack>
        </Container>
      </Box>

      <Container size="lg" pb={96}>
        <Stack gap={120}>
          <Stack gap="xl" className={classes.reveal}>
            <SectionHeading
              eyebrow="How it works"
              title="Your machine, from any browser"
              blurb="The browser is only a window. The agent runs where your code already lives."
            />
            {/* Three across only from md, like "Three ways to run it": narrower, and
                the drawings' own labels shrink past reading. */}
            <SimpleGrid cols={{ base: 1, md: 3 }} spacing="md">
              {HOW_IT_WORKS.map((step, i) => (
                <ArtCard key={step.title} art={step.art}>
                  <Group gap="sm" wrap="nowrap" align="flex-start">
                    <span className={classes.stepNum}>{i + 1}</span>
                    <Stack gap={2}>
                      <Text fw={600}>{step.title}</Text>
                      <Text size="sm" c="dimmed">
                        {step.description}
                      </Text>
                    </Stack>
                  </Group>
                </ArtCard>
              ))}
            </SimpleGrid>
          </Stack>

          <Stack gap="xl" id="features" className={classes.section}>
            <SectionHeading
              eyebrow="Features"
              title="Everything a long agent session needs"
              blurb="Not just a chat window: the tooling to run coding agents on real work without losing track of cost, context or control."
            />
            <div className={classes.bento}>
              {GROUPS.map((group) => (
                <ArtCard key={group.title} art={group.art} className={`${classes.tile} ${classes.reveal}`}>
                  <Stack gap="md">
                    <Stack gap={6}>
                      <Text className={classes.eyebrow}>{group.eyebrow}</Text>
                      <Text fw={600} fz="xl" lts="-0.01em">
                        {group.title}
                      </Text>
                      <Text size="sm" c="dimmed">
                        {group.blurb}
                      </Text>
                    </Stack>
                    <ul className={classes.items}>
                      {group.items.map((item) => (
                        <li key={item}>
                          <IconCheck size={14} stroke={2} />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </Stack>
                </ArtCard>
              ))}
            </div>
          </Stack>

          <Stack gap="xl" id="security" className={`${classes.section} ${classes.reveal}`}>
            <SectionHeading
              eyebrow="Security"
              title="Your code never has to leave your machine"
              blurb="The hosted app relays and stores metadata. Everything that matters runs on hardware you own."
            />
            {/* Two by two, not four across: at a quarter of the row the drawings'
                labels would be too small to read. */}
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
              {SECURITY.map((point) => (
                <ArtCard key={point.title} art={point.art}>
                  <Stack gap={4}>
                    <Text fw={600}>{point.title}</Text>
                    <Text size="sm" c="dimmed">
                      {point.description}
                    </Text>
                  </Stack>
                </ArtCard>
              ))}
            </SimpleGrid>
            <Group justify="center">
              <Anchor href={REPO_URL} target="_blank" rel="noreferrer" size="sm" c="dimmed">
                <Group gap={6} component="span">
                  <IconBrandGithub size={16} stroke={1.5} />
                  View the source on GitHub
                </Group>
              </Anchor>
            </Group>
          </Stack>

          <Stack gap="xl" className={classes.reveal}>
            <SectionHeading
              eyebrow="Deploy"
              title="Three ways to run it"
              blurb="Same app, same features. Pick where the agent lives."
            />
            {/* Three across only from md: at sm widths a third of the row shrinks the
                drawings' own labels to an unreadable size. */}
            <SimpleGrid cols={{ base: 1, md: 3 }} spacing="md">
              {MODES.map((mode) => (
                <ArtCard key={mode.title} art={mode.art}>
                  <Stack gap={4}>
                    <Text fw={600}>{mode.title}</Text>
                    <Text size="xs" c="dimmed">
                      {mode.where}
                    </Text>
                    <Text size="sm" c="dimmed" mt={4}>
                      {mode.description}
                    </Text>
                  </Stack>
                </ArtCard>
              ))}
            </SimpleGrid>
          </Stack>

          {/* DownloadDesktopApp is env-gated and touches no authed API, so it is
              safe before sign-in; it renders null when no build is published. */}
          <Stack gap="xl" id="get-started" className={classes.section}>
            <SectionHeading
              eyebrow="Get started"
              title="Up and running in minutes"
              blurb="Install the desktop app, sign in, and pair the machine it is running on. That machine is where every agent turn executes. Install the agent CLI separately."
            />
            <DownloadDesktopApp />
            <Box className={`${classes.panel} ${classes.hero}`} p={{ base: 'xl', sm: 64 }}>
              <Stack align="center" gap="lg" ta="center">
                <Title order={3} fz={{ base: 26, sm: 34 }} lts="-0.02em" lh={1.15}>
                  Run your agents from anywhere.
                </Title>
                <Text c="dimmed" maw={520}>
                  Sign in, pair a machine and start a session, or run Lines entirely locally with
                  nothing hosted at all.
                </Text>
                <GetStartedButtons />
              </Stack>
            </Box>
          </Stack>
        </Stack>
      </Container>

      <Box component="footer" style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}>
        <Container size="lg" py="xl">
          <Stack gap="sm" align="center" ta="center">
            <Group justify="center" gap="lg">
              <Anchor href={REPO_URL} target="_blank" rel="noreferrer" size="sm" c="dimmed">
                Source on GitHub
              </Anchor>
              <Anchor href={`${REPO_URL}#readme`} target="_blank" rel="noreferrer" size="sm" c="dimmed">
                README
              </Anchor>
              {AGENTS.map((agent) => (
                <Anchor
                  key={agent.name}
                  href={agent.setupUrl}
                  target="_blank"
                  rel="noreferrer"
                  size="sm"
                  c="dimmed"
                >
                  Install {agent.name}
                </Anchor>
              ))}
            </Group>
            <Text size="sm" c="dimmed">
              Prefer to run the whole thing yourself? The relay, storage and web app are all in
              the repo; start with{' '}
              <Anchor href={`${REPO_URL}#readme`} target="_blank" rel="noreferrer" size="sm">
                the README
              </Anchor>
              .
            </Text>
          </Stack>
        </Container>
      </Box>
    </Box>
  );
}
