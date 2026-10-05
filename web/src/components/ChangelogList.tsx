import type { ReactNode } from 'react';
import { Badge, Text } from '@mantine/core';
import { IconBrowser, IconDeviceDesktop, IconHourglassLow, type TablerIcon } from '@tabler/icons-react';
import { compareVersions, type ChangelogRelease } from '@lines/shared';

type Track = 'web' | 'desktop';

const TRACKS: Record<Track, { label: string; icon: TablerIcon }> = {
  web: { label: 'Web app', icon: IconBrowser },
  desktop: { label: 'Desktop app', icon: IconDeviceDesktop },
};

/**
 * `YYYY-MM-DD` as "Oct 5", with the year only when it is not this one. Read as
 * a local date: `new Date('2026-10-05')` is UTC midnight, which is still the 4th
 * anywhere west of Greenwich.
 */
export function formatReleaseDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  if (!year || !month || !day) return date;
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: year === new Date().getFullYear() ? undefined : 'numeric',
  });
}

/**
 * Releases of both tracks on one timeline, newest date first: what the "What's
 * new" card and modal show, and the whole history in Settings. The look is
 * `.lines-changelog` in index.css.
 *
 * `pending` heads the timeline as the next desktop release, dashed because it
 * has no version yet. `highlightSince` marks the releases above each track's
 * version as new; a null version marks nothing on that track.
 */
export function ChangelogList({
  web,
  desktop,
  pending,
  highlightSince,
}: {
  web: ChangelogRelease[];
  desktop: ChangelogRelease[];
  pending?: string[];
  highlightSince?: Record<Track, string | null>;
}) {
  const releases = [
    ...web.map((release) => ({ track: 'web' as const, release })),
    ...desktop.map((release) => ({ track: 'desktop' as const, release })),
  ].sort((a, b) => b.release.date.localeCompare(a.release.date));

  return (
    <ol className="lines-changelog">
      {pending && pending.length > 0 && (
        <Entry icon={IconHourglassLow} title="Next desktop release" items={pending} pending>
          <Badge variant="default" radius="sm">
            Upcoming
          </Badge>
        </Entry>
      )}
      {releases.map(({ track, release }) => {
        const since = highlightSince?.[track] ?? null;
        return (
          <Entry
            key={`${track}-${release.version}`}
            icon={TRACKS[track].icon}
            title={TRACKS[track].label}
            version={release.version}
            date={release.date}
            items={release.items}
          >
            {since !== null && compareVersions(release.version, since) > 0 && (
              <Badge variant="light" color="indigo" radius="sm">
                New
              </Badge>
            )}
          </Entry>
        );
      })}
    </ol>
  );
}

function Entry({
  icon: Icon,
  title,
  version,
  date,
  items,
  pending,
  children,
}: {
  icon: TablerIcon;
  title: string;
  version?: string;
  date?: string;
  items: string[];
  pending?: boolean;
  /** Badges after the version. */
  children?: ReactNode;
}) {
  return (
    <li className="lines-changelog-entry" data-pending={pending || undefined}>
      <span className="lines-changelog-node" aria-hidden>
        <Icon size={12} stroke={1.75} />
      </span>
      <div className="lines-changelog-head">
        <Text component="span" size="sm" fw={600}>
          {title}
        </Text>
        {version && (
          <Text component="span" size="xs" c="dimmed" ff="monospace">
            {version}
          </Text>
        )}
        {children}
        {date && (
          <Text component="time" dateTime={date} size="xs" c="dimmed" className="lines-changelog-date">
            {formatReleaseDate(date)}
          </Text>
        )}
      </div>
      <ul className="lines-changelog-items">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </li>
  );
}
