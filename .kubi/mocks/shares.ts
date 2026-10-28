export * from '../../web/src/lib/shares';

// Islands build as development, where the app has no storage server and so no
// sharing. The hosted app has both; the machine switcher and the session
// header's Share action exist only there, so Kubi renders that variant. The
// storage calls behind them answer empty instead of failing.
export const SHARING_ENABLED = true;

export const listShares = async () => ({ granted: [], invites: [], received: [] });
export const pendingInvites = async () => ({ invites: [] });
export const listContacts = async () => ({ contacts: [] });
