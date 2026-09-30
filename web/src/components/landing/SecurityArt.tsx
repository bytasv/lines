import {
  IconBrandGithub,
  IconCloud,
  IconFolder,
  IconGitBranch,
  IconKey,
  IconLock,
  IconScale,
  IconTerminal2,
} from '@tabler/icons-react';
import {
  Arrowhead,
  Art,
  Bars,
  Glyph,
  Window,
  bad,
  border,
  dim,
  mono,
  ok,
  raised,
  surface,
  text,
} from './art';
import classes from './art.module.css';

/** Outbound only: the machine's connection passes out through the wall to the
 *  relay; nothing can come in, because no port is open. */
export function OutboundArt() {
  // Brick joints: a horizontal seam every 14 units, a vertical one in every
  // other course.
  const seams = [40, 54, 68, 82, 96, 110];
  const joints = [26, 54, 82, 110];
  return (
    <Art>
      <Arrowhead id="sa-out-arrow" />
      <Arrowhead id="sa-in-arrow" color={bad} />

      {/* --- the machine --- */}
      <rect x="18" y="40" width="72" height="46" rx="5" fill={raised} stroke={border} strokeWidth="1.5" />
      <rect x="10" y="87" width="88" height="6" rx="3" fill={raised} stroke={border} strokeWidth="1.5" />
      <circle cx="27" cy="50" r="2.5" fill={ok} />
      <text x="33" y="53" fill={text} fontSize="8">
        bridge
      </text>
      <Bars x={25} y={60} widths={[56, 40, 60]} />
      <text x="54" y="110" textAnchor="middle" fill={dim} fontSize="8.5">
        your machine
      </text>

      {/* --- the wall --- */}
      <rect x="132" y="26" width="14" height="98" rx="3" fill={raised} stroke={border} strokeWidth="1.5" />
      <g stroke={border} strokeWidth="1">
        {seams.map((y) => (
          <line key={y} x1="132" y1={y} x2="146" y2={y} />
        ))}
        {joints.map((y) => (
          <line key={y} x1="139" y1={y} x2="139" y2={y + 14} />
        ))}
      </g>

      {/* --- the relay --- */}
      <Glyph icon={IconCloud} x={198} y={26} size={58} weight={1.5} fill={raised} />
      <text x="226" y="84" textAnchor="middle" fill={dim} fontSize="8.5">
        Lines relay
      </text>

      {/* --- out: allowed, and the only direction there is --- */}
      <text x="111" y="48" textAnchor="middle" fill={dim} fontSize="7.5">
        dials out
      </text>
      <line
        className={classes.flow}
        x1="96" y1="56" x2="196" y2="56"
        stroke={dim} strokeWidth="1.5"
        markerEnd="url(#sa-out-arrow)"
      />

      {/* --- in: refused at the wall --- */}
      <line
        x1="210" y1="104" x2="168" y2="104"
        stroke={bad} strokeOpacity="0.8" strokeWidth="1.5" strokeDasharray="3 3"
        markerEnd="url(#sa-in-arrow)"
      />
      <g stroke={bad} strokeWidth="1.8" strokeLinecap="round">
        <line x1="154" y1="100" x2="162" y2="108" />
        <line x1="154" y1="108" x2="162" y2="100" />
      </g>
      <text x="190" y="124" textAnchor="middle" fill={dim} fontSize="8">
        no open port
      </text>
    </Art>
  );
}

const LOCAL_THINGS = [
  { icon: IconTerminal2, label: 'agent' },
  { icon: IconFolder, label: 'code' },
  { icon: IconGitBranch, label: 'git' },
  { icon: IconKey, label: 'logins' },
];

/** Runs on your machine: the agent, the code, git and the agent logins, all
 *  inside the machine's boundary. */
export function LocalOnlyArt() {
  return (
    <Art>
      <rect
        x="14" y="14" width="252" height="118" rx="14"
        fill="none" stroke={border} strokeWidth="1.5" strokeDasharray="5 4"
      />
      {/* A backdrop the label sits on, so it reads as cut into the boundary. */}
      <rect x="26" y="8" width="72" height="13" rx="6.5" fill={surface} />
      <text x="32" y="17.5" fill={dim} fontSize="8">
        your machine
      </text>
      {LOCAL_THINGS.map((thing, i) => {
        const x = 30 + i * 58;
        return (
          <g key={thing.label}>
            <rect x={x} y="36" width="46" height="46" rx="10" fill={raised} stroke={border} strokeWidth="1.5" />
            <Glyph icon={thing.icon} x={x + 12} y={48} size={22} weight={1.5} />
            <text x={x + 23} y="98" textAnchor="middle" fill={text} fontSize="8.5">
              {thing.label}
            </text>
          </g>
        );
      })}
      <text x="140" y="120" textAnchor="middle" fill={dim} fontSize="8">
        every turn runs here
      </text>
    </Art>
  );
}

/** Opt-in end-to-end encryption: an enrolled browser and the machine exchange
 *  traffic the relay carries but cannot read or forge. */
export function EncryptionArt() {
  return (
    <Art>
      <Arrowhead id="sa-e2ee-arrow" />

      {/* --- the enrolled browser, holding its key --- */}
      <Window x={10} y={40} width={62} height={46}>
        <Bars x={17} y={62} widths={[40, 30]} />
      </Window>
      <circle cx="70" cy="42" r="8" fill={ok} />
      <Glyph icon={IconKey} x={65} y={37} size={10} color="#ffffff" weight={1.3} />
      <text x="41" y="104" textAnchor="middle" fill={dim} fontSize="8">
        enrolled browser
      </text>

      {/* --- the relay, holding only ciphertext --- */}
      <rect x="112" y="44" width="56" height="38" rx="7" fill={raised} stroke={border} strokeWidth="1.5" />
      <g fill={dim} fontSize="8" textAnchor="middle" style={mono}>
        <text x="140" y="60">9f#a2·k</text>
        <text x="140" y="72">x7@q4!m</text>
      </g>
      <text x="140" y="100" textAnchor="middle" fill={dim} fontSize="8">
        relay
      </text>
      <text x="140" y="112" textAnchor="middle" fill={dim} fontSize="7.5">
        can’t read or forge it
      </text>

      {/* --- the machine --- */}
      <rect x="208" y="40" width="62" height="42" rx="5" fill={raised} stroke={border} strokeWidth="1.5" />
      <rect x="202" y="83" width="74" height="5" rx="2.5" fill={raised} stroke={border} strokeWidth="1.5" />
      <Bars x={215} y={52} widths={[44, 32, 48]} />
      <text x="239" y="104" textAnchor="middle" fill={dim} fontSize="8">
        your machine
      </text>

      {/* --- locked both ways --- */}
      <g stroke={dim} strokeWidth="1.5" markerEnd="url(#sa-e2ee-arrow)">
        <line className={classes.flow} x1="76" y1="63" x2="108" y2="63" />
        <line className={classes.flow} x1="204" y1="63" x2="172" y2="63" />
      </g>
      <Glyph icon={IconLock} x={87} y={47} size={10} weight={1.3} />
      <Glyph icon={IconLock} x={183} y={47} size={10} weight={1.3} />
      <text x="140" y="134" textAnchor="middle" fill={dim} fontSize="8">
        opt-in, per browser
      </text>
    </Art>
  );
}

const REPO_DIRS = [
  { name: 'desktop', bar: 70, age: '2d' },
  { name: 'relay', bar: 54, age: '5h' },
  { name: 'server', bar: 88, age: '1h' },
  { name: 'shared', bar: 46, age: '3d' },
  { name: 'storage', bar: 62, age: '6h' },
  { name: 'web', bar: 80, age: '20m' },
];

/** Open source: the public repo, its AGPL-3.0 licence, and every package that
 *  runs on your machine or relays for it. */
export function OpenSourceArt() {
  return (
    <Art>
      <rect x="18" y="12" width="244" height="126" rx="8" fill={raised} stroke={border} strokeWidth="1.5" />
      <Glyph icon={IconBrandGithub} x={28} y={19} size={13} weight={1.3} />
      <text x="46" y="29" fill={text} fontSize="9" fontWeight="600">
        bytasv / lines
      </text>
      <rect x="122" y="19.5" width="32" height="13" rx="6.5" fill="none" stroke={border} strokeWidth="1" />
      <text x="138" y="28.8" textAnchor="middle" fill={dim} fontSize="7">
        Public
      </text>
      <rect x="192" y="18.5" width="60" height="15" rx="4" fill={text} fillOpacity="0.08" stroke={border} strokeWidth="1" />
      <Glyph icon={IconScale} x={197} y={21.5} size={9} weight={1.1} />
      <text x="209" y="29" fill={text} fontSize="7.5" fontWeight="600">
        AGPL-3.0
      </text>
      <line x1="18" y1="40" x2="262" y2="40" stroke={border} strokeWidth="1.5" />
      {REPO_DIRS.map((dir, i) => {
        const y = 40 + i * 16;
        return (
          <g key={dir.name}>
            {i > 0 && <line x1="18" y1={y} x2="262" y2={y} stroke={border} strokeWidth="0.8" />}
            <Glyph icon={IconFolder} x={28} y={y + 3.5} size={9} color={dim} weight={1.1} />
            <text x="42" y={y + 11} fill={text} fontSize="8" style={mono}>
              {dir.name}
            </text>
            <rect x="118" y={y + 6.5} width={dir.bar} height="3" rx="1.5" fill={dim} opacity="0.35" />
            <text x="252" y={y + 11} textAnchor="end" fill={dim} fontSize="7">
              {dir.age}
            </text>
          </g>
        );
      })}
    </Art>
  );
}
