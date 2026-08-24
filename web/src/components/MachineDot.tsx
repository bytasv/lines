import type { CSSProperties } from 'react';
import { Tooltip } from '@mantine/core';
import type { MachineHealth } from '../lib/machineHealth';

/**
 * Liveness dot for one machine, reusing the sidebar's `.status-dot` so a machine
 * and a session read the same way. Never pulses: a machine is not an action.
 *
 * Its own module rather than a helper inside a pane, because the connect gate
 * shows it too — and that screen must not pull the settings pane's imports in.
 */
export function MachineDot({ health }: { health: MachineHealth }) {
  return (
    <Tooltip label={health.label} openDelay={300} withArrow>
      <span
        className="status-dot"
        style={
          {
            '--status-dot-color': `var(--mantine-color-${health.color}-6)`,
          } as CSSProperties
        }
      />
    </Tooltip>
  );
}
