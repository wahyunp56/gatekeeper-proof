// Proof Gatekeeper — Vercel serverless function (POST /gatekeeper).
//
// Flow, in order:
//   1. Read the RAW request body (bodyParser disabled below — HMAC must be
//      verified over the exact bytes the platform signed).
//   2. Verify the HMAC signature in `x-agent-games-signature` BEFORE parsing
//      anything. Bad signature -> 401, no work done.
//   3. Preflight {"type":"agent-games.preflight.v1"} -> {ok:true, protocolVersion:"v1"}.
//   4. Decide deterministically (7-trap checklist in lib/decide.js).
//   5. Generate a Groth16 proof of the decision with the tournament's own
//      circuit (lib/prove.js) and return it, signed, within the 60s deadline.
//   6. Fail closed: any error, timeout, or uncertainty means REJECT. Never
//      approve by default. A response is always returned (never a hang);
//      if proof generation fails, the decision is still returned without a
//      proof (the platform scores that -2, a timeout also -2 — but a
//      returned REJECT on a trap is the correct +12).
//
// Every response is signed with `x-agent-games-signature` over the raw
// response body (when the HMAC secret is configured). The dashboard
// preflight REQUIRES a signed response — set AGENT_GAMES_HMAC_SECRET in the
// Vercel dashboard before registering the endpoint.
//
// Env: AGENT_GAMES_HMAC_SECRET (required for live), AGENT_GAMES_HMAC_FORMAT
// (hex | sha256=), GATEKEEPER_TASK_ID_MODE (keccak | numeric | hex),
// KURIER_API_KEY (optional, best-effort on-chain finalization pointer).
const { verifySignature, signatureFor } = require('../lib/hmac');
const { decide } = require('../lib/decide');
const { proveTask } = require('../lib/prove');
const { submitProof } = require('../lib/kurier');

const HMAC_SECRET = process.env.AGENT_GAMES_HMAC_SECRET || '';
const HMAC_FORMAT = process.env.AGENT_GAMES_HMAC_FORMAT || 'hex';
const KURIER_API_KEY = process.env.KURIER_API_KEY || '';
const TASK_ID_MODE = process.env.GATEKEEPER_TASK_ID_MODE || 'keccak';

// Proof generation must finish far inside the platform's 60s deadline.
// If it ever hangs, return the decision without a proof instead of timing out.
const PROVE_TIMEOUT_MS = 50000;

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  const headers = { 'Content-Type': 'application/json' };
  if (HMAC_SECRET) headers['x-agent-games-signature'] = signatureFor(HMAC_SECRET, body, HMAC_FORMAT);
  res.writeHead(status, headers);
  res.end(body);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    // Vercel with bodyParser:false gives us the raw stream. In local tests
    // the mock req is a Readable stream too.
    if (typeof req.on !== 'function') {
      resolve(Buffer.alloc(0));
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifyInbound(rawBody, req) {
  if (!HMAC_SECRET) {
    console.warn('[warn] AGENT_GAMES_HMAC_SECRET is not set — inbound HMAC is NOT verified. Set it before going live.');
    return true;
  }
  const sig = req.headers && req.headers['x-agent-games-signature'];
  return verifySignature(HMAC_SECRET, rawBody, sig, HMAC_FORMAT);
}

function isPreflight(obj) {
  return obj && obj.type === 'agent-games.preflight.v1';
}

async function proveWithTimeout(task, decision) {
  return Promise.race([
    proveTask(task, decision, TASK_ID_MODE),
    new Promise((_, reject) => setTimeout(() => reject(new Error('prove timeout')), PROVE_TIMEOUT_MS)),
  ]);
}

async function handleGatekeeper(obj) {
  const task = obj.input || obj;
  const required = ['registered_vk', 'proof_vk', 'minimum', 'public_balance', 'expiry_block', 'current_block', 'recipient', 'condition_recipient', 'amount', 'max_transfer'];
  for (const f of required) {
    if (task[f] === undefined || task[f] === null || task[f] === '') {
      return { status: 200, body: { decision: 'REJECT', reason_code: 'INVALID_TASK', proof_tx: String(task.proof_tx || '') } };
    }
  }
  let decision, reason_code;
  try {
    ({ decision, reason_code } = decide(task));
  } catch (e) {
    // Unparseable numbers etc. — fail closed.
    console.error('[gatekeeper] decide() threw (fail closed):', e.message);
    return { status: 200, body: { decision: 'REJECT', reason_code: 'INVALID_TASK', proof_tx: String(task.proof_tx || '') } };
  }
  const proofTx = String(task.proof_tx || '');
  if (reason_code === 'PROOF_REUSED') {
    // No proof to submit for a reused proof (platform excludes these from
    // the reliability bonus).
    console.log(`[gatekeeper] task=${task.task_id || '?'} decision=REJECT/PROOF_REUSED`);
    return { status: 200, body: { decision, reason_code, proof_tx: proofTx } };
  }
  const t0 = Date.now();
  try {
    const { proof, publicSignals } = await proveWithTimeout(task, decision);
    console.log(`[gatekeeper] task=${task.task_id || '?'} decision=${decision}/${reason_code} prove=${Date.now() - t0}ms`);
    // Kurier (best-effort, fire-and-forget): on-chain finalization pointer.
    // Gatekeeper responses carry no proofReference field, so this never
    // blocks or changes the response.
    if (KURIER_API_KEY) {
      submitProof(KURIER_API_KEY, 'gatekeeper', proof, publicSignals, 15000).catch(() => {});
    }
    return { status: 200, body: { decision, reason_code, proof_tx: proofTx, proof, public_signals: publicSignals } };
  } catch (e) {
    console.error('[gatekeeper] proof generation failed (decision still returned):', e.message);
    return { status: 200, body: { decision, reason_code, proof_tx: proofTx } };
  }
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
    }
    let rawBody = await readRawBody(req);
    if ((!rawBody || rawBody.length === 0) && typeof req.body === 'string') {
      rawBody = Buffer.from(req.body, 'utf8');
    }
    if (!rawBody || rawBody.length === 0) {
      if (req.body && typeof req.body === 'object') {
        // The runtime parsed the body before we could read the raw bytes,
        // so HMAC cannot be verified. Fail loudly, not silently.
        console.error('[gatekeeper] raw body unavailable (bodyParser not disabled?)');
        return sendJson(res, 500, { ok: false, error: 'raw_body_unavailable' });
      }
      return sendJson(res, 400, { ok: false, error: 'empty_body' });
    }
    if (!verifyInbound(rawBody, req)) {
      console.warn('[warn] HMAC mismatch on /gatekeeper');
      return sendJson(res, 401, { ok: false, error: 'bad_signature' });
    }
    let obj;
    try {
      obj = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid_json' });
    }
    if (isPreflight(obj)) {
      return sendJson(res, 200, { ok: true, protocolVersion: 'v1' });
    }
    const result = await handleGatekeeper(obj);
    return sendJson(res, result.status, result.body);
  } catch (e) {
    console.error('[gatekeeper] unhandled error:', e);
    return sendJson(res, 500, { ok: false, error: 'internal_error' });
  }
};

// Disable Vercel's automatic body parsing: the HMAC must be verified over
// the exact raw bytes the platform signed. Without this, req.body would be
// pre-parsed JSON and the raw bytes unrecoverable.
module.exports.config = { api: { bodyParser: false } };
