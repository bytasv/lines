import type { ReactNode } from 'react';
import { UserButton } from '@clerk/clerk-react';
import { CLERK_ENABLED } from '../lib/clerk';

export interface UserMenuAction {
  label: string;
  icon: ReactNode;
  onClick: () => void;
}

/**
 * Clerk account button in the header; renders nothing in local no-auth mode.
 *
 * `actions` are app items appended to Clerk's own menu, so the header does not
 * need a second overflow menu beside the avatar.
 */
export function UserMenu({ actions = [] }: { actions?: UserMenuAction[] }) {
  if (!CLERK_ENABLED) return null;
  // No children at all when empty: Clerk inspects UserButton's children, and a
  // `false` placeholder is not something it promises to skip.
  if (actions.length === 0) return <UserButton afterSignOutUrl="/" />;
  return (
    <UserButton afterSignOutUrl="/">
      <UserButton.MenuItems>
        {actions.map((action) => (
          <UserButton.Action
            key={action.label}
            label={action.label}
            labelIcon={action.icon}
            onClick={action.onClick}
          />
        ))}
      </UserButton.MenuItems>
    </UserButton>
  );
}
