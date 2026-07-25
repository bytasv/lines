import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Box, Popover, Textarea } from '@mantine/core';
import {
  diffEdit,
  findMentionToken,
  mentionKindMeta,
  remapRanges,
  type MentionCandidate,
  type MentionRange,
  type MentionValue,
} from '../lib/mentions';
import { MentionDropdown, useMentionSearch } from './MentionAutocomplete';

/**
 * Text metrics the mirror must match for pill boxes to land under their glyphs.
 * Copied from the live textarea (theme/zoom/font changes included) rather than
 * hardcoded.
 */
const MIRROR_STYLES = [
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-variant',
  'letter-spacing',
  'line-height',
  'word-spacing',
  'text-indent',
  'tab-size',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
];

/** Low-alpha kind color; used as both fill and spread shadow (fake padding, zero layout cost). */
function pillColor(kind: string): string {
  return `var(--mantine-color-${mentionKindMeta[kind]?.color ?? 'gray'}-light)`;
}

/**
 * Prompt textarea with inline `@mention` pills.
 *
 * The pills are painted by a mirror `<div>` behind a plain transparent-background
 * textarea: the mirror re-renders the same text with mention substrings wrapped in
 * tinted spans, all glyphs transparent, so text pixels come from the textarea and
 * pill pixels from the mirror. No contenteditable, no rich-text dependency —
 * selection, autosize, IME and undo stay native.
 */
export function MentionInput({
  value,
  onChange,
  onSubmit,
  cwd,
  placeholder,
  textareaRef,
  onPasteFiles,
}: {
  value: MentionValue;
  onChange: (next: MentionValue) => void;
  onSubmit: () => void;
  cwd: string;
  placeholder: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onPasteFiles: (files: File[]) => void;
}) {
  const { text, ranges } = value;
  // The token the caret sits in, the highlighted row, and a "dismissed" token
  // start so Escape keeps the popover shut until the caret leaves that token.
  const [token, setToken] = useState<{ start: number; query: string } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissedStart, setDismissedStart] = useState<number | null>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);

  const results = useMentionSearch(token?.query ?? null, cwd);
  const activeCandidate = results[Math.min(activeIndex, results.length - 1)];

  // Keep the mirror's text metrics in sync with the textarea.
  useEffect(() => {
    const ta = textareaRef.current;
    const mirror = mirrorRef.current;
    if (!ta || !mirror) return;
    const apply = () => {
      const cs = getComputedStyle(ta);
      for (const prop of MIRROR_STYLES) mirror.style.setProperty(prop, cs.getPropertyValue(prop));
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(ta);
    return () => observer.disconnect();
  }, [textareaRef]);

  // Close the popover when the text no longer holds the token — covers external
  // resets (submit clears the prompt) as well as undo.
  useEffect(() => {
    if (token && text[token.start] !== '@') setToken(null);
  }, [text, token]);

  const focusCaret = (caret: number) => {
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      ta?.focus();
      ta?.setSelectionRange(caret, caret);
    });
  };

  /** Recompute the active token after any text or caret change. */
  const syncToken = (nextText: string, caret: number, nextRanges: MentionRange[]) => {
    const found = findMentionToken(nextText, caret, nextRanges);
    if (found && found.start === dismissedStart) {
      setToken(null);
      return;
    }
    if (!found || found.start !== dismissedStart) setDismissedStart(null);
    setToken(found);
    setActiveIndex(0);
  };

  /** Commit a candidate: drill into a directory, or drop an inline pill token. */
  const applyCandidate = (c: MentionCandidate) => {
    if (!token) return;
    const tokenLength = 1 + token.query.length;
    const before = text.slice(0, token.start);
    const after = text.slice(token.start + tokenLength);
    // A directory rewrites the token and keeps the popover open one level deeper.
    const isDir = c.kind === 'file' && c.label.endsWith('/');
    const inserted = isDir ? `@${c.id}/` : `@${c.label} `;
    const shifted = remapRanges(ranges, token.start, tokenLength, inserted.length);
    const nextRanges = isDir
      ? shifted
      : [...shifted, { ...c, start: token.start, end: token.start + 1 + c.label.length }].sort(
          (a, b) => a.start - b.start,
        );

    onChange({ text: before + inserted + after, ranges: nextRanges });
    if (isDir) {
      setToken({ start: token.start, query: `${c.id}/` });
      setActiveIndex(0);
    } else {
      setToken(null);
    }
    focusCaret(token.start + inserted.length);
  };

  /** Atomic token removal (Backspace/Delete at a pill edge or inside it). */
  const removeRange = (r: MentionRange) => {
    onChange({
      text: text.slice(0, r.start) + text.slice(r.end),
      ranges: remapRanges(ranges, r.start, r.end - r.start, 0),
    });
    setToken(null);
    focusCaret(r.start);
  };

  // Split the text into plain and mention segments for the mirror.
  const segments = useMemo(() => {
    const out: { text: string; kind?: string }[] = [];
    let pos = 0;
    for (const r of ranges) {
      if (r.start > pos) out.push({ text: text.slice(pos, r.start) });
      out.push({ text: text.slice(r.start, r.end), kind: r.kind });
      pos = r.end;
    }
    out.push({ text: text.slice(pos) });
    return out;
  }, [text, ranges]);

  return (
    <Popover
      opened={token !== null}
      position="top-start"
      width="target"
      trapFocus={false}
      shadow="md"
      withinPortal
    >
      <Popover.Target>
        <Box style={{ position: 'relative' }}>
          <Box
            ref={mirrorRef}
            aria-hidden
            style={{
              position: 'absolute',
              inset: 0,
              boxSizing: 'border-box',
              overflow: 'hidden',
              color: 'transparent',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'break-word',
              pointerEvents: 'none',
            }}
          >
            {segments.map((s, i) =>
              s.kind ? (
                <span
                  key={i}
                  style={{
                    background: pillColor(s.kind),
                    borderRadius: 3,
                    boxShadow: `0 0 0 2px ${pillColor(s.kind)}`,
                  }}
                >
                  {s.text}
                </span>
              ) : (
                <span key={i}>{s.text}</span>
              ),
            )}
          </Box>
          <Textarea
            ref={textareaRef}
            placeholder={placeholder}
            autosize
            minRows={2}
            maxRows={10}
            variant="unstyled"
            value={text}
            // Padding lives on the input (not the root) so the mirror can copy it
            // verbatim and land its pills on the same glyph positions.
            styles={{
              input: { background: 'transparent', position: 'relative', paddingInline: 6 },
            }}
            onChange={(e) => {
              const next = e.currentTarget.value;
              const caret = e.currentTarget.selectionStart;
              const edit = diffEdit(text, next);
              const nextRanges = remapRanges(ranges, edit.start, edit.removed, edit.inserted);
              onChange({ text: next, ranges: nextRanges });
              // Mid-composition text is provisional — don't pop the menu open.
              if ((e.nativeEvent as InputEvent).isComposing) setToken(null);
              else syncToken(next, caret, nextRanges);
            }}
            onClick={(e) => syncToken(text, e.currentTarget.selectionStart, ranges)}
            onScroll={(e) => {
              if (mirrorRef.current) mirrorRef.current.scrollTop = e.currentTarget.scrollTop;
            }}
            onKeyUp={(e) => {
              // Caret moves not already covered by onChange/onClick.
              if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') {
                syncToken(text, e.currentTarget.selectionStart, ranges);
              }
            }}
            onKeyDown={(e) => {
              // Mention navigation takes precedence over Enter-to-send.
              if (token && results.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActiveIndex((i) => (i + 1) % results.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActiveIndex((i) => (i - 1 + results.length) % results.length);
                  return;
                }
                if ((e.key === 'Enter' || e.key === 'Tab') && activeCandidate) {
                  e.preventDefault();
                  applyCandidate(activeCandidate);
                  return;
                }
              }
              if (token && e.key === 'Escape') {
                e.preventDefault();
                setDismissedStart(token.start);
                setToken(null);
                return;
              }
              const ta = e.currentTarget;
              if (
                (e.key === 'Backspace' || e.key === 'Delete') &&
                ta.selectionStart === ta.selectionEnd
              ) {
                const caret = ta.selectionStart;
                const hit = ranges.find((r) =>
                  e.key === 'Backspace'
                    ? caret > r.start && caret <= r.end
                    : caret >= r.start && caret < r.end,
                );
                if (hit) {
                  e.preventDefault();
                  removeRange(hit);
                  return;
                }
              }
              if (
                e.key === 'Enter' &&
                !e.shiftKey &&
                !e.metaKey &&
                !e.ctrlKey &&
                !e.altKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                onSubmit();
              }
            }}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files);
              if (files.length) {
                e.preventDefault();
                onPasteFiles(files);
              }
            }}
          />
        </Box>
      </Popover.Target>
      <Popover.Dropdown p={4}>
        <MentionDropdown results={results} activeIndex={activeIndex} onSelect={applyCandidate} />
      </Popover.Dropdown>
    </Popover>
  );
}
