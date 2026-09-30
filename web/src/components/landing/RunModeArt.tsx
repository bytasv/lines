import { IconCloud } from '@tabler/icons-react';
import {
  Arrowhead,
  Art,
  Bars,
  Glyph,
  MenuBarMark,
  Shadow,
  border,
  dim,
  mono,
  ok,
  raised,
  surface,
  text,
} from './art';
import classes from './art.module.css';

/** "Three ways to run it": local dev. A terminal that has just started the dev server. */
export function LocalDevArt() {
  return (
    <Art>
      <rect x="34" y="14" width="212" height="122" rx="10" fill={raised} stroke={border} strokeWidth="1.5" />
      <line x1="34" y1="36" x2="246" y2="36" stroke={border} strokeWidth="1.5" />
      {[48, 60, 72].map((cx) => (
        <circle key={cx} cx={cx} cy="25" r="3.5" fill={dim} opacity="0.6" />
      ))}
      <text x="140" y="28.5" textAnchor="middle" fill={dim} fontSize="9">
        ~/lines
      </text>
      <g fontSize="10" style={mono}>
        <text x="48" y="58">
          <tspan fill={dim}>$ </tspan>
          <tspan fill={text}>npm install</tspan>
        </text>
        <text x="48" y="77">
          <tspan fill={dim}>$ </tspan>
          <tspan fill={text}>npm run dev</tspan>
        </text>
        <text x="48" y="96">
          <tspan fill={ok}>➜ </tspan>
          <tspan fill={dim}>ready on </tspan>
          <tspan fill={text}>localhost</tspan>
        </text>
        <text x="48" y="115" fill={dim}>
          $
        </text>
        <rect className={classes.cursor} x="60" y="106" width="6" height="11" rx="1" fill={text} />
      </g>
    </Art>
  );
}

/** "Three ways to run it": the Mac app. The Lines menu open in the menu bar,
 *  beside its app window. Rows follow the real tray menu (desktop/src/main.ts,
 *  updateTray). */
export function DesktopAppArt() {
  return (
    <Art>
      <Shadow id="rm-menu-shadow" />

      {/* --- the screen, with a menu bar across the top --- */}
      <rect x="14" y="12" width="252" height="126" rx="10" fill={surface} stroke={border} strokeWidth="1.5" />
      <path d="M 14 22 a 10 10 0 0 1 10 -10 h 232 a 10 10 0 0 1 10 10 v 9 h -252 z" fill={border} opacity="0.4" />
      <line x1="14" y1="31" x2="266" y2="31" stroke={border} strokeWidth="1.5" />
      <rect x="26" y="19" width="8" height="5" rx="2" fill={dim} />
      <rect x="42" y="19.5" width="22" height="4" rx="2" fill={dim} opacity="0.7" />
      <rect x="70" y="19.5" width="14" height="4" rx="2" fill={dim} opacity="0.45" />
      <rect x="90" y="19.5" width="16" height="4" rx="2" fill={dim} opacity="0.45" />
      <rect x="220" y="18.5" width="11" height="6" rx="1.5" fill="none" stroke={dim} strokeWidth="1" />
      <text x="254" y="24.5" textAnchor="end" fill={dim} fontSize="8">
        9:41
      </text>
      {/* Lines' own menu bar item, highlighted because its menu is open. */}
      <rect x="187" y="14.5" width="20" height="14" rx="4" fill={text} opacity="0.16" />
      <MenuBarMark x={191.5} y={16} size={11} />

      {/* --- the app window behind it: sidebar, transcript, composer --- */}
      <g opacity="0.85">
        <rect x="28" y="44" width="100" height="80" rx="6" fill={raised} stroke={border} strokeWidth="1.2" />
        <line x1="28" y1="55" x2="128" y2="55" stroke={border} strokeWidth="1.2" />
        {[35, 41, 47].map((cx) => (
          <circle key={cx} cx={cx} cy="49.5" r="1.8" fill={dim} opacity="0.6" />
        ))}
        <line x1="56" y1="55" x2="56" y2="124" stroke={border} strokeWidth="1.2" />
        <rect x="33" y="61" width="18" height="3" rx="1.5" fill={text} opacity="0.55" />
        <Bars x={33} y={68} widths={[18, 18]} />
        <Bars x={62} y={62} widths={[56, 44, 58, 36]} />
        <rect x="62" y="106" width="60" height="12" rx="3" fill="none" stroke={border} strokeWidth="1" />
      </g>

      {/* --- the open menu --- */}
      <rect
        x="140" y="33" width="118" height="100" rx="8"
        fill={raised} stroke={border} strokeWidth="1.2"
        filter="url(#rm-menu-shadow)"
      />
      <g fontSize="8.5">
        <text x="151" y="48" fill={text} fontWeight="600">
          Open Lines
        </text>
        <circle cx="153.5" cy="59.5" r="2.5" fill={ok} />
        <text x="160" y="62.5" fill={text}>
          Connected
        </text>
        <line x1="147" y1="70" x2="251" y2="70" stroke={border} />
        <text x="151" y="84" fill={dim}>
          Bridge: running
        </text>
        <text x="151" y="98" fill={dim}>
          Worker: running
        </text>
        <line x1="147" y1="106" x2="251" y2="106" stroke={border} />
        <text x="151" y="121" fill={dim}>
          Quit Lines
        </text>
      </g>
    </Art>
  );
}

/** "Three ways to run it": hosted. Any browser and the paired machine both
 *  connect out to the relay — the flow runs toward it from each side, which is
 *  the no-open-port point. */
export function HostedArt() {
  return (
    <Art>
      <Arrowhead id="rm-arrow" />

      {/* --- any browser: a laptop window with a phone in front of it --- */}
      <rect x="10" y="40" width="64" height="50" rx="6" fill={raised} stroke={border} strokeWidth="1.5" />
      <line x1="10" y1="50" x2="74" y2="50" stroke={border} strokeWidth="1.5" />
      {[16, 22, 28].map((cx) => (
        <circle key={cx} cx={cx} cy="45" r="1.8" fill={dim} opacity="0.6" />
      ))}
      <Bars x={16} y={57} widths={[40, 30, 44]} />
      <rect x="56" y="62" width="30" height="54" rx="6" fill={raised} stroke={border} strokeWidth="1.5" />
      <rect x="66" y="66" width="10" height="2.5" rx="1.25" fill={dim} opacity="0.6" />
      <Bars x={61} y={76} widths={[20, 14, 18]} />
      <rect x="61" y="104" width="20" height="6" rx="2" fill="none" stroke={border} strokeWidth="1" />

      {/* --- the relay --- */}
      <Glyph icon={IconCloud} x={110} y={42} size={60} weight={1.5} fill={raised} />

      {/* --- the paired machine, where the agent actually runs --- */}
      <rect x="194" y="42" width="72" height="48" rx="5" fill={raised} stroke={border} strokeWidth="1.5" />
      <rect x="186" y="91" width="88" height="6" rx="3" fill={raised} stroke={border} strokeWidth="1.5" />
      <circle cx="203" cy="52" r="2.5" fill={ok} />
      <text x="209" y="55" fill={text} fontSize="8">
        agent
      </text>
      <Bars x={201} y={62} widths={[50, 36, 54]} />

      {/* --- both sides dial out --- */}
      <g stroke={dim} strokeWidth="1.5" markerEnd="url(#rm-arrow)">
        <line className={classes.flow} x1="90" y1="76" x2="111" y2="76" />
        <line className={classes.flow} x1="190" y1="76" x2="168" y2="76" />
      </g>

      <g fontSize="9" fill={dim} textAnchor="middle">
        <text x="48" y="134">any browser</text>
        <text x="139" y="134">Lines relay</text>
        <text x="230" y="134">your machine</text>
      </g>
    </Art>
  );
}
