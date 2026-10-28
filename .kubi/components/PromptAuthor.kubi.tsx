import { PromptAuthor } from '../../web/src/components/PromptAuthor';
import { ADA } from '../fixtures';

// A small inline avatar, so the photo story needs no network.
const PHOTO =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44"><rect width="44" height="44" fill="#2b8a3e"/><circle cx="22" cy="17" r="8" fill="#d3f9d8"/><path d="M6 44c2-10 9-15 16-15s14 5 16 15z" fill="#d3f9d8"/></svg>',
  );

/**
 * The avatar beside a user prompt. Who it shows comes from `actor` through the
 * app's identity resolver; hover it for the name and the time the prompt was sent.
 */
export default {
  component: PromptAuthor,
  title: 'Transcript/PromptAuthor',
  argTypes: {
    actor: { type: 'object', description: 'Who sent the prompt: { userId, name, imageUrl }. Absent means the session host.' },
    ts: { type: 'number', description: 'When the prompt was sent, in epoch milliseconds.' },
  },
  args: {
    actor: ADA,
    ts: Date.UTC(2026, 9, 12, 9, 30),
  },
};

export const Collaborator = {};

export const WithPhoto = {
  args: { actor: { userId: 'user_fixture_grace', name: 'Grace Hopper', imageUrl: PHOTO } },
};

/** An actor with no attested name falls back to a shortened user id. */
export const UnnamedActor = {
  args: { actor: { userId: 'user_fixture_7f3k2q9x', name: null, imageUrl: null } },
};

/** No actor: an older row or the host's own prompt. */
export const Host = { args: { actor: undefined } };
