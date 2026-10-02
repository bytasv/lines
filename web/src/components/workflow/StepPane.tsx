import { Group, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import styles from './workflow.module.css';

/**
 * The editing pane for one step, shared by the workflow editor and the step
 * library: a header, an optional banner saying what the step is, the prompt
 * filling whatever height is left, then the settings and an optional footer.
 *
 * The prompt and the settings each scroll on their own, stacked in the column —
 * never one scroll inside another, which is what a step opened in place inside
 * a scrolling list gave.
 */
export function StepPane({
  header,
  banner,
  prompt,
  settings,
  footer,
}: {
  header: ReactNode;
  banner?: ReactNode;
  prompt: ReactNode;
  settings: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className={styles.pane}>
      <div className={styles.paneHeader}>{header}</div>
      {banner}
      <div className={styles.panePrompt}>{prompt}</div>
      <div className={styles.paneSettings}>{settings}</div>
      {footer && <div className={styles.paneFooter}>{footer}</div>}
    </div>
  );
}

/** What the open step is and where it comes from, with the actions that fit it. */
export function StepBanner({
  icon,
  children,
  actions,
}: {
  icon: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={styles.banner}>
      <span className={styles.bannerIcon}>{icon}</span>
      <Text size="xs" style={{ flex: 1, minWidth: 200 }}>
        {children}
      </Text>
      {actions && (
        <Group gap={6} wrap="wrap" justify="flex-end">
          {actions}
        </Group>
      )}
    </div>
  );
}
