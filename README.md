# Proof Gatekeeper — Agent Games Season 01 (zkVerify)

A **Proof Gatekeeper** agent for the [zkVerify Agent Games](https://agentgames.zkverify.io)
tournament (21 Oct – 21 Nov 2026, 400,000 VFY total, 100,000 VFY for this track,
top 3 = 50,000 / 30,000 / 20,000). Runs as **Vercel serverless functions**
(Hobby free plan) at `https://gatekeeper-proof.vercel.app`.

The platform POSTs a signed transfer task to `POST /gatekeeper`. The agent has
**60 seconds** to answer APPROVE or REJECT — plus a Groth16 zero-knowledge
proof of that decision, generated locally with snarkjs and the tournament's own
circuit, which the platform re-verifies against its registered verification key.

Scoring: correct decision **+12** · wrong APPROVE **−6** · wrong REJECT **−3** ·
timeout **−2** · missing/invalid proof **−2** · reliability bonus **+0–5**.
8 daily rounds, 13–20 Nov, 17:30–03:30 WIB, 8 tasks/agent/round.

## How it works

1. **Verify the HMAC first.** Every inbound request carries an
   `x-agent-games-signature` header — HMAC-SHA256 over the raw request body,
   signed with the per-agent secret from the dashboard ("Rotate Secret"). The
   server checks it against the raw bytes *before parsing anything*. A bad
   signature gets a 401 and no work is done at all. (Vercel's body parser is
   disabled for this route — see `api/gatekeeper.js` — because the HMAC must
   cover the exact bytes the platform signed.)
2. **Decide deterministically.** No LLM judgement call. A fixed 7-trap
   checklist over the task fields (`lib/decide.js`):
   - `VK_SUBSTITUTION` — `proof_vk != registered_vk`
   - `PROOF_REUSED` — `proof_tx` already seen under a *different* `task_id`
     (a retry of the same `task_id` is not a reuse)
   - `THRESHOLD_MISMATCH` — `public_balance < minimum`
   - `EXPIRED_CONDITION` — `current_block >= expiry_block` (expiry is STRICT:
     `current == expiry` is expired; balance and amount boundaries are inclusive)
   - `RECIPIENT_MISMATCH` — `recipient != condition_recipient`
   - `AMOUNT_OVERFLOW` — `amount > max_transfer`
   - else `VALID_CONDITION` → APPROVE
3. **Prove the decision.** A Groth16 proof is generated with snarkjs and the
   official gatekeeper circuit (`circuits/gatekeeper.wasm` +
   `gatekeeper_final.zkey`, downloaded from `agentgames.zkverify.io/circuits`,
   sha256-verified). The circuit itself is the referee: a wrong decision fails
   witness generation, so a bad decision can never produce a valid proof.
4. **Fail closed.** Any error, timeout, or uncertainty means REJECT. Never
   approve by default. A response is always returned (never a hang) — if proof
   generation ever fails, the decision is still returned without a proof.
5. **Sign every response** with `x-agent-games-signature` over the raw
   response body. The dashboard preflight requires a signed protocol-v1
   response; unsigned responses are rejected.

Response (signed):

```json
{"decision": "APPROVE", "reason_code": "VALID_CONDITION", "proof_tx": "0x…",
 "proof": {"pi_a": […], "pi_b": […], "pi_c": […], "protocol": "groth16", "curve": "bn128"},
 "public_signals": ["…13 values…"]}
```

`PROOF_REUSED` responses carry no proof (the platform excludes them from the
reliability bonus). Preflight (`{"type":"agent-games.preflight.v1"}`) is
answered `{ok:true, protocolVersion:"v1"}`, signed.

## Files

```
api/
  gatekeeper.js     Vercel function: POST /gatekeeper (HMAC → decide → prove → sign)
  health.js         Vercel function: GET /health (readiness + cached self-test)
lib/
  decide.js         7-trap checklist (+ per-instance seen-proof set)
  prove.js          circuit input mapping + taskId mapping (keccak/numeric/hex)
  snark.js          snarkjs wrapper (prove / verify)
  hmac.js           HMAC-SHA256 verify/sign
  field.js          BN128 field arithmetic + keccak
  kurier.js         Kurier submission (optional, best-effort, never blocks)
circuits/
  gatekeeper.wasm / gatekeeper_final.zkey   official circuit artifacts
test/
  decide.test.js    12-case harness: all 7 traps + boundaries vs the circuit
  http.test.js      end-to-end HTTP test against the local dev server
dev-server.js       local dev server (plain Node http, same handlers)
vercel.json         rewrites /health + /gatekeeper, function limits, includeFiles
```

## Configuration (Vercel env vars — see DEPLOY.md)

| Variable | Required | What it is |
|---|---|---|
| `AGENT_GAMES_HMAC_SECRET` | **yes, before going live** | From the dashboard "Rotate Secret". Without it, inbound HMAC verification is disabled and the preflight fails (it requires a signed response) |
| `AGENT_GAMES_HMAC_FORMAT` | no (`hex`) | `hex` or `sha256=` — switch if the platform rejects the preflight |
| `GATEKEEPER_TASK_ID_MODE` | no (`keccak`) | How `task_id` maps to the circuit field element: `keccak` (default), `numeric`, `hex` — confirm in practice |
| `KURIER_API_KEY` | no | Free key from https://kurier.xyz (email signup). Optional — responses always carry the local proof |

## Local development

```bash
npm install
cp .env.example .env   # fill in AGENT_GAMES_HMAC_SECRET (any test value works locally)
node dev-server.js     # serves :8080 — POST /gatekeeper, GET /health
npm test               # decide harness (12 cases) + HTTP end-to-end (9 cases)
```

## Test results (2026-11-15, this VM, Node v24.22.1)

- **`node test/decide.test.js` — 12/12 PASS.** All 7 trap types + boundary
  cases (balance == minimum VALID, amount == max VALID, current == expiry
  EXPIRED), proof-reuse detection, same-task retry is not a reuse. Every
  decision's proof verifies locally against the official circuit.
- **`node test/http.test.js` — 9/9 PASS** (against `dev-server.js` with a
  test HMAC secret): `/health` self-test PASS, signed preflight, wrong HMAC
  → 401, missing signature → 401, GET → 405, valid task → APPROVE + proof
  that verifies locally (375 ms end-to-end, 13 public signals), trap task →
  REJECT/THRESHOLD_MISMATCH + verifying proof, invalid task →
  REJECT/INVALID_TASK, proof reuse → REJECT/PROOF_REUSED with no proof.
- **Proof generation ~300 ms** (first proof in a fresh process ~1.1 s
  including wasm load) — far inside the 60 s deadline.
- **Circuit artifacts verified:** `gatekeeper.wasm` sha256
  `be00aefe3c8ba910951a242f50e55937bf82a0375ad4b69c2ef10629ab92764f`,
  `gatekeeper_final.zkey` sha256
  `adfe95a439a7063a82a4967ef026d2dd6857a4d02c63b3caf63dac02e01af80d` —
  downloaded from the official site, byte-identical to the published
  reference implementation's copies. Registered `vkHash`
  `0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0`
  (from `/api/circuit-info`).

## Known open items (confirm in practice, after registration)

1. **`taskId` mapping.** The envelope's `task_id` is a string (e.g.
   `gk_24_9d1`); the circuit needs a field element. Default is
   `keccak256(task_id)` mod field prime. If the platform rejects the proof
   on the first practice task, switch `GATEKEEPER_TASK_ID_MODE` to `numeric`
   or `hex` and retry — it is a one-function change in `lib/prove.js`, no
   other code changes needed.
2. **HMAC format.** `hex` is the standard assumption; the docs do not state
   it explicitly. If preflight fails, try `sha256=` (`AGENT_GAMES_HMAC_FORMAT`).
3. **Proof-reuse tracking is per-instance on Vercel.** The seen-proof set
   lives in module scope, so a cold start resets it. During a round (8 tasks
   over hours) the function stays warm and the check works; across cold
   starts a reused proof could slip through as one wrong APPROVE (−6 instead
   of the correct REJECT −3). The platform also tracks reuse on its side.
4. **Kurier is unconfigured** (no API key). Responses always carry the local
   proof, which is the primary evidence; Kurier only adds an on-chain
   finalization pointer. Free to add later via https://kurier.xyz.

## Sources & attribution

- Official field guide: https://agentgames.zkverify.io/build
- Circuit info: https://agentgames.zkverify.io/api/circuit-info
- Protocol details (envelope fields, preflight, boundary semantics) follow
  the public reference implementation by the first registered Gatekeeper
  participant (MIT-licensed repo, https://github.com/subastian1998/agent-games-season-01),
  whose author verified the same circuit behavior against the official
  artifacts on 2026-11-15. This code is an independent Vercel-serverless
  adaptation written for this project — no wallet, key, or seed is touched;
  these are game endpoints only.
