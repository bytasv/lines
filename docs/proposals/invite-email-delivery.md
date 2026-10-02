# Invite email delivery

Status: **proposed, not built.** Written down while preparing the landing page
and privacy story, because the collaboration loop is Lines' one built-in referral
path and this is the step where it leaks.

## What is missing

[Session collaboration](../codebase/features/session-collaboration.md) already
supports invites by email: `POST /v1/shares/invite` stores a `ShareInvite` with
`inviteeEmail`, only that address's *verified* Clerk email can claim it, and the
invitee's pairing screen discovers it through `GET /v1/shares/pending` once they
sign in. `ShareContact` remembers the address for next time.

Nothing ever tells the invitee. Lines sends no email at all, so an email invite
works only if the invitee already knows to sign in, or the owner copies the
`/join/<code>` link out of the share modal and sends it themselves. The "email"
in "invite by email" is a claim rule, not a delivery channel.

## Why it is worth doing

- **Growth.** Every invite reaches someone who is, by definition, near a coding
  agent user. Today that path depends on the sender doing a second, manual step.
- **Clarity.** A user who types an address into the share modal reasonably
  expects a message to arrive. The modal has to explain that it will not.

## Options

1. **A transactional email provider**, on its free tier (Resend, Postmark or
   similar). Least work and good deliverability: one API call from storage on
   invite mint, with SPF/DKIM set up on the sending domain. Adds a third party
   that sees recipient addresses and message content.
2. **SMTP configured by the operator.** Storage speaks SMTP to whatever server
   the deployment names. Fits self-hosting well (no new vendor for them), but
   deliverability is the operator's problem, and the hosted service would still
   need a provider behind it.
3. **Leave it as link copy.** No new dependency or privacy row. Improve the
   share modal's wording and make "Copy link" the primary action instead.

Options 1 and 2 are not exclusive: a provider for the hosted service, SMTP for
self-hosters, the same code path behind an interface.

## Privacy impact

The invitee's address, the owner's display name, and the invite link would pass
through the email provider. If this ships, [PRIVACY.md](../../PRIVACY.md) gets a
row for the provider under third-party services, in the same change. The message
should carry no session content: name the owner and the machine or session
name, nothing from the transcript.

## Abuse controls

An unauthenticated recipient receiving mail on a signed-in user's say-so is a
spam channel unless it is bounded:

- **Rate limits** per owner (per hour and per day) and per recipient address,
  enforced in storage rather than in the web app.
- **Sender verification:** only owners with a verified Clerk email can trigger
  a send, and the message names that address so the recipient can judge it.
- **Unsubscribe path:** a one-click opt-out per recipient address, stored
  server-side, that suppresses all future invite mail to it. The link flow
  still works for that person.
- **No re-send storm:** one email per invite; a reminder, if any, is an explicit
  owner action with its own limit.

## Open decisions

- Which provider for the hosted service.
- Templates: plain text only, or HTML as well; and who owns their wording.
- Whether email delivery is optional for self-hosters (likely yes, off unless
  configured, falling back to option 3's wording).
- Whether an invite to an address that already has a Lines account should email
  at all, or rely on the in-app pending-invite card.

## Related

- [Session collaboration](../codebase/features/session-collaboration.md)
- [PRIVACY.md](../../PRIVACY.md)
