import { UsageIndicator } from '../../web/src/components/UsageIndicator';
import { withSessionStore } from '../decorators';
import { CLAUDE_USAGE_NEAR_LIMIT } from '../fixtures';

// One ring per signed-in provider, in the header; hovering opens the plan's
// windows, extra usage and spend. Reads `usage` / `openaiUsage` / `auth` from
// the store (seeded: Claude Max at 34% of the 5-hour window, ChatGPT Pro at 12%).
export default {
  component: UsageIndicator,
  title: 'Shell/UsageIndicator',
  decorators: [withSessionStore],
};

export const BothProviders = {};
export const ClaudeOnly = { parameters: { store: { openaiAuth: null, openaiUsage: null } } };
export const NearLimit = {
  parameters: { store: { usage: CLAUDE_USAGE_NEAR_LIMIT, openaiAuth: null, openaiUsage: null } },
};
/** Signed in, before the first usage reading lands: an empty ring. */
export const NoReadingYet = { parameters: { store: { usage: null, openaiAuth: null, openaiUsage: null } } };
