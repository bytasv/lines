import {
  IconArrowBackUp,
  IconFileCode,
  IconGitBranch,
  IconListCheck,
  IconMaximize,
  IconMessage,
  IconMicrophone,
  IconPlug,
} from '@tabler/icons-react';
import { ProviderMark } from '../ProviderMark';
import {
  AppIcon,
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

/** Plan: a plan open in focus mode with one passage selected and commented,
 *  the card's actions turned into their "with comments" pair, and the mic for
 *  dictating the next note. */
export function PlanArt() {
  return (
    <Art>
      <Shadow id="pa-shadow" />
      <Window x={14} y={10} width={176} height={130} title="plan · focus">
        <Glyph icon={IconMaximize} x={174} y={12} size={10} color={dim} weight={1.2} />
      </Window>
      <text x="24" y="40" fill={text} fontSize="9" fontWeight="600">
        Plan
      </text>
      <Bars x={24} y={48} widths={[140, 118]} gap={8} />
      {/* The selected, commented passage. */}
      <rect x="21" y="62" width="154" height="10" rx="2" fill={warn} opacity="0.18" />
      <rect x="24" y="65.5" width="130" height="3" rx="1.5" fill={text} opacity="0.55" />
      <Bars x={24} y={80} widths={[132, 96]} gap={8} />
      <rect x="24" y="106" width="64" height="17" rx="4" fill="none" stroke={border} strokeWidth="1.2" />
      <text x="56" y="117.5" textAnchor="middle" fill={text} fontSize="7.5">
        Refine (1)
      </text>
      <rect x="94" y="106" width="84" height="17" rx="4" fill={text} />
      <text x="136" y="117.5" textAnchor="middle" fill={surface} fontSize="7.5" fontWeight="600">
        Approve (1)
      </text>

      {/* The comment, tied to its passage. */}
      <line x1="175" y1="67" x2="198" y2="62" stroke={warn} strokeWidth="1.2" strokeDasharray="2 2" />
      <rect
        x="198" y="44" width="72" height="40" rx="7"
        fill={raised} stroke={warn} strokeWidth="1.2" filter="url(#pa-shadow)"
      />
      <Glyph icon={IconMessage} x={205} y={50} size={9} color={dim} weight={1.1} />
      <text x="217" y="57.5" fill={dim} fontSize="7.5">
        comment
      </text>
      <text x="205" y="74" fill={text} fontSize="8">
        retry on 429?
      </text>
      <circle cx="234" cy="110" r="9" fill={text} />
      <Glyph icon={IconMicrophone} x={230} y={106} size={8} color={surface} weight={1.1} />
      <text x="234" y="131" textAnchor="middle" fill={dim} fontSize="7.5">
        dictate
      </text>
    </Art>
  );
}

/** Run agents: a Claude Code session still streaming, with a background
 *  command it can stop and a "Send now" into the live turn, beside a Codex
 *  session whose turn has finished. */
export function ParallelSessionsArt() {
  return (
    <Art>
      <Window x={14} y={12} width={252} height={126} title="2 sessions">
        <line x1="140" y1="26" x2="140" y2="138" stroke={border} strokeWidth="1.2" />

        <g transform="translate(24 32)">
          <ProviderMark provider="anthropic" size={9} />
        </g>
        <text x="37" y="39.5" fill={text} fontSize="8.5" fontWeight="600">
          Claude Code
        </text>
        <circle cx="129" cy="36.5" r="2.5" fill={busy} />
        <Bars x={24} y={50} widths={[100, 84, 104, 62]} gap={8} />
        <rect className={classes.cursor} x="89" y="72" width="3.5" height="7" rx="1" fill={text} />
        <rect x="24" y="88" width="106" height="16" rx="4" fill={surface} stroke={border} strokeWidth="1" />
        <circle cx="32.5" cy="96" r="3" fill="none" stroke={busy} strokeWidth="1.3" strokeDasharray="12 7" />
        <text x="40" y="98.8" fill={dim} fontSize="7.5" style={mono}>
          npm test
        </text>
        <rect x="118" y="92.5" width="7" height="7" rx="1.5" fill={dim} />
        <rect x="24" y="112" width="106" height="18" rx="5" fill="none" stroke={border} strokeWidth="1" />
        <rect x="30" y="119.5" width="40" height="3" rx="1.5" fill={dim} opacity="0.4" />
        <rect x="84" y="115" width="42" height="12" rx="6" fill={text} />
        <text x="105" y="123.4" textAnchor="middle" fill={surface} fontSize="7" fontWeight="600">
          Send now
        </text>

        {/* OpenAI's mark is monochrome and takes the text colour (see ProviderMark). */}
        <g transform="translate(150 32)" style={{ color: text }}>
          <ProviderMark provider="openai" size={9} />
        </g>
        <text x="163" y="39.5" fill={text} fontSize="8.5" fontWeight="600">
          Codex
        </text>
        <circle cx="255" cy="36.5" r="2.5" fill={ok} />
        <Bars x={150} y={50} widths={[92, 106, 72]} gap={8} />
        <Tick x={155} y={82} color={ok} scale={0.7} />
        <text x="162" y="84.5" fill={dim} fontSize="7.5">
          Turn complete
        </text>
        <rect x="150" y="112" width="106" height="18" rx="5" fill="none" stroke={border} strokeWidth="1" />
        <rect x="156" y="119.5" width="52" height="3" rx="1.5" fill={dim} opacity="0.4" />
        <circle cx="248" cy="121" r="5" fill={text} />
      </Window>
    </Art>
  );
}

const DIFF_ROWS: { sign: ' ' | '+' | '-'; width: number }[] = [
  { sign: ' ', width: 118 },
  { sign: '-', width: 150 },
  { sign: '+', width: 140 },
  { sign: '+', width: 96 },
  { sign: ' ', width: 112 },
  { sign: ' ', width: 72 },
];

/** Review: a readable diff, the session's own worktree branch, and rewind. */
export function ReviewArt() {
  return (
    <Art>
      <rect x="18" y="12" width="244" height="98" rx="7" fill={raised} stroke={border} strokeWidth="1.5" />
      <Glyph icon={IconFileCode} x={27} y={16.5} size={11} color={dim} weight={1.2} />
      <text x="42" y="25.5" fill={text} fontSize="8.5" style={mono}>
        src/session.ts
      </text>
      <text x="252" y="25.5" textAnchor="end" fontSize="8.5" style={mono}>
        <tspan fill={ok}>+12</tspan>
        <tspan fill={bad}> −3</tspan>
      </text>
      <line x1="18" y1="32" x2="262" y2="32" stroke={border} strokeWidth="1.5" />
      {DIFF_ROWS.map((row, i) => {
        const y = 34 + i * 12;
        const tone = row.sign === '+' ? ok : row.sign === '-' ? bad : undefined;
        return (
          <g key={i}>
            {tone && <rect x="19" y={y} width="242" height="12" fill={tone} opacity="0.12" />}
            <text x="30" y={y + 8.5} fill={dim} fontSize="7" style={mono}>
              {41 + i}
            </text>
            {tone && (
              <text x="45" y={y + 8.5} fill={tone} fontSize="8" style={mono}>
                {row.sign === '-' ? '−' : '+'}
              </text>
            )}
            <rect
              x="54" y={y + 4.5} width={row.width} height="3" rx="1.5"
              fill={tone ?? dim} opacity={tone ? 0.55 : 0.4}
            />
          </g>
        );
      })}

      <rect x="18" y="118" width="128" height="18" rx="9" fill={raised} stroke={border} strokeWidth="1.2" />
      <Glyph icon={IconGitBranch} x={26} y={121.5} size={11} weight={1.2} />
      <text x="41" y="130" fill={text} fontSize="8">
        worktree · fix-auth
      </text>
      <rect x="154" y="118" width="108" height="18" rx="9" fill={raised} stroke={border} strokeWidth="1.2" />
      <Glyph icon={IconArrowBackUp} x={162} y={121.5} size={11} color={dim} weight={1.2} />
      <text x="177" y="130" fill={dim} fontSize="8">
        Rewind to prompt
      </text>
    </Art>
  );
}

/** Control: a tool call waiting on Allow / Deny (yellow, the app's "needs you"),
 *  the model and effort picker, the allowlist, and context and cost. */
export function ControlArt() {
  return (
    <Art>
      <rect x="16" y="22" width="162" height="76" rx="8" fill={raised} stroke={warn} strokeWidth="1.5" />
      <text x="28" y="39" fill={text} fontSize="9" fontWeight="600">
        Allow this command?
      </text>
      <rect x="28" y="46" width="138" height="17" rx="4" fill={surface} stroke={border} strokeWidth="1" />
      <text x="35" y="57.5" fontSize="8" style={mono}>
        <tspan fill={dim}>$ </tspan>
        <tspan fill={text}>npm run test</tspan>
      </text>
      <rect x="28" y="72" width="52" height="16" rx="4" fill="none" stroke={border} strokeWidth="1.2" />
      <text x="54" y="83" textAnchor="middle" fill={text} fontSize="8">
        Deny
      </text>
      <rect x="86" y="72" width="52" height="16" rx="4" fill={text} />
      <text x="112" y="83" textAnchor="middle" fill={surface} fontSize="8" fontWeight="600">
        Allow
      </text>

      <rect x="16" y="108" width="94" height="17" rx="4" fill={raised} stroke={border} strokeWidth="1.2" />
      <text x="24" y="119.5" fill={text} fontSize="8">
        Sonnet · high
      </text>
      <path
        d="M 99 114.5 l 3 3 l 3 -3" fill="none" stroke={dim} strokeWidth="1.2"
        strokeLinecap="round" strokeLinejoin="round"
      />
      <rect x="116" y="108" width="62" height="17" rx="4" fill={raised} stroke={border} strokeWidth="1.2" />
      <Glyph icon={IconListCheck} x={121} y={111} size={11} color={ok} weight={1.2} />
      <text x="135" y="119.5" fill={dim} fontSize="8">
        Allowlist
      </text>

      {/* Context ring at 62%: dash length is 62% of the 2πr = 131.9 circumference. */}
      <circle cx="224" cy="54" r="21" fill="none" stroke={border} strokeWidth="5" />
      <circle
        cx="224" cy="54" r="21" fill="none" stroke={text} strokeWidth="5" strokeLinecap="round"
        strokeDasharray="82 132" transform="rotate(-90 224 54)"
      />
      <text x="224" y="57.5" textAnchor="middle" fill={text} fontSize="10" fontWeight="600">
        62%
      </text>
      <text x="224" y="92" textAnchor="middle" fill={dim} fontSize="8">
        context
      </text>
      <rect x="194" y="108" width="60" height="17" rx="8.5" fill={raised} stroke={border} strokeWidth="1.2" />
      <text x="224" y="119.5" textAnchor="middle" fill={text} fontSize="8.5" style={mono}>
        $0.42
      </text>
    </Art>
  );
}

const WORKFLOW_STEPS = [
  { x: 46, label: 'Plan', state: 'done' },
  { x: 108, label: 'Build', state: 'done' },
  { x: 170, label: 'Test', state: 'current' },
  { x: 232, label: 'Review', state: 'pending' },
] as const;

const RECIPES = [
  { x: 20, title: 'Fix a failing test', tag: 'bugfix', version: 'v3', mcp: false },
  { x: 144, title: 'Triage issues', tag: 'MCP tools', version: 'v5', mcp: true },
];

/** Automate: a workflow part-way through its steps, drawn the way the app's
 *  stepper draws them (done tinted, current solid, next outlined), over two
 *  versioned recipes from the library. */
export function AutomateArt() {
  const cy = 40;
  return (
    <Art>
      <line x1="56" y1={cy} x2="98" y2={cy} stroke={text} strokeOpacity="0.5" strokeWidth="1.5" />
      <line x1="118" y1={cy} x2="160" y2={cy} stroke={text} strokeOpacity="0.5" strokeWidth="1.5" />
      <line x1="180" y1={cy} x2="222" y2={cy} stroke={border} strokeWidth="1.5" strokeDasharray="3 3" />
      {WORKFLOW_STEPS.map((step, i) => {
        const current = step.state === 'current';
        return (
          <g key={step.label}>
            {step.state === 'done' && (
              <>
                <circle cx={step.x} cy={cy} r="10" fill={text} fillOpacity="0.16" />
                <Tick x={step.x} y={cy} />
              </>
            )}
            {step.state !== 'done' && (
              <>
                <circle
                  cx={step.x} cy={cy} r="10"
                  fill={current ? text : raised}
                  stroke={current ? 'none' : border}
                  strokeWidth="1.5"
                />
                <text
                  x={step.x} y={cy + 3.3} textAnchor="middle"
                  fill={current ? surface : dim} fontSize="9" fontWeight="700"
                >
                  {i + 1}
                </text>
              </>
            )}
            <text
              x={step.x} y={cy + 24} textAnchor="middle"
              fill={current ? text : dim} fontSize="8" fontWeight={current ? 600 : 400}
            >
              {step.label}
            </text>
          </g>
        );
      })}

      {RECIPES.map((recipe) => (
        <g key={recipe.title}>
          <rect x={recipe.x} y="80" width="116" height="48" rx="7" fill={raised} stroke={border} strokeWidth="1.2" />
          <text x={recipe.x + 10} y="97" fill={text} fontSize="8.5" fontWeight="600">
            {recipe.title}
          </text>
          <text x={recipe.x + 106} y="97" textAnchor="end" fill={dim} fontSize="7.5" style={mono}>
            {recipe.version}
          </text>
          {recipe.mcp ? (
            <>
              <rect x={recipe.x + 10} y="105" width="58" height="13" rx="6.5" fill="none" stroke={border} strokeWidth="1" />
              <Glyph icon={IconPlug} x={recipe.x + 14} y={107} size={9} color={dim} weight={1.1} />
              <text x={recipe.x + 25} y="114.5" fill={dim} fontSize="7.5">
                {recipe.tag}
              </text>
            </>
          ) : (
            <>
              <rect x={recipe.x + 10} y="105" width="36" height="13" rx="6.5" fill="none" stroke={border} strokeWidth="1" />
              <text x={recipe.x + 28} y="114.5" textAnchor="middle" fill={dim} fontSize="7.5">
                {recipe.tag}
              </text>
            </>
          )}
        </g>
      ))}
    </Art>
  );
}

/** From anywhere: the phone web app with an approval alert on top of it, voice
 *  dictation in the composer, others in the session, and the machine switcher. */
export function AnywhereArt() {
  return (
    <Art>
      <Shadow id="fa-shadow" />

      {/* --- the phone --- */}
      <rect x="100" y="8" width="84" height="134" rx="14" fill={raised} stroke={border} strokeWidth="1.5" />
      <rect x="129" y="14" width="26" height="6" rx="3" fill={dim} opacity="0.6" />
      <text x="110" y="36" fill={text} fontSize="8.5" fontWeight="600">
        Lines
      </text>
      <circle cx="174" cy="33" r="2.5" fill={warn} />
      <Bars x={110} y={46} widths={[62, 50, 66, 42]} gap={8} />
      <rect x="108" y="114" width="68" height="18" rx="9" fill="none" stroke={border} strokeWidth="1" />
      <rect x="115" y="121.5" width="30" height="3" rx="1.5" fill={dim} opacity="0.4" />
      <circle cx="167" cy="123" r="6" fill={text} />
      <Glyph icon={IconMicrophone} x={163} y={119} size={8} color={surface} weight={1.1} />

      {/* --- the push alert, floating over it --- */}
      <rect
        x="20" y="52" width="124" height="32" rx="9"
        fill={raised} stroke={border} strokeWidth="1.2"
        filter="url(#fa-shadow)"
      />
      <AppIcon x={28} y={60} size={16} />
      <text x="51" y="66" fill={text} fontSize="8" fontWeight="600">
        Lines
      </text>
      <text x="51" y="77" fill={dim} fontSize="7.5">
        Needs your approval
      </text>
      <circle cx="134" cy="63" r="2.5" fill={warn} />

      {/* --- who else is in the session, and room to invite one more --- */}
      {[
        { cx: 206, letter: 'A' },
        { cx: 220, letter: 'M' },
      ].map((person) => (
        <g key={person.letter}>
          <circle cx={person.cx} cy="34" r="9" fill={raised} stroke={border} strokeWidth="1.5" />
          <text x={person.cx} y="37" textAnchor="middle" fill={text} fontSize="8" fontWeight="600">
            {person.letter}
          </text>
        </g>
      ))}
      <circle cx="234" cy="34" r="9" fill={surface} stroke={border} strokeWidth="1.2" strokeDasharray="2 2" />
      <text x="234" y="37.5" textAnchor="middle" fill={dim} fontSize="10">
        +
      </text>
      <text x="220" y="58" textAnchor="middle" fill={dim} fontSize="7.5">
        live session
      </text>

      {/* --- the machine switcher: several paired, one in use --- */}
      <rect
        x="194" y="76" width="78" height="50" rx="8"
        fill={raised} stroke={border} strokeWidth="1.2"
        filter="url(#fa-shadow)"
      />
      <circle cx="205" cy="93" r="2.5" fill={ok} />
      <text x="212" y="96" fill={text} fontSize="8">
        mac-studio
      </text>
      <line x1="200" y1="103" x2="266" y2="103" stroke={border} />
      <circle cx="205" cy="114" r="2.5" fill={dim} opacity="0.6" />
      <text x="212" y="117" fill={dim} fontSize="8">
        laptop
      </text>
    </Art>
  );
}
