import { SkewBanner } from '../../web/src/components/SkewBanner';
import { withHeaderBar, withSessionStore } from '../decorators';

// The grape pill: this tab and its bridge disagree on the wire protocol
// (the app speaks v6). Which half is older decides the wording and the Reload.
export default {
  component: SkewBanner,
  title: 'Shell/Banners/SkewBanner',
  argTypes: {
    headerHeight: { type: 'number' },
  },
  args: { headerHeight: 56 },
  decorators: [withHeaderBar, withSessionStore],
  parameters: { store: { protocolSkew: true, bridge: { version: '0.1.26', appProtocol: 7 } } },
};

export const TabIsOlder = {};
export const MachineIsOlder = {
  parameters: { store: { protocolSkew: true, bridge: { version: '0.1.19', appProtocol: 5 } } },
};
