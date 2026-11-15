# Composer attachments

## Purpose

Make picking and sending an image from the composer feel immediate, especially over a remote (relay, end-to-end encrypted) link. Large photos are shrunk in the browser before they leave it, a tile appears as soon as a file is picked, and a row tracks the bytes still leaving the browser until the bridge takes the message.

## Entry points

- `web/src/components/Composer.tsx`
- `web/src/ws.ts`
- `web/src/components/QueuedMessages.tsx`

## Files

- `web/src/lib/imageDownscale.ts` (browser canvas work: `prepareAttachment`, `downscaleImage`, image loading and base64 reads)
- `web/src/lib/imageDownscalePolicy.ts` (DOM-free rules: which types are resized, when, and to what size)
- `web/src/lib/recipeImage.ts` (recipe screenshots reuse the same downscale helper)
- `web/src/lib/sendingPrompts.ts` (pure lifecycle of the per-session sending rows)
- `web/src/store.ts` (`sendingPrompts` slice, `restorePrompt`, row clearing on bridge events and queue changes)
- `web/src/ws.ts` (write progress through `bufferedAmount`, sending rows for outgoing prompts, restore on close)
- `web/src/components/Composer.tsx` (pending tiles, Send gating)
- `web/src/components/QueuedMessages.tsx` (`SendingMessages` row list)
- `web/src/components/SessionView.tsx` (mounts `SendingMessages` under the queued rows)
- `shared/types.ts` (`PromptAttachment`, `QueuedPrompt`)

## Symbols

- `prepareAttachment`, `downscaleImage`, `loadImage`, `blobToBase64` (`imageDownscale.ts`)
- `shouldDownscale`, `targetSize`, `withExtension`, `isDownscalableType` (`imageDownscalePolicy.ts`)
- `fileToAttachment` (`Composer.tsx`, kept as a wrapper because `QueuedMessages.tsx` imports it)
- `SendingPrompt`, `SendingPhase`, `startSending`, `progressSending`, `finishSending`, `failSending`, `removeSending`, `clearSent` (`sendingPrompts.ts`)
- `writeToLink` options (`onProgress`, `onDone`, `onFail`), `watchDrain`, `trackPromptSend` (`ws.ts`)
- `restorePrompt` (`store.ts`)
- `SendingMessages` (`QueuedMessages.tsx`)

## Data flow

1. Picking files (button, drop, or paste) puts one spinner tile per file into the tile row straight away. Files are then prepared one after another, so a phone never decodes several large photos at once. Each tile is replaced by its finished attachment as soon as that file is ready.
2. While any file is still pending, Send and ⌘/Enter are disabled.
3. On Send, the prompt goes through `send()`. A prompt with attachments, or one over 256 KB, that is written straight to an open socket gets a sending row before the write. Prompts held back for the handshake or sent to the durable queue get no row.
4. `writeToLink` seals the frame (the row shows "Encrypting…"), writes it, then polls `socket.bufferedAmount` every 250 ms. The row shows the share of bytes that has left the browser.
5. Once the buffer drains, the row reads "Sent". It is removed when the bridge answers for that session: a transcript `event`, or a change to the session's queued or steering list. If neither arrives, it is removed after 15 s.
6. If the socket closes, or sealing fails, before the buffer drains, the row turns to failed. The prompt is restored to the session's draft through `restorePrompt`, which writes the draft and dispatches `lines:prompt-restored` for a mounted composer, and an error message says so.

## Tests

- `server/src/imageDownscale.test.ts` — the resize decision (skip, resize, GIF/SVG untouched), target-size maths, extension swap, and the sending-row lifecycle (start, progress, sent, cleared by a bridge answer, failed, late updates ignored).
- The canvas path and the socket progress path have no automated test. They are verified by hand.

## Business rules

- Only JPEG, PNG, WebP, HEIC and HEIF are ever re-encoded. GIF is never touched, so its animation survives, and SVG and non-image files go out as they are.
- An image of at most 1 MB whose long edge is at most 2048 px is sent byte-identical, so small screenshots stay crisp.
- Anything else is scaled so its long edge is at most 2048 px. The output is JPEG at quality 0.85, except that a PNG stays PNG when the result is at most 1.5 MB, so text in screenshots stays sharp.
- A renamed attachment (`.jpg`) keeps its base name; only the extension changes.
- A file that cannot be decoded (for example HEIC on desktop Chrome) or encoded, or that would come out larger, is sent as its original bytes. Attaching never fails because of resizing.
- Send stays disabled while any picked file is still being prepared. Otherwise a keyboard send would go out without the image.
- A "Sent" row means the bytes left this browser. It does not mean the bridge has them, and the UI says "Sent" rather than "Delivered" for that reason.
- If the connection closes mid-send, the prompt and its attachments return to the draft. The bridge may already have received the frame, so a resend is possible; losing the prompt is treated as the worse outcome.
- Recipe screenshots use the same downscale helper, with their own 2000 px edge and WebP output (see [recipes](recipes.md)).

## Architectural rules

- Resize rules live in the DOM-free policy module so the server's test runner can import them; canvas and `FileReader` code stays in `imageDownscale.ts`.
- Lifecycle transitions for sending rows are pure functions over a map in the store, so the store only wires them to events.
- Progress reporting is optional on `writeToLink`. Callers that pass no callbacks see no change.
- The protocol is unchanged: prompt frames are still one message, and the server still stages attachments as before.

## Related decisions

- [session-and-project-ui](session-and-project-ui.md) — the draft that a restored prompt returns to.
- [end-to-end-encryption](end-to-end-encryption.md) — the sealing step that the "Encrypting…" phase reports.
