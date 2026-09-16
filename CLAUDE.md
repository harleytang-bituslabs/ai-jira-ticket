# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read first

- **[HANDOFF.md](HANDOFF.md)** — current state, open TODOs, traps already hit, and the owner's collaboration preferences. Read it before any non-trivial change.
- **[README.md](README.md)** — what the product does, permission matrix, full env-var reference, deployment.

Both are in Chinese and kept current; this file only holds what they don't: commands, the architecture invariants, and the rules that constrain how changes get made here.

## Commands

```bash
npm test                          # vitest run — full suite
npx vitest run test/server.test.ts            # single file
npx vitest run test/server.test.ts -t "name"  # single test by name
npm run typecheck                 # tsc --noEmit for src+test+scripts AND for web/ (two passes)

npm run build:web                 # vite build → web/dist (Express serves it from disk; no restart needed)
npm run web                       # start the server (reads .env)
npm run dev:web                   # vite dev server, proxies /api → :9300

npm run ajt -- sync-spec          # refresh .cache/spec.md + project meta from Confluence/Jira
npm run fetch-issues              # board snapshot → .cache/issues.json
npm run fetch-users               # project participants → .cache/users.json
npm run ajt -- draft "..."        # CLI personal mode (no login, no S3)
npm run ajt -- submit drafts/x.json   # --dry-run / --yes / --force
```

There is no build step for the backend — `tsx` runs the TypeScript sources directly, in dev and in the container.

**IDE diagnostics go stale after rapid edits.** Judge type errors only by running `npm run typecheck`.

## Architecture

Request path: `routes/ → services/ → stores/`, with `src/core/` as a pure library that knows nothing about HTTP and is shared by both the server and the CLI.

```
src/clients/   Atlassian HTTP (fetch + Basic auth): confluence (page→markdown), jira (createmeta/create/link/users)
src/llm/       Anthropic structured outputs (messages.parse + zodOutputFormat + prompt cache)
src/core/      config · schema · spec-cache · sync-spec · draft · submit · render
src/stores/    DraftStore (Fs | S3, one folder per owner) · UserStore (users.json, 30s cache) · CacheStore (Fs | S3 `cache/`, shared, 60s memo)
src/server/    index (bootstrap) · app (middleware chain + routes) · session · middlewares · services · routes
src/cli/       commander shell over src/core
web/           React + Vite + TS; pages/ + components/; built to web/dist
```

### Invariants — breaking these has caused real bugs

- **`src/core/schema.ts` is the type hub.** Tickets reference each other by `localId` (`"t1"`) because Jira keys don't exist until submit; `submit` topologically sorts, creates parents first, and writes the real keys back. Two schema layers: the plain object shape sent to the LLM, and the same shape plus cross-field refinements (localId uniqueness, dangling refs, parent cycles) validated locally after generation and again before submit.
- **`services/policy.ts::enforcePolicy` is the only place permission rules live.** It runs on all three write paths (generate / save / submit). Never add a parallel check in a route; the frontend only hides things. Its `assertBoardVisible` half is exported separately because the generate path must reject before the LLM call — `enforcePolicy` runs there only as a post-generation backstop.
- **Board visibility comes from the account's `boards` list, and nothing else.** Empty means the user cannot create tickets; admins are exempt (an admin with an empty list still sees everything, or the first admin would lock themselves out). The `team` field bounds an l2's assignment range: `teamRoster` in policy.ts allows only active same-team accounts (self only when no team is set), and `/api/meta` narrows the picker roster per level — l1 self, l2 team, admin full participants. People without an ajt account are outside every l2's range by design.
- **The shared reference cache (spec / project meta / board snapshot / roster) lives behind `CacheStore`** — a local directory for the CLI, one flat `cache/` prefix in S3 for the web service. It is deliberately *not* per-user: everybody reads the same objects, which is what lets a container serve immediately instead of re-pulling from Atlassian at boot. S3 reads go through a 60s in-process TTL memo (issues.json and spec.md are ~150KB each), and a write refreshes the memo so the admin who just refreshed never sees stale data.
- **The assignee roster is per-project** — the distinct assignees and reporters across the project's issue history (`listProjectParticipants`). Do not reach for `/user/assignable/search` or `/users/search`: measured on this site, assignable returns 63 identical accounts for all 26 projects, so it distinguishes nothing. Two consequences are by design: somebody never given a ticket here is absent from the picker (which is why it accepts a typed-in email, and why `/api/meta` always folds in the caller), and people who moved on linger until someone ages them out. The server deliberately does not validate assignees against the roster — Jira rejects unassignable accounts at create time.
- **A draft record's id is fixed at creation.** `store.write(owner, draft, id?)` — updates must pass the original id, or the id gets re-derived from creation time + first ticket summary and renaming a ticket spawns a duplicate record. Two tests anchor this (`test/stores.test.ts`, `test/server.test.ts`); don't remove them.
- **Drafts are the history.** `drafts/{owner}/{id}.json` is the single source of truth; submit writes `jiraKey`/`jiraUrl` back, which is what flips a record to "submitted". Deleting history deletes only the record — never touch Jira issues.
- **Sessions are stateless and header-only.** Login returns an HMAC token (email + expiry) that the frontend keeps in per-tab `sessionStorage` and sends as `Authorization: Bearer` — which is what lets one computer hold several accounts at once. Never reintroduce a cookie (even as a fallback): cookies are browser-wide, so the last login would silently take over every tab without its own token. Level and `active` are read from the user store per request, so deactivation takes effect within 30s.
- **Cache warm-up must happen after `listen`.** `void ensureCaches(config, cache)` sits inside the listen callback in [src/server/index.ts](src/server/index.ts) — moving it earlier makes container platforms fail the `/healthz` deploy check.
- **The system prompt must stay byte-identical across calls** (it embeds `.cache/spec.md` verbatim) so the Anthropic prompt cache hits.
- Account ids may be an email *or* a plain username, gated by `ACCOUNT_ID_RE`; it doubles as an S3 key prefix, so path-traversal shapes are rejected.

### Jira constraints that are settled, not open questions

- `reporter` cannot be set on this project (not on the create/edit screen). It was removed end-to-end — don't reintroduce it.
- Bug-type required custom fields (Severity / Source / Detected Environment / Affects Version) aren't submittable; the AI writes them into the description and flags them in `notes`.
- "Start date" is the custom field `customfield_10015`, configured as `startDateField` in `config.json`; empty means don't send.
- Story/Task must be created under an Epic; Sub-tasks require `assignee` and `dueDate` and carry no priority.

## Working on this repo

From the owner's stated preferences (HANDOFF §9) — these override default agent behavior:

- **Get agreement before changing code.** State what you intend to change and its blast radius first.
- **Do not commit or push on his behalf.** Finish a chunk, then hand him the full commit command including the message.
- Work in stages: end each stage with green tests plus the commit command, and wait for "继续" before the next.
- Prefer refactoring over stacking patches; he has explicitly authorized cleanup when it's warranted.
- On UI work the acceptance bar is equivalent migration — don't redesign visually on your own initiative.
- Every page must degrade gracefully when the window is narrow (his standing requirement): rows wrap instead of overflowing, wide tables scroll inside an `overflow-x:auto` wrapper (note that wrapper clips absolutely-positioned dropdowns — BoardPicker uses `position:fixed` for this reason), and the 80% page width switches to full-width-minus-margin below 860px.

Shared dev server, so:

- **Never modify global git config.** Repo-level only.
- `git push`: the global helper is `cache --timeout=3600`, so it hands over **whichever token was typed last**. If that was a colleague's, the push 403s — then, and only then, use `git -c credential.helper= push`. If Harley has pushed within the hour, plain `git push` works and is correct; clearing the helper in that case throws away the one usable credential and fails with `could not read Username`. Check `git log -1 --format=%an` on the remote ref's reflog (`.git/logs/refs/remotes/origin/<branch>`) to see who pushed last. Don't delete `/tmp/git-creds-*`.
- `pgrep -f`/`pkill -f` patterns can match the invoking shell and kill it. Use `"tsx src/serve[r]"`, and put the kill and the restart in *separate* tool calls.
