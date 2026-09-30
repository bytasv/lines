import type { ReactNode } from 'react';
import type { IconCloud } from '@tabler/icons-react';
import logoUrl from '../../assets/logo-mark.png';
import classes from './art.module.css';

/**
 * The shared kit behind the landing page's illustrations.
 *
 * Inline SVG with Mantine CSS variables, like PairingDiagram, so every drawing
 * tracks the colour scheme and needs no build step. Monochrome, with the app's
 * status hues where a drawing shows a status: blue running, green done or
 * connected, yellow needs you, red refused. The drawings are decorative — the
 * card text beside each carries its meaning — so they are aria-hidden. Marker
 * and filter ids are prefixed per drawing and safe only because each drawing
 * appears once per page.
 */
export const border = 'var(--mantine-color-default-border)';
export const text = 'var(--mantine-color-text)';
export const dim = 'var(--mantine-color-dimmed)';
export const surface = 'var(--mantine-color-body)';
export const raised = 'var(--mantine-color-default)';
export const ok = 'var(--mantine-color-green-6)';
export const warn = 'var(--mantine-color-yellow-6)';
export const bad = 'var(--mantine-color-red-6)';
export const busy = 'var(--mantine-color-blue-6)';
export const mono = { fontFamily: 'var(--mantine-font-family-monospace)' };

/** Every drawing shares one 280×150 canvas, so the cards line up. */
export function Art({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 280 150" width="100%" aria-hidden="true" style={{ display: 'block' }}>
      {children}
    </svg>
  );
}

/** Placeholder "text" rows, so a window reads as having content without any. */
export function Bars({ x, y, widths, gap = 7 }: { x: number; y: number; widths: number[]; gap?: number }) {
  return (
    <g fill={dim} opacity="0.4">
      {widths.map((w, i) => (
        <rect key={i} x={x} y={y + i * gap} width={w} height="3" rx="1.5" />
      ))}
    </g>
  );
}

/** A window with a title bar and the three traffic-light dots. */
export function Window({
  x,
  y,
  width,
  height,
  title,
  children,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  title?: string;
  children?: ReactNode;
}) {
  const bar = 14;
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} rx="7" fill={raised} stroke={border} strokeWidth="1.5" />
      <line x1={x} y1={y + bar} x2={x + width} y2={y + bar} stroke={border} strokeWidth="1.5" />
      {[0, 1, 2].map((k) => (
        <circle key={k} cx={x + 9 + k * 7} cy={y + bar / 2} r="2" fill={dim} opacity="0.6" />
      ))}
      {title && (
        <text x={x + width / 2} y={y + bar / 2 + 3} textAnchor="middle" fill={dim} fontSize="8">
          {title}
        </text>
      )}
      {children}
    </g>
  );
}

/**
 * A Tabler icon placed on the canvas. The icon draws in its own 24-unit box, so
 * the stroke is scaled back to `weight` canvas units, matching the drawings'
 * own lines whatever size the icon is. `fill` fills its outline (Tabler icons
 * are unfilled by default), so it can sit over other lines.
 */
export function Glyph({
  icon: Icon,
  x,
  y,
  size,
  color = text,
  weight = 1.4,
  // Explicit, not left undefined: Tabler spreads extra props over its own
  // fill="none", so an undefined fill would drop the attribute and leave the
  // outline filled black (SVG's default).
  fill = 'none',
}: {
  icon: typeof IconCloud;
  x: number;
  y: number;
  size: number;
  color?: string;
  weight?: number;
  fill?: string;
}) {
  return <Icon x={x} y={y} size={size} stroke={(weight * 24) / size} color={color} fill={fill} />;
}

/** The Lines app icon: the real mark on its white plate, as BrandMark plates it. */
export function AppIcon({ x, y, size }: { x: number; y: number; size: number }) {
  const inset = size * 0.18;
  return (
    <g>
      <rect x={x} y={y} width={size} height={size} rx={size * 0.26} fill="#ffffff" stroke={border} strokeWidth="0.8" />
      <image href={logoUrl} x={x + inset} y={y + inset} width={size - inset * 2} height={size - inset * 2} />
    </g>
  );
}

/** The mark alone, as macOS draws a menu bar template image: dark on a light
 *  bar, light on a dark one. */
export function MenuBarMark({ x, y, size }: { x: number; y: number; size: number }) {
  return <image className={classes.template} href={logoUrl} x={x} y={y} width={size} height={size} />;
}

export function Arrowhead({ id, color = dim }: { id: string; color?: string }) {
  return (
    <defs>
      <marker id={id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
        <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
      </marker>
    </defs>
  );
}

/** A soft drop shadow, for anything drawn floating above the rest (menus,
 *  notifications). */
export function Shadow({ id }: { id: string }) {
  return (
    <defs>
      <filter id={id} x="-30%" y="-20%" width="160%" height="150%">
        <feDropShadow dx="0" dy="4" stdDeviation="5" floodColor="#000" floodOpacity="0.28" />
      </filter>
    </defs>
  );
}

/** A tick, for "done" and "paired". */
export function Tick({ x, y, color = text, scale = 1 }: { x: number; y: number; color?: string; scale?: number }) {
  return (
    <path
      d={`M ${x - 4 * scale} ${y} l ${2.8 * scale} ${2.8 * scale} l ${5.2 * scale} ${-5.6 * scale}`}
      fill="none"
      stroke={color}
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}
