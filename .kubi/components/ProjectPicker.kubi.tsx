import { ProjectPicker } from '../../web/src/components/ProjectPicker';
import { withMainArea, withSessionStore } from '../decorators';
import { DEVICE_ID, MACHINE_SLICE } from '../fixtures';

// The main area when no project is open: Browse… (on the machine itself), a
// typed path, and the recent folders.
export default {
  component: ProjectPicker,
  title: 'Shell/ProjectPicker',
  decorators: [withMainArea, withSessionStore],
};

export const OnThisMachine = {};
/** From a phone or another laptop Finder would open on nobody's screen, so Browse… is gone. */
export const Remote = {
  parameters: { store: { machines: { [DEVICE_ID]: { ...MACHINE_SLICE, local: false } } } },
};
export const FirstRun = { parameters: { store: { recentDirs: [] } } };
