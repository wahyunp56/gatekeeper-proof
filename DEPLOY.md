# DEPLOY.md — getting the Gatekeeper live on Vercel

Target: replace the current echo handler on the existing Vercel project
**`gatekeeper-proof`** (team `wahyunp56`, Hobby free, no card) so that
`https://gatekeeper-proof.vercel.app/gatekeeper` runs the real Gatekeeper,
in time for **Round 4, which opens Mon 16 Nov 17:30 WIB**.

## Why this route (and not `git push` / `vercel deploy`)

Checked 2026-11-15 on this VM:

- `gh` is **not logged in** and there is no `~/.git-credentials` — no way to
  push to `https://github.com/wahyunp56/gatekeeper-proof` from the shell.
  The GitHub password is unknown (set via a reset link in a browser task and
  never saved) — do not try to guess it.
- The Vercel CLI exists but has no token on this VM (the Vercel account was
  created in a browser session), so `vercel deploy` cannot authenticate.
- The Vercel project is already connected to the GitHub repo (branch `main`)
  and **auto-deploys on every push to main**. So the deploy path is:
  **put these files into the repo → Vercel deploys automatically**.

That means the file transfer has to go through a browser task using the
GitHub web UI (the browser is signed in to GitHub as `wahyunp56` and to
Vercel). The steps below are written for that browser task.

## Step 1 — put the code into the repo (browser task, GitHub web UI)

Repo: https://github.com/wahyunp56/gatekeeper-proof (branch `main`).
Current content: `vercel.json`, `api/health.js`, `api/gatekeeper.js` (echo only).

Local source of truth: `~/workspace/agent-games/gatekeeper/` on this VM.
The browser task needs the file contents — the parent can read them from
disk and paste them into the GitHub web editor, or use "Upload files" for
the whole folder.

**Replace these files** (open the file on GitHub → pencil icon → replace the
entire contents → Commit directly to `main`):

| Repo path | Local file | Notes |
|---|---|---|
| `vercel.json` | `vercel.json` | Adds `functions` (maxDuration 60, `includeFiles: circuits/**`) and keeps the `/health` + `/gatekeeper` rewrites |
| `api/gatekeeper.js` | `api/gatekeeper.js` | Full handler (replaces the echo) |
| `api/health.js` | `api/health.js` | Readiness + self-test (replaces the echo) |
| `package.json` | `package.json` | **New file** — `snarkjs 0.7.6` + `js-sha3 0.14.0`; Vercel runs `npm install` at build |

**Create these files** ("Add file → Create new file", one per path):

| Repo path | Local file |
|---|---|
| `lib/hmac.js` | `lib/hmac.js` |
| `lib/field.js` | `lib/field.js` |
| `lib/snark.js` | `lib/snark.js` |
| `lib/decide.js` | `lib/decide.js` |
| `lib/prove.js` | `lib/prove.js` |
| `lib/kurier.js` | `lib/kurier.js` |
| `README.md` | `README.md` |
| `DEPLOY.md` | `DEPLOY.md` (this file) |
| `.env.example` | `.env.example` |
| `.gitignore` | `.gitignore` |

**Upload these binary files** ("Add file → Upload files", drag-and-drop):

| Repo path | Local file | sha256 (verify after upload if possible) |
|---|---|---|
| `circuits/gatekeeper.wasm` | `circuits/gatekeeper.wasm` | `be00aefe3c8ba910951a242f50e55937bf82a0375ad4b69c2ef10629ab92764f` |
| `circuits/gatekeeper_final.zkey` | `circuits/gatekeeper_final.zkey` | `adfe95a439a7063a82a4967ef026d2dd6857a4d02c63b3caf63dac02e01af80d` |

**Do NOT upload:** `node_modules/`, `.env`, `dev-server.js`, `test/`
(optional — they are harmless if uploaded, but they are not needed in
production; `dev-server.js` and `test/` are local-only helpers).

Each commit to `main` triggers a Vercel deployment. Wait for the deployment
to finish (Vercel dashboard → Deployments → "Ready") before testing.

## Step 2 — set the HMAC secret (Vercel dashboard)

The secret comes from the **Agent Games dashboard** (register the endpoint
first, then "Rotate Secret" — see Step 3 order note below).

1. Vercel dashboard → project `gatekeeper-proof` → Settings →
   Environment Variables.
2. Add `AGENT_GAMES_HMAC_SECRET` = the secret from the Agent Games
   dashboard. Scope: **Production**. (Do NOT put the secret in the repo,
   in chat, or in any file.)
3. Optional: `GATEKEEPER_TASK_ID_MODE` = `keccak` (default; only change
   after a practice task rejects the proof — see README "Known open items").
   Optional: `AGENT_GAMES_HMAC_FORMAT` = `hex` (default).
4. **Redeploy** after changing env vars (Deployments → ⋯ → Redeploy), or
   push any commit — env changes only take effect on a new deployment.

## Step 3 — register + verify (Agent Games dashboard, browser)

Order matters (chicken-and-egg, resolved in this order):

1. **Deploy the code first** (Step 1) so the URL serves the real handler.
   (The URL `https://gatekeeper-proof.vercel.app/gatekeeper` already
   exists and answers — right now it is the echo; after Step 1 it is the
   Gatekeeper.)
2. **Register the endpoint** in the Agent Games dashboard:
   `https://gatekeeper-proof.vercel.app/gatekeeper` (HTTPS, full handler
   path). Registration itself is still blocked on the user signing in to
   Agent Games (X/Google) — that is a separate, user-side step.
3. **Rotate Secret** in the dashboard → copy the secret → Step 2.
4. **Preflight:** the dashboard sends `{"type":"agent-games.preflight.v1"}`.
   It must answer `{ok:true, protocolVersion:"v1"}` **signed** with
   `x-agent-games-signature`. If it fails with "must return signed
   protocol-v1 JSON", the HMAC secret is missing/wrong in Vercel, or the
   HMAC format is wrong — try `AGENT_GAMES_HMAC_FORMAT=sha256=` and redeploy.
5. **Health check:** `GET https://gatekeeper-proof.vercel.app/health` must
   show `"ready": true` (HMAC configured + self-test PASS). If `ready` is
   false, read the `gatekeeper` block: `hmacConfigured` and `selfTest`
   say which half failed.
6. **Practice task:** run the dashboard's practice dispatch (capped at 10
   dispatches/agent/hour). Confirm:
   - a valid task returns APPROVE with a proof the platform accepts;
   - a trap task returns the correct REJECT reason.
   - If the platform rejects the proof on a valid task, the most likely
     cause is the `taskId` mapping: set `GATEKEEPER_TASK_ID_MODE` to
     `numeric`, redeploy, retry; then `hex` if still rejected. (One env
     var, no code change.)
   - If preflight passes but practice tasks get 401s, the inbound HMAC
     format is wrong — switch `AGENT_GAMES_HMAC_FORMAT`.

## Step 4 — verify from the outside (curl)

```bash
# health (expect "ready": true after the secret is set)
curl -s https://gatekeeper-proof.vercel.app/health

# preflight, signed with the dashboard secret (replace $SECRET):
BODY='{"type":"agent-games.preflight.v1"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')
curl -s -X POST https://gatekeeper-proof.vercel.app/gatekeeper \
  -H 'Content-Type: application/json' \
  -H "x-agent-games-signature: $SIG" -d "$BODY"
# expect: {"ok":true,"protocolVersion":"v1"} + an x-agent-games-signature header
```

## Rollback

If the new deployment breaks, re-upload the previous echo versions of
`api/gatekeeper.js` and `api/health.js` (the 2-line handlers) to `main` —
Vercel redeploys automatically. The pre-replacement content was:

- `api/health.js`: `module.exports = (req, res) => { res.status(200).json({ ok: true }); };`
- `api/gatekeeper.js`: the echo handler (POST only, returns `{ ok: true, received: <body> }`).

## Alternative deploy path (if the web UI route stalls)

If a GitHub personal access token becomes available (e.g. created by the
user in the browser: GitHub → Settings → Developer settings → Personal
access tokens → classic, `repo` scope), the shell can push directly:

```bash
cd ~/workspace/agent-games/gatekeeper
git init -b main
git add -A && git commit -m "Gatekeeper agent v1"
git remote add origin https://github.com/wahyunp56/gatekeeper-proof.git
git push -f origin main   # token via credential helper or URL (never in chat/files)
```

Do NOT create the token from any password stored on this VM — there is none.
The browser/web-UI route above needs no token at all.
