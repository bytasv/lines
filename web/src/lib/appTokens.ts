/**
 * The app's design tokens, carried into a sandboxed HTML frame (HtmlFrame) so an
 * agent-written mock reads as "in the app's palette": every Mantine CSS custom
 * property as currently computed, plus the colour scheme.
 *
 * `withAppTokens` is pure string work and is tested from the server workspace
 * (server/src/uiProposal.test.ts). It never parses or sanitises the agent's HTML
 * — the frame's opaque-origin sandbox is the boundary — it only adds one
 * `<style>` and the colour-scheme attribute.
 */

export type ColorScheme = 'light' | 'dark';

export interface AppTokens {
  /** `--mantine-*` custom properties and their computed values. */
  vars: Record<string, string>;
  colorScheme: ColorScheme;
}

const TOKEN_PREFIX = '--mantine-';

/**
 * Read the live tokens off the document root. Names come from the computed style
 * where the engine enumerates custom properties, and from the root rules of the
 * app's own stylesheets where it does not; values always come from the computed
 * style, so `var()` references and the scheme-specific overrides are resolved.
 */
export function readAppTokens(): AppTokens {
  const root = document.documentElement;
  const computed = getComputedStyle(root);
  const names = new Set<string>();
  for (let i = 0; i < computed.length; i++) {
    const name = computed.item(i);
    if (name.startsWith(TOKEN_PREFIX)) names.add(name);
  }
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cross-origin sheet
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSStyleRule) || !rule.selectorText.includes(':root')) continue;
      for (let i = 0; i < rule.style.length; i++) {
        const name = rule.style.item(i);
        if (name.startsWith(TOKEN_PREFIX)) names.add(name);
      }
    }
  }
  const vars: Record<string, string> = {};
  for (const name of names) {
    const value = computed.getPropertyValue(name).trim();
    if (value) vars[name] = value;
  }
  const colorScheme: ColorScheme = root.getAttribute('data-mantine-color-scheme') === 'light' ? 'light' : 'dark';
  return { vars, colorScheme };
}

const HEAD_OPEN = /<head(?:\s[^>]*)?>/i;
const HTML_OPEN = /<html(?:\s[^>]*)?>/i;
const DOCTYPE = /^\s*<!doctype[^>]*>/i;
const SCHEME_ATTR = /\sdata-mantine-color-scheme\s*=/i;

/** The injected `<style>`: tokens on `:root`, and the body set in the app's type and colours. */
function tokenStyle(tokens: AppTokens): string {
  // Values are the app's own CSS; `<`, `;` and braces are dropped anyway so none can
  // close the tag or the rule.
  const decls = Object.entries(tokens.vars)
    .filter(([name]) => /^--[\w-]+$/.test(name))
    .map(([name, value]) => `${name}:${value.replace(/[<;{}]/g, '')}`)
    .join(';');
  return (
    '<style data-lines-app-tokens>' +
    `:root{${decls}${decls ? ';' : ''}color-scheme:${tokens.colorScheme}}` +
    'body{font-family:var(--mantine-font-family);background:var(--mantine-color-body);' +
    'color:var(--mantine-color-text);margin:0}' +
    '</style>'
  );
}

/**
 * `html` with the app's tokens injected, first in `<head>` so the agent's own CSS
 * still wins. A document gets the style after its `<head>` (or a new `<head>`
 * after `<html>`) and the colour-scheme attribute on `<html>` unless it set one;
 * a fragment is wrapped in a full document.
 */
export function withAppTokens(html: string, tokens: AppTokens): string {
  const style = tokenStyle(tokens);
  const schemeAttr = ` data-mantine-color-scheme="${tokens.colorScheme}"`;
  const head = HEAD_OPEN.exec(html);
  const htmlTag = HTML_OPEN.exec(html);

  if (!head && !htmlTag) {
    const doctype = DOCTYPE.exec(html);
    const body = doctype ? html.slice(doctype[0].length) : html;
    return (
      `<!doctype html><html${schemeAttr}><head><meta charset="utf-8">` +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      `${style}</head><body>${body}</body></html>`
    );
  }

  const inserts: { at: number; text: string }[] = [];
  if (head) inserts.push({ at: head.index + head[0].length, text: style });
  else if (htmlTag) inserts.push({ at: htmlTag.index + htmlTag[0].length, text: `<head>${style}</head>` });
  if (htmlTag && !SCHEME_ATTR.test(htmlTag[0])) inserts.push({ at: htmlTag.index + '<html'.length, text: schemeAttr });
  // Back to front, so each earlier index stays valid.
  let out = html;
  for (const { at, text } of inserts.sort((a, b) => b.at - a.at)) out = out.slice(0, at) + text + out.slice(at);
  return out;
}
