/**
 * How the two halves of Lines fit together, drawn.
 *
 * The pairing screen is the one moment a user has to understand the split — why
 * a website is asking them to run something on their own computer — so this
 * makes the trust boundary visible instead of describing it in prose they will
 * skip: the agent and their files stay local, and the machine dials out, so
 * nothing needs an open port.
 *
 * Inline SVG with Mantine CSS variables rather than an asset, so it tracks the
 * colour scheme and needs no build step.
 */
export function PairingDiagram() {
  const border = 'var(--mantine-color-default-border)';
  const text = 'var(--mantine-color-text)';
  const dim = 'var(--mantine-color-dimmed)';
  const accent = 'var(--mantine-primary-color-filled)';

  return (
    <svg
      // Cropped to the drawn content (labels start at y≈48) so the card does not
      // carry 40px of dead space above the boxes.
      viewBox="0 42 660 198"
      width="100%"
      role="img"
      aria-label="This browser talks to the Lines relay, which forwards to Lines running on your own machine, where Claude Code and your files stay."
      style={{ display: 'block' }}
    >
      <defs>
        <marker id="pd-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={dim} />
        </marker>
      </defs>

      {/* --- browser --- */}
      <g>
        <rect x="8" y="70" width="180" height="86" rx="10" fill="none" stroke={border} strokeWidth="1.5" />
        {/* Window chrome, so the box reads as a browser without a caption. */}
        <line x1="8" y1="94" x2="188" y2="94" stroke={border} strokeWidth="1.5" />
        <circle cx="24" cy="82" r="3" fill={dim} />
        <circle cx="36" cy="82" r="3" fill={dim} />
        <circle cx="48" cy="82" r="3" fill={dim} />
        <text x="98" y="122" textAnchor="middle" fill={text} fontSize="14" fontWeight="600">
          This browser
        </text>
        <text x="98" y="141" textAnchor="middle" fill={dim} fontSize="11">
          the interface
        </text>
      </g>

      {/* --- relay --- */}
      <g>
        <rect x="240" y="70" width="180" height="86" rx="10" fill="none" stroke={border} strokeWidth="1.5" />
        <text x="330" y="104" textAnchor="middle" fill={text} fontSize="14" fontWeight="600">
          Lines relay
        </text>
        <text x="330" y="124" textAnchor="middle" fill={dim} fontSize="11">
          passes messages through
        </text>
        <text x="330" y="140" textAnchor="middle" fill={dim} fontSize="11">
          never stores your code
        </text>
      </g>

      {/* --- your machine --- */}
      <g>
        <rect x="472" y="70" width="180" height="86" rx="10" fill="none" stroke={accent} strokeWidth="2" />
        <text x="562" y="104" textAnchor="middle" fill={text} fontSize="14" fontWeight="600">
          Your machine
        </text>
        <text x="562" y="124" textAnchor="middle" fill={dim} fontSize="11">
          Claude Code runs here
        </text>
        <text x="562" y="140" textAnchor="middle" fill={dim} fontSize="11">
          your files stay here
        </text>
      </g>

      {/* --- browser <-> relay --- */}
      <line
        x1="196" y1="113" x2="232" y2="113"
        stroke={dim} strokeWidth="1.5"
        markerStart="url(#pd-arrow)" markerEnd="url(#pd-arrow)"
      />
      {/* Both link labels sit above the boxes (which start at y=70) and above the
          boundary line (which starts at y=66), so nothing overlaps. */}
      <text x="214" y="58" textAnchor="middle" fill={dim} fontSize="10">
        wss
      </text>

      {/* --- machine -> relay: dashed and one-directional at the tail, because the
              machine opens the connection. That is the whole reason no port needs
              to be forwarded, and the arrow direction is what says it. --- */}
      <line
        x1="464" y1="113" x2="428" y2="113"
        stroke={dim} strokeWidth="1.5" strokeDasharray="4 3"
        markerEnd="url(#pd-arrow)"
      />
      <text x="446" y="58" textAnchor="middle" fill={dim} fontSize="10">
        dials out
      </text>

      {/* --- the boundary the user is actually being asked about --- */}
      <line x1="446" y1="66" x2="446" y2="200" stroke={border} strokeWidth="1" strokeDasharray="2 4" />
      {/* Centred on each zone (8→446 and 446→652), not on a box: they label the
          side of the boundary, not the thing directly above them. */}
      <text x="227" y="188" textAnchor="middle" fill={dim} fontSize="10">
        hosted
      </text>
      <text x="549" y="188" textAnchor="middle" fill={dim} fontSize="10">
        yours
      </text>

      <text x="330" y="226" textAnchor="middle" fill={dim} fontSize="11">
        Pairing tells the relay which machine is yours. Nothing runs until it connects.
      </text>
    </svg>
  );
}
