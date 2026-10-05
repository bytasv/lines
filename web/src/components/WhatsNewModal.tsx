import { useEffect, useId, useState } from 'react';
import { Modal } from '@mantine/core';
import { useStore } from '../store';
import { desktopUpdateNews, markSeen, type WhatsNew as News } from '../lib/whatsNew';
import { WhatsNewPanel } from './WhatsNew';

/**
 * The "What's new" notes for an update that arrived mid-session: the desktop
 * app relaunched its bridge and this tab reconnected without a splash, so
 * there is no boot card to show them on. The same panel as the card, on a
 * modal's surface.
 */
export function WhatsNewModal({ news, onClose }: { news: News | null; onClose: () => void }) {
  const titleId = useId();
  return (
    <Modal.Root opened={news !== null} onClose={onClose} size={460} radius="lg" centered>
      <Modal.Overlay />
      <Modal.Content aria-labelledby={titleId}>
        <Modal.Body p={0}>
          {news && (
            <WhatsNewPanel
              news={news}
              titleId={titleId}
              subtitle="Your desktop app just updated"
              listMaxHeight="min(420px, calc(100dvh - 260px))"
              onClose={onClose}
            />
          )}
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}

/**
 * Watches the bridge's version for a desktop update mid-session and opens the
 * modal with its notes. The version boot already judged (and the card showed)
 * is skipped, as is a guest, for whom the host's desktop app is not theirs.
 */
export function DesktopUpdateWhatsNew() {
  const version = useStore((s) => s.bridge?.version ?? null);
  const guest = useStore((s) => s.access !== null);
  const [shown, setShown] = useState<{ news: News; version: string } | null>(null);
  useEffect(() => {
    if (!version || guest) return;
    const desktop = desktopUpdateNews(version);
    if (desktop.length) setShown({ news: { web: [], desktop }, version });
  }, [version, guest]);

  return (
    <WhatsNewModal
      news={shown?.news ?? null}
      onClose={() => {
        if (shown) markSeen(shown.version);
        setShown(null);
      }}
    />
  );
}
