import { SessionSearchResults } from '../../web/src/components/SessionSearchResults';
import { withSessionStore, withSidebarColumn } from '../decorators';
import { SEARCH_RESULTS } from '../fixtures';

// Find-in-sessions, in the sidebar in place of the session list while a query
// is open: a header per session with hits, then its highlighted snippets.
export default {
  component: SessionSearchResults,
  title: 'Shell/SessionSearchResults',
  argTypes: {
    results: { type: 'object' },
    query: { type: 'string' },
    onNavigate: { action: 'navigated' },
  },
  args: {
    results: SEARCH_RESULTS,
    query: 'backoff',
  },
  decorators: [withSidebarColumn, withSessionStore],
};

export const Matches = {};
export const NoMatches = { args: { results: { sessions: [] }, query: 'websocket compression' } };
