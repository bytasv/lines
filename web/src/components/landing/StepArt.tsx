import { IconFolder } from '@tabler/icons-react';
import {
  AppIcon,
  Arrowhead,
  Art,
  Bars,
  Glyph,
  Shadow,
  Tick,
  Window,
  bad,
  border,
  busy,
  dim,
  mono,
  ok,
  raised,
  surface,
  text,
  warn,
} from './art';
import classes from './art.module.css';

/** Step 1: the disk image the desktop app ships as — drag Lines to Applications. */
export function InstallArt() {
  return (
    <Art>
      <Arrowhead id="st-install-arrow" />
      <Window x={20} y={14} width={240} height={122} title="Lines.dmg">
        <AppIcon x={56} y={48} size={44} />
        <text x="78" y="112" textAnchor="middle" fill={text} fontSize="8.5">
          Lines
        </text>
        <path
          className={classes.flow}
          d="M 112 70 H 166"
          fill="none" stroke={dim} strokeWidth="1.5"
          markerEnd="url(#st-install-arrow)"
        />
        <Glyph icon={IconFolder} x={178} y={46} size={48} weight={1.5} fill={raised} />
        <text x="202" y="112" textAnchor="middle" fill={text} fontSize="8.5">
          Applications
        </text>
      </Window>
    </Art>
  );
}

// Eight characters from the storage server's unambiguous alphabet (no I, O, 0, 1).
const PAIRING_CODE = 'K7QM4XR2';

/** Step 2: the code the desktop app's menu shows, typed into the browser. */
export function PairArt() {
  return (
    <Art>
      <Shadow id="st-pair-shadow" />
      <Arrowhead id="st-pair-arrow" />

      {/* --- the menu on the Mac --- */}
      <rect
        x="14" y="34" width="104" height="58" rx="8"
        fill={raised} stroke={border} strokeWidth="1.2"
        filter="url(#st-pair-shadow)"
      />
      <text x="25" y="50" fill={text} fontSize="8" fontWeight="600">
        Open Lines
      </text>
      <line x1="21" y1="57" x2="111" y2="57" stroke={border} />
      <text x="25" y="70" fill={dim} fontSize="7.5">
        Pairing code:
      </text>
      <text x="25" y="84" fill={text} fontSize="9.5" fontWeight="700" style={mono}>
        {PAIRING_CODE}
      </text>
      <text x="66" y="124" textAnchor="middle" fill={dim} fontSize="8">
        on your Mac
      </text>

      <line
        className={classes.flow}
        x1="124" y1="63" x2="150" y2="63"
        stroke={dim} strokeWidth="1.5"
        markerEnd="url(#st-pair-arrow)"
      />

      {/* --- the same code, entered in the browser --- */}
      <Window x={156} y={22} width={110} height={84}>
        <text x="166" y="48" fill={dim} fontSize="7.5">
          Pairing code
        </text>
        {Array.from(PAIRING_CODE).map((char, i) => (
          <g key={i}>
            <rect x={164 + i * 12} y="54" width="10" height="14" rx="2.5" fill={surface} stroke={border} strokeWidth="1" />
            <text x={169 + i * 12} y="64" textAnchor="middle" fill={text} fontSize="8" style={mono}>
              {char}
            </text>
          </g>
        ))}
        <rect x="166" y="78" width="90" height="16" rx="4" fill={text} />
        <text x="211" y="89" textAnchor="middle" fill={surface} fontSize="7.5" fontWeight="600">
          Pair this machine
        </text>
      </Window>
      <circle cx="262" cy="24" r="7" fill={ok} />
      <Tick x={262} y={24} color="#ffffff" scale={0.8} />
      <text x="211" y="124" textAnchor="middle" fill={dim} fontSize="8">
        in any browser
      </text>
    </Art>
  );
}

/** Step 3: a session running in the browser — sessions and their statuses on
 *  the left, the open one streaming with an edit it has just made. */
export function RunArt() {
  return (
    <Art>
      <Window x={14} y={12} width={252} height={126}>
        <rect x="96" y="16.5" width="88" height="5" rx="2.5" fill={dim} opacity="0.25" />

        <line x1="78" y1="26" x2="78" y2="138" stroke={border} strokeWidth="1.2" />
        <rect x="18" y="31" width="56" height="13" rx="3.5" fill={text} opacity="0.1" />
        {[
          { y: 37.5, color: busy, width: 34 },
          { y: 53.5, color: warn, width: 28 },
          { y: 69.5, color: ok, width: 38 },
        ].map((session) => (
          <g key={session.y}>
            <circle cx="25" cy={session.y} r="2.5" fill={session.color} />
            <rect x="31" y={session.y - 1.5} width={session.width} height="3" rx="1.5" fill={dim} opacity="0.5" />
          </g>
        ))}

        <rect x="176" y="34" width="80" height="14" rx="7" fill={text} opacity="0.12" />
        <rect x="184" y="39.5" width="56" height="3" rx="1.5" fill={dim} opacity="0.6" />
        <Bars x={90} y={58} widths={[124, 98, 136]} gap={8} />
        <rect className={classes.cursor} x="229" y="72" width="3.5" height="7" rx="1" fill={text} />
        <rect x="90" y="86" width="134" height="16" rx="4" fill="none" stroke={border} strokeWidth="1" />
        <text x="97" y="96.8" fill={dim} fontSize="7.5" style={mono}>
          Edit session.ts
        </text>
        <text x="218" y="96.8" textAnchor="end" fontSize="7.5" style={mono}>
          <tspan fill={ok}>+12</tspan>
          <tspan fill={bad}> −3</tspan>
        </text>
        <rect x="90" y="112" width="166" height="18" rx="5" fill={surface} stroke={border} strokeWidth="1" />
        <rect x="97" y="119.5" width="64" height="3" rx="1.5" fill={dim} opacity="0.4" />
        <circle cx="247" cy="121" r="5" fill={text} />
      </Window>
    </Art>
  );
}
