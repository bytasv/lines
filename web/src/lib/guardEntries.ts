import type { GuardEntryError } from '@lines/shared';

/**
 * Tool names offered in the Settings add form. Only a hint — the field stays free
 * text because `mcp__server__tool` names cannot be enumerated here, and a user
 * allowlisting an MCP tool has to be able to type its exact name.
 *
 * ALWAYS_ASK tools are absent by construction: the shared validator refuses them.
 */
export const GUARD_TOOL_SUGGESTIONS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'WebFetch',
  'Task',
];

/** Plain-language form copy for each refusal the shared validator can return. */
const GUARD_ENTRY_ERROR_TEXT: Record<GuardEntryError, string> = {
  'empty-tool': 'Enter a tool name',
  'bad-tool': 'Tool names are letters, digits, dots, dashes and underscores',
  'always-ask': "This tool always asks and can't be allowlisted",
  'bash-needs-prefix': 'Bash needs a command prefix, e.g. “npm run”',
  'prefix-chained': 'A prefix can’t contain &&, ||, ; or |',
  'prefix-too-long': 'That prefix is too long',
};

export function guardEntryErrorText(error: GuardEntryError): string {
  return GUARD_ENTRY_ERROR_TEXT[error];
}

/**
 * True for a single-token Bash prefix like `git`, which allows every subcommand.
 * Not an error — sometimes exactly what the user wants — so it renders as a warning.
 */
export function isBroadBashPrefix(prefix: string): boolean {
  return prefix.trim().split(/\s+/).filter(Boolean).length === 1;
}
