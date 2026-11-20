import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, SyntheticEvent } from 'react';
import { SESSION_NAME_MAX } from '@lines/shared';
import { useIsPhone } from '../lib/layout';
import { send } from '../ws';

/** Keeps a click, key or double-click inside the input from reaching the row link around it. */
function contain(e: SyntheticEvent) {
  e.stopPropagation();
}

/**
 * The in-place editor that replaces a session's title `Text` while it is being
 * renamed. A bare input with the title's own font, weight and line box, so
 * swapping one for the other moves nothing. Enter or blur sends `renameSession`
 * (only for a non-empty, changed name); Escape cancels. The input keeps showing
 * the typed value until the `sessionUpsert` echo renames the session — no
 * optimistic store write, same as archive and delete.
 */
export function InlineSessionName({
  sessionId,
  name,
  onDone,
  fw,
  size = 'sm',
}: {
  sessionId: string;
  name: string;
  /** Called once the edit ends, committed or cancelled. */
  onDone: () => void;
  /** The title `Text`'s weight and Mantine size, so the input matches it. */
  fw: number;
  size?: 'xs' | 'sm' | 'md';
}) {
  const [value, setValue] = useState(name);
  const ref = useRef<HTMLInputElement>(null);
  // Escape and Enter both end the edit, and the unmount blur that follows must
  // not commit a second time (or commit what Escape just threw away).
  const ended = useRef(false);
  const isPhone = useIsPhone();

  useEffect(() => {
    ref.current?.select();
  }, []);

  const finish = (commit: boolean) => {
    if (ended.current) return;
    ended.current = true;
    const next = value.replace(/\s+/g, ' ').trim();
    if (commit && next && next !== name) {
      send({ type: 'renameSession', sessionId, name: next });
    }
    onDone();
  };

  const style: CSSProperties = {
    font: 'inherit',
    fontWeight: fw,
    // Phone: below 16px iOS zooms the page on focus. The fixed height below keeps
    // the line box the title had, so the bigger glyphs do not move the layout.
    fontSize: isPhone ? 16 : `var(--mantine-font-size-${size})`,
    lineHeight: `var(--mantine-line-height-${size})`,
    height: `calc(var(--mantine-font-size-${size}) * var(--mantine-line-height-${size}))`,
    padding: 0,
    margin: 0,
    border: 0,
    outline: 'none',
    // Focus ring without a layout box: a shadow takes no space.
    boxShadow: '0 1px 0 0 var(--mantine-primary-color-filled)',
    background: 'transparent',
    color: 'inherit',
    width: '100%',
    minWidth: 0,
    flex: '1 1 auto',
  };

  return (
    <input
      ref={ref}
      autoFocus
      aria-label="Session name"
      value={value}
      maxLength={SESSION_NAME_MAX}
      onChange={(e) => setValue(e.currentTarget.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        }
      }}
      onClick={(e) => {
        // The sidebar row is a link: a click in the input must not navigate.
        e.preventDefault();
        e.stopPropagation();
      }}
      onMouseDown={contain}
      onDoubleClick={contain}
      style={style}
    />
  );
}
