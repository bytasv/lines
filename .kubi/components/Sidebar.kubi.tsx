import { Sidebar } from '../../web/src/components/Sidebar';
import { withSessionStore, withSidebarColumn } from '../decorators';
import { FIXTURE_PROJECTS, SESSION_WORKFLOW } from '../fixtures';

// The navbar: new-session controls, the active project's sessions (sorted by
// urgency), the archived group, and the workflow/recipe libraries. It reads the
// seeded store — the Lines project, the idle session selected.
export default {
  component: Sidebar,
  title: 'Shell/Sidebar',
  argTypes: {
    onEditWorkflows: { action: 'editWorkflows' },
    onBrowseRecipes: { action: 'browseRecipes' },
    onNavigate: { action: 'navigated' },
  },
  decorators: [withSidebarColumn, withSessionStore],
};

export const Sessions = {};
export const WorkflowRunSelected = {
  parameters: { store: { selectedSessionId: SESSION_WORKFLOW.id } },
};
export const OtherProject = {
  parameters: { store: { activeProject: FIXTURE_PROJECTS[1].path, selectedSessionId: 'kubi-session-other-project' } },
};
export const EmptyProject = {
  parameters: { store: { activeProject: FIXTURE_PROJECTS[2].path, selectedSessionId: null } },
};
