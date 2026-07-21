---
name: verify
description: Drive the running Lines web app to verify UI changes end-to-end.
---

# Verifying Lines UI changes

- Dev stack usually already running (user dogfoods): vite on `http://localhost:5173`, bridge HTTP on 8787, server on 8788. Check with `lsof -nP -iTCP -sTCP:LISTEN | grep node`. If not: `npm run dev` at repo root (worker+server+web via concurrently).
- Vite HMR picks up `web/src` edits live — no rebuild needed.
- No test runner in `web/`; only `npm run typecheck`.
- Drive with Playwright from a scratch dir (`npm i playwright` + `npx playwright install chromium-headless-shell`; system cache may hold stale browser builds).
- To exercise a transcript: click "New session" (starts in the repo dir), fill the `textarea`, press Enter. Message renders immediately in the user bubble; assistant reply costs one real Claude turn (~$0.10) and lands in the session auto-titled from the prompt — the sidebar reorders, so relocate by title, not position.
- Gotcha: finished agent replies are folded inside a collapsed "response" row — the markdown is in the DOM but `element is not visible` to Playwright. Click the `response` toggle before hovering/asserting inside it.
- Mantine HoverCard dropdowns portal to body: assert via `.mantine-HoverCard-dropdown` after `.hover()` + ~700ms.
