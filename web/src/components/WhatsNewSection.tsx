import { Text } from '@mantine/core';
import { CHANGELOG, previouslySeen } from '../lib/whatsNew';
import { ChangelogList } from './ChangelogList';

/**
 * Every update so far, both tracks: the permanent home of what the "What's
 * new" card shows once. Releases above what this browser had seen when the page
 * loaded are marked new.
 *
 * Desktop notes committed since the last desktop release head the timeline as
 * the next release: they have no version until desktop/scripts/ship.mjs stamps
 * one.
 */
export function WhatsNewSection() {
  if (!CHANGELOG.web.length && !CHANGELOG.desktop.length && !CHANGELOG.desktopPending.length) {
    return (
      <Text size="sm" c="dimmed">
        No updates recorded yet.
      </Text>
    );
  }
  return (
    <ChangelogList
      web={CHANGELOG.web}
      desktop={CHANGELOG.desktop}
      pending={CHANGELOG.desktopPending}
      highlightSince={previouslySeen}
    />
  );
}
