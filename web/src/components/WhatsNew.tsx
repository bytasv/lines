import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Box, Button, Group, Paper, ScrollArea, Text, Title } from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';
import type { WhatsNew as News } from '../lib/whatsNew';
import { ChangelogList } from './ChangelogList';

/** "3 updates since you last opened Lines". */
export function updatesSinceLastVisit(news: News): string {
  const count = news.web.length + news.desktop.length;
  return `${count === 1 ? '1 update' : `${count} updates`} since you last opened Lines`;
}

/**
 * The notes themselves, framed: heading, the timeline (scrolling inside, with a
 * fade at whichever edge has more), and Continue. Shared by the boot card and
 * the mid-session modal so both read the same; each supplies the surface.
 */
export function WhatsNewPanel({
  news,
  titleId,
  subtitle,
  listMaxHeight,
  onClose,
}: {
  news: News;
  /** For the surface's `aria-labelledby`. */
  titleId: string;
  subtitle: string;
  listMaxHeight: string;
  onClose: () => void;
}) {
  return (
    <Box className="lines-whats-new">
      <Box px="lg" pt="lg" pb={4}>
        <Title order={4} id={titleId}>
          What's new in Lines
        </Title>
        <Text size="sm" c="dimmed" mt={2}>
          {subtitle}
        </Text>
      </Box>
      <FadeScroll maxHeight={listMaxHeight}>
        <Box px="lg" pt="md" pb="lg">
          <ChangelogList web={news.web} desktop={news.desktop} />
        </Box>
      </FadeScroll>
      <Group className="lines-whats-new-footer" justify="space-between" wrap="nowrap" gap="md" px="lg" py="sm">
        <Text size="xs" c="dimmed">
          Every update stays in Settings → What's new.
        </Text>
        <Button size="sm" onClick={onClose} rightSection={<IconArrowRight size={14} />} style={{ flexShrink: 0 }}>
          Continue
        </Button>
      </Group>
    </Box>
  );
}

/** A scroll area that fades out at an edge with more beyond it. The fades are `.lines-fade-scroll` in index.css. */
function FadeScroll({ maxHeight, children }: { maxHeight: string; children: ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ top: false, bottom: false });
  const measure = useCallback(() => {
    const el = viewport.current;
    if (!el) return;
    const top = el.scrollTop > 1;
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    setFade((was) => (was.top === top && was.bottom === bottom ? was : { top, bottom }));
  }, []);
  useLayoutEffect(measure);
  return (
    <ScrollArea.Autosize
      mah={maxHeight}
      type="hover"
      scrollbarSize={6}
      viewportRef={viewport}
      onScrollPositionChange={measure}
      className="lines-fade-scroll"
      data-fade-top={fade.top || undefined}
      data-fade-bottom={fade.bottom || undefined}
      classNames={{ viewport: 'lines-fade-scroll-viewport' }}
    >
      {children}
    </ScrollArea.Autosize>
  );
}

/**
 * The "What's new" card shown in the boot splash's slot, under the finished
 * mark, with the app mounted unseen beneath it (lib/splash.ts `holdApp`).
 * Closing it starts the splash's usual hand-over to the app.
 *
 * While it shows, the splash centres the mark and the card as one group and
 * glides them into place. The layer clips outside `shown`, so the card is
 * capped to what fits on screen with the mark and the notes scroll inside it.
 */
export function WhatsNew({ news, onClose }: { news: News; onClose: () => void }) {
  const card = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Focus lands on the card, not Continue: an autofocused button wears its focus
  // ring on a page nobody has touched yet. Enter and Esc close it from anywhere,
  // and Enter's default is suppressed so a focused Continue does not close it twice.
  useEffect(() => {
    card.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <Paper
      ref={card}
      className="lines-splash-panel lines-whats-new-card"
      withBorder
      shadow="md"
      radius="lg"
      mt={28}
      mx="auto"
      maw={460}
      role="dialog"
      aria-labelledby={titleId}
      tabIndex={-1}
    >
      <WhatsNewPanel
        news={news}
        titleId={titleId}
        subtitle={updatesSinceLastVisit(news)}
        listMaxHeight="min(400px, max(120px, calc(100dvh - 360px)))"
        onClose={onClose}
      />
    </Paper>
  );
}
