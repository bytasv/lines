import { UserButton } from '@clerk/clerk-react';
import { CLERK_ENABLED } from '../lib/clerk';

/** Clerk account button in the header; renders nothing in local no-auth mode. */
export function UserMenu() {
  if (!CLERK_ENABLED) return null;
  return <UserButton afterSignOutUrl="/" />;
}
