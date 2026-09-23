import { Box, Text, UnstyledButton } from '@mantine/core';
import { APP_PROTOCOL_VERSION } from '@lines/shared';
import { useStore } from '../store';

/**
 * Grape pill shown when this tab and the bridge it is talking to disagree on the
 * wire contract (`protocolSkew`).
 *
 * Ranks directly below ConnectionBanner and above WorkerBanner: a client that may
 * be misreading the bridge's messages has to say so *before* it reports on that
 * bridge's health, because every health claim below it is read off the same
 * messages. All five pills share one fixed position, so exactly one may show.
 *
 * This exists because the failure it names is otherwise invisible. A hosted bundle
 * that stopped deploying kept rendering a field the bridge no longer sends, and the
 * session view threw inside ErrorBoundary with no hint that the two halves were ten
 * days apart — `protocolSkew` was already computed, but its only consumer was a
 * `console.warn` nobody reads. A stale bundle cannot render this banner (it does not
 * contain it), so this protects the *next* skew, not the one that prompted it.
 */
export function SkewBanner({ headerHeight }: { headerHeight: number }) {
  const skew = useStore((s) => s.protocolSkew);
  const bridge = useStore((s) => s.bridge);
  const connection = useStore((s) => s.connectionStatus);
  // Same pair ConnectionBanner reads: with the machine gone it shows the red pill
  // even though the link itself is 'connected', and that outranks this.
  const machineOffline = useStore((s) => s.machineOffline);
  const bootstrapped = useStore((s) => s.bootstrapped);
  if (connection !== 'connected' || (machineOffline && bootstrapped)) return null;
  if (!skew) return null;

  // Absent `bridge` is a bridge from before the field existed, so it is the older
  // half by definition.
  const tabIsOlder = bridge != null && bridge.appProtocol > APP_PROTOCOL_VERSION;

  return (
    <Box
      style={{
        position: 'fixed',
        top: `calc(var(--lines-safe-top) + ${headerHeight / 2}px)`,
        left: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: 200,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: 'var(--mantine-color-grape-filled)',
        color: 'var(--mantine-color-white)',
        borderRadius: 'var(--mantine-radius-xl)',
        padding: '4px 14px',
        boxShadow: 'var(--mantine-shadow-sm)',
        whiteSpace: 'nowrap',
        maxWidth: '80vw',
      }}
    >
      <Text size="sm" fw={500}>
        {tabIsOlder
          ? 'This tab is running an older version of Lines than the machine it’s connected to.'
          : 'The machine you’re connected to is running an older version of Lines than this tab.'}
      </Text>
      {/* Only offered for the half a reload can actually fix. A machine behind this
          tab needs its desktop app updated, and a button that reloads into the same
          mismatch would read as broken. */}
      {tabIsOlder && (
        <UnstyledButton
          onClick={() => window.location.reload()}
          style={{ color: 'inherit', textDecoration: 'underline', fontSize: 'var(--mantine-font-size-sm)' }}
        >
          Reload
        </UnstyledButton>
      )}
    </Box>
  );
}
