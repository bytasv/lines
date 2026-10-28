import { App } from '../../web/src/App';
import { withAppWindow, withSessionStore } from '../decorators';
import {
  SESSION_EMPTY,
  SESSION_IDLE,
  SESSION_RUNNING,
  SESSION_WAITING,
  SESSION_WORKFLOW,
} from '../fixtures';

// The whole main page: App routes `/session/:id` (and everything else but
// /docs) to its Shell — the AppShell with ProjectTabs in the header, the status
// pills, Sidebar in the navbar and SessionView in the main area. Shell is not
// exported, so App is the component.
//
// Each story pins its own selection with `parameters.store`, so two App
// instances on the canvas never pull each other's URL along (the Shell syncs
// URL and store both ways). `router.initialEntries` is the URL it opens at.
const at = (sessionId: string | null) => ({
  router: { initialEntries: [sessionId ? `/session/${sessionId}` : '/'] },
  store: { selectedSessionId: sessionId },
});

export default {
  component: App,
  title: 'Shell/App',
  decorators: [withAppWindow, withSessionStore],
  parameters: at(SESSION_IDLE.id),
};

export const SessionOpen = {};
export const Running = { parameters: at(SESSION_RUNNING.id) };
export const WaitingPermission = { parameters: at(SESSION_WAITING.id) };
export const WorkflowRun = { parameters: at(SESSION_WORKFLOW.id) };
export const NewSession = { parameters: at(SESSION_EMPTY.id) };
export const NoSessionSelected = { parameters: at(null) };
export const NoProjectOpen = {
  parameters: {
    router: { initialEntries: ['/'] },
    store: { selectedSessionId: null, projects: [], activeProject: null },
  },
};
export const Offline = {
  parameters: {
    ...at(SESSION_IDLE.id),
    store: { selectedSessionId: SESSION_IDLE.id, connectionStatus: 'offline' },
  },
};
