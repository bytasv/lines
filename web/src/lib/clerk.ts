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

/** Current user's Clerk id, used to tag steps this user publishes. Null in no-auth mode. */
let ownerId: string | null = null;
export function setOwnerId(id: string | null): void {
  ownerId = id;
}

/**
 * The owner id the bridge itself stamps onto everything it stores, learned from
 * `hello`. Preferred over the Clerk id because it is the one that ends up in
 * `StepDef.ownerId`: the bridge uses `ctx.userId`, which is the literal `local`
 * with bridge auth off — and the browser's Clerk id is `''` when Clerk is
 * disabled in the web build. Stamping refs with the browser's guess is what made
 * a ref point at an owner no step was ever saved under.
 */
let bridgeOwnerId: string | null = null;
export function setBridgeOwnerId(id: string | null): void {
  bridgeOwnerId = id;
}
export function getOwnerId(): string | null {
  return bridgeOwnerId ?? ownerId;
}

/**
 * Current user's Clerk avatar, for attributing their own prompts.
 *
 * The bridge cannot supply this: it records an actor for the owner but has no
 * Clerk lookup for itself, so `name` and `imageUrl` arrive null and the client is
 * the only place that knows them. Without this, your own messages render as
 * initials while everyone else's show a picture.
 */
let ownerImageUrl: string | null = null;
export function setOwnerImageUrl(url: string | null): void {
  ownerImageUrl = url;
}
export function getOwnerImageUrl(): string | null {
  return ownerImageUrl;
}
