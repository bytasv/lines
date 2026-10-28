import { setOwnerId, setOwnerName } from '../../web/src/lib/clerk';
import { OWNER } from '../fixtures';

export * from '../../web/src/lib/clerk';

// The hosted app runs with Clerk; the header's avatar menu and the owner's own
// name on prompts exist only then. `@clerk/clerk-react` itself is mocked
// (./clerk), so no key is ever used and nothing talks to Clerk.
export const CLERK_PUBLISHABLE_KEY = 'pk_test_kubi_fixture';
export const CLERK_ENABLED = true;

setOwnerId(OWNER.userId);
setOwnerName(OWNER.name);
