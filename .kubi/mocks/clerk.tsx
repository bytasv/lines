import { createContext, useContext, type ReactNode } from 'react';
import { Avatar, Menu, Text } from '@mantine/core';
import { IconLogout, IconUserCircle } from '@tabler/icons-react';
import { OWNER } from '../fixtures';

// Clerk's provider may exist only once per page and talks to Clerk's API on
// mount; Kubi renders keyless stand-ins instead, signed in as the fixture owner
// (the hosted app's state — see ./clerkConfig, which turns CLERK_ENABLED on).
const Passthrough = ({ children }: { children?: ReactNode }) => <>{children}</>;
const Nothing = () => null;

const initials = OWNER.name
  .split(' ')
  .map((part) => part[0])
  .join('');

/**
 * The account's avatar photo for one subtree (a captured page's scenario, from
 * kubi.config); outside one the avatar is the fixture owner's initials.
 */
const Account = createContext<{ imageUrl?: string; alt?: string } | null>(null);

export function AccountOverride({ value, children }: { value: { imageUrl?: string; alt?: string }; children?: ReactNode }) {
  return <Account.Provider value={value}>{children}</Account.Provider>;
}

/** Clerk's avatar button and its popover, drawn with Mantine: the app's own items sit between Clerk's. */
function UserButtonStandIn({ children }: { children?: ReactNode; afterSignOutUrl?: string }) {
  const account = useContext(Account);
  return (
    <Menu position="bottom-end" width={260} withinPortal>
      <Menu.Target>
        <Avatar
          component="button"
          size={28}
          radius="xl"
          color="blue"
          variant="filled"
          src={account?.imageUrl}
          alt={account?.alt}
          aria-label="Open user menu"
          style={{ border: 0, cursor: 'pointer' }}
        >
          <Text size="xs" fw={600}>
            {initials}
          </Text>
        </Avatar>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>
          <Text size="sm" fw={600} c="var(--mantine-color-text)">
            {OWNER.name}
          </Text>
          <Text size="xs" c="dimmed">
            {OWNER.email}
          </Text>
        </Menu.Label>
        <Menu.Item leftSection={<IconUserCircle size={14} />}>Manage account</Menu.Item>
        {children}
        <Menu.Item leftSection={<IconLogout size={14} />}>Sign out</Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

function ActionStandIn({ label, labelIcon, onClick }: { label: string; labelIcon?: ReactNode; onClick?: () => void }) {
  return (
    <Menu.Item leftSection={labelIcon} onClick={onClick}>
      {label}
    </Menu.Item>
  );
}

export const ClerkProvider = Passthrough;
export const SignedIn = Passthrough;
export const SignedOut = Nothing;
export const SignIn = Nothing;
export const SignInButton = Passthrough;
export const SignUpButton = Passthrough;
export const UserButton = Object.assign(UserButtonStandIn, {
  MenuItems: Passthrough,
  Action: ActionStandIn,
});
export const useAuth = () => ({
  isLoaded: true,
  isSignedIn: true,
  userId: OWNER.userId,
  getToken: async () => null,
});
export const useUser = () => ({
  isLoaded: true,
  isSignedIn: true,
  user: {
    id: OWNER.userId,
    fullName: OWNER.name,
    imageUrl: null,
    primaryEmailAddress: { emailAddress: OWNER.email },
  },
});
