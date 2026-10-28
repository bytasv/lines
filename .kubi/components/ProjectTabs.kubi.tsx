import { ProjectTabs } from '../../web/src/components/ProjectTabs';
import { withHeaderBar, withSessionStore } from '../decorators';
import { FIXTURE_PROJECTS } from '../fixtures';

// The header row: brand mark, machine switcher, one tab per open project (the
// kubi tab carries a dot — a session there waits on a permission), the
// open-project menu, plan usage, theme and settings, and the account menu.
export default {
  component: ProjectTabs,
  title: 'Shell/ProjectTabs',
  decorators: [withHeaderBar, withSessionStore],
};

export const ThreeProjects = {};
export const OneProject = {
  parameters: { store: { projects: FIXTURE_PROJECTS.slice(0, 1) } },
};
export const NoProjects = {
  parameters: { store: { projects: [], activeProject: null } },
};
export const AllowlistNeedsReview = {
  parameters: {
    store: {
      // The synced allowlist gained an entry on another machine; the gear's dot asks for a look.
      guardReview: {
        entries: [{ tool: 'Bash', prefix: 'npm test' }, { tool: 'Bash', prefix: 'npx prisma migrate deploy' }],
        added: [{ tool: 'Bash', prefix: 'npx prisma migrate deploy' }],
        removed: [],
        detectedAt: Date.UTC(2026, 9, 12, 9, 40),
      },
    },
  },
};
