import type { CSSProperties } from 'react';
import { Text } from '@mantine/core';
import {
  IconBrandAirtable,
  IconBrandAsana,
  IconBrandAws,
  IconBrandCloudflare,
  IconBrandFigma,
  IconBrandGithub,
  IconBrandGitlab,
  IconBrandGoogle,
  IconBrandIntercom,
  IconBrandJira,
  IconBrandMongodb,
  IconBrandNotion,
  IconBrandOpenai,
  IconBrandPaypal,
  IconBrandPrisma,
  IconBrandSentry,
  IconBrandSlack,
  IconBrandStripe,
  IconBrandSupabase,
  IconBrandTrello,
  IconBrandTwilio,
  IconBrandVercel,
  IconBrandWebflow,
  IconBrandZapier,
  type Icon,
} from '@tabler/icons-react';
import logoUrl from '../assets/logo-mark.png';
import { humanizeToolName, mcpProvider, parseMcpToolName, type McpIconKey } from '../lib/mcpTools';

const ICONS: Record<Exclude<McpIconKey, 'lines'>, Icon> = {
  airtable: IconBrandAirtable,
  asana: IconBrandAsana,
  aws: IconBrandAws,
  cloudflare: IconBrandCloudflare,
  figma: IconBrandFigma,
  github: IconBrandGithub,
  gitlab: IconBrandGitlab,
  google: IconBrandGoogle,
  intercom: IconBrandIntercom,
  jira: IconBrandJira,
  mongodb: IconBrandMongodb,
  notion: IconBrandNotion,
  openai: IconBrandOpenai,
  paypal: IconBrandPaypal,
  prisma: IconBrandPrisma,
  sentry: IconBrandSentry,
  slack: IconBrandSlack,
  stripe: IconBrandStripe,
  supabase: IconBrandSupabase,
  trello: IconBrandTrello,
  twilio: IconBrandTwilio,
  vercel: IconBrandVercel,
  webflow: IconBrandWebflow,
  zapier: IconBrandZapier,
};

/**
 * One MCP provider's logo tile: its brand glyph on its brand colour, the Lines
 * mark on white for Lines' own server, or a monogram for a provider with no glyph.
 */
export function McpLogo({
  server,
  size = 16,
  ring,
  style,
}: {
  server: string;
  size?: number;
  /** A border in this colour, for tiles stacked over each other. */
  ring?: string;
  style?: CSSProperties;
}) {
  const p = mcpProvider(server);
  const base: CSSProperties = {
    width: size,
    height: size,
    borderRadius: Math.max(3, Math.round(size * 0.25)),
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#fff',
    background: p.color,
    boxShadow: ring ? `0 0 0 1.5px ${ring}` : undefined,
    overflow: 'hidden',
    ...style,
  };
  if (p.icon === 'lines') {
    return (
      <span aria-hidden style={{ ...base, background: '#fff' }}>
        <img src={logoUrl} alt="" style={{ width: '78%', height: '78%', objectFit: 'contain' }} />
      </span>
    );
  }
  const Glyph = p.icon ? ICONS[p.icon] : null;
  return (
    <span aria-hidden style={base}>
      {Glyph ? (
        <Glyph size={Math.round(size * 0.72)} stroke={1.8} />
      ) : (
        <span
          style={{
            fontSize: Math.max(7, Math.round(size * (p.monogram.length > 1 ? 0.45 : 0.58))),
            fontWeight: 700,
            lineHeight: 1,
            letterSpacing: p.monogram.length > 1 ? -0.3 : 0,
          }}
        >
          {p.monogram}
        </span>
      )}
    </span>
  );
}

/**
 * An MCP tool name as people read it: logo, dimmed provider, then the tool in
 * bold (`[logo] Linear · Create issue`). The raw `mcp__…` name is the tooltip.
 * Renders the raw name as-is for a tool that isn't MCP.
 */
export function McpToolLabel({
  tool,
  size = 16,
  color,
}: {
  /** The tool's full name, `mcp__<server>__<tool>`. */
  tool: string;
  size?: number;
  /** Text colour for the whole label (a failed call reads red). */
  color?: string;
}) {
  const parsed = parseMcpToolName(tool);
  if (!parsed) return <span title={tool}>{tool}</span>;
  return (
    <span
      title={tool}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, flexShrink: 0, maxWidth: '60%' }}
    >
      <McpLogo server={parsed.server} size={size} />
      <Text span size="xs" c={color ?? 'dimmed'} style={{ flexShrink: 0 }}>
        {mcpProvider(parsed.server).label} ·
      </Text>
      <Text span size="xs" fw={600} c={color} truncate>
        {humanizeToolName(parsed.tool)}
      </Text>
    </span>
  );
}
