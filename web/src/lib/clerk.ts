/**
 * Clerk is optional: without a publishable key the app runs in single-user
 * local mode (no sign-in gate, no token on the socket) — matching a bridge
 * started without CLERK_SECRET_KEY / with BRIDGE_AUTH_DISABLED=1.
 */
export const CLERK_PUBLISHABLE_KEY: string | undefined = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
export const CLERK_ENABLED = Boolean(CLERK_PUBLISHABLE_KEY);

/**
 * Current user's display label (name→email), set by the authed root once Clerk
 * resolves. Read synchronously so components need no Clerk hook — null in
 * local no-auth mode, where there is no owner to attribute a workflow to.
 */
let ownerName: string | null = null;
export function setOwnerName(name: string | null): void {
  ownerName = name;
}
export function getOwnerName(): string | null {
  return ownerName;
}
