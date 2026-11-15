// Readiness endpoint (GET /health).
//
// Reports whether the agent is ready for the dashboard health check:
//   - HMAC secret configured? (the dashboard preflight requires a SIGNED
//     response, so without the secret the agent is NOT ready)
//   - taskId mapping mode
//   - self-test: a valid APPROVE task proved + verified locally (runs once
//     per warm instance, lazily on the first health call, then cached)
//   - Kurier configured? (optional)
//
// `ready` is true only when the HMAC secret is set AND the self-test passes.
const { decide } = require('../lib/decide');
const { proveTask } = require('../lib/prove');
const { verifyLocally } = require('../lib/snark');

const HMAC_SECRET = process.env.AGENT_GAMES_HMAC_SECRET || '';
const HMAC_FORMAT = process.env.AGENT_GAMES_HMAC_FORMAT || 'hex';
const KURIER_API_KEY = process.env.KURIER_API_KEY || '';
const TASK_ID_MODE = process.env.GATEKEEPER_TASK_ID_MODE || 'keccak';

const VK = '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0';
const ADDR = '0x1111111111111111111111111111111111111111';

let selfTest = 'pending';
let selfTestRunning = null;

async function runSelfTest() {
  if (selfTest !== 'pending') return selfTest;
  if (selfTestRunning) return selfTestRunning;
  selfTestRunning = (async () => {
    try {
      const task = {
        task_id: 'gk_selftest_1', registered_vk: VK, proof_vk: VK,
        minimum: '1000', public_balance: '1460', expiry_block: '8430000', current_block: '8420000',
        recipient: ADDR, condition_recipient: ADDR,
        amount: '500', max_transfer: '1000', proof_tx: '0xselftest',
      };
      const { decision } = decide(task);
      const { proof, publicSignals } = await proveTask(task, decision, TASK_ID_MODE);
      const ok = await verifyLocally('gatekeeper', publicSignals, proof);
      selfTest = ok && decision === 'APPROVE' ? 'PASS (APPROVE proof verifies locally)' : 'FAIL';
    } catch (e) {
      selfTest = 'FAIL: ' + e.message;
    }
    return selfTest;
  })();
  return selfTestRunning;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
    return;
  }
  const test = await runSelfTest();
  const ready = !!HMAC_SECRET && test.startsWith('PASS');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    ready,
    gatekeeper: {
      hmacConfigured: !!HMAC_SECRET,
      hmacFormat: HMAC_FORMAT,
      taskIdMode: TASK_ID_MODE,
      selfTest: test,
      kurierConfigured: !!KURIER_API_KEY,
    },
    uptimeSec: Math.floor(process.uptime()),
    node: process.version,
  }));
};
