// Proof Gatekeeper — deterministic 7-trap decision logic.
// The circuit itself is the referee: it enforces that the decision matches the
// correct evaluation of the inputs (a wrong decision fails witness generation).
// This module must therefore implement EXACTLY the circuit's checks.
//
// Checks (first failing trap wins; reason_code = trap name):
//   VK_SUBSTITUTION   proof_vk != registered_vk
//   PROOF_REUSED      proof_tx already seen under a DIFFERENT task_id
//   THRESHOLD_MISMATCH public_balance < minimum
//   EXPIRED_CONDITION current_block > expiry_block
//   RECIPIENT_MISMATCH recipient != condition_recipient (case-insensitive)
//   AMOUNT_OVERFLOW   amount > max_transfer
//   else VALID_CONDITION -> APPROVE
//
// Boundary notes (verified against the circuit in test/decide.test.js):
//   - public_balance == minimum is VALID (threshold is inclusive).
//   - current_block == expiry_block is EXPIRED (expiry is STRICT: valid
//     only while current_block < expiry_block).
//   - amount == max_transfer is VALID (max is inclusive).
//   - proof_tx reuse is tracked per task_id: a platform retry of the SAME
//     task_id is not a reuse; the same proof_tx under another task_id is.
//
// SERVERLESS NOTE: `seenProofTx` lives in module scope. On Vercel it is
// shared only within one warm function instance — a cold start resets it.
// That is a best-effort reuse check, not a guarantee: the platform also
// tracks reuse on its side, and a missed reuse can cost at most one wrong
// APPROVE (-6 instead of the correct REJECT -3). The map is capped so a
// long-lived instance cannot grow unboundedly.
const seenProofTx = new Map(); // proof_tx (lowercased) -> task_id
const SEEN_CAP = 5000;

function normalizeAddress(a) {
  return String(a || '').toLowerCase();
}

function decide(input) {
  const registeredVk = String(input.registered_vk || '').toLowerCase();
  const proofVk = String(input.proof_vk || '').toLowerCase();
  const minimum = BigInt(input.minimum);
  const publicBalance = BigInt(input.public_balance);
  const expiryBlock = BigInt(input.expiry_block);
  const currentBlock = BigInt(input.current_block);
  const recipient = normalizeAddress(input.recipient);
  const conditionRecipient = normalizeAddress(input.condition_recipient);
  const amount = BigInt(input.amount);
  const maxTransfer = BigInt(input.max_transfer);
  const proofTx = String(input.proof_tx || '').toLowerCase();
  const taskId = String(input.task_id || '');

  if (proofVk !== registeredVk) return { decision: 'REJECT', reason_code: 'VK_SUBSTITUTION' };

  if (proofTx) {
    const prevTask = seenProofTx.get(proofTx);
    if (prevTask !== undefined && prevTask !== taskId) {
      return { decision: 'REJECT', reason_code: 'PROOF_REUSED' };
    }
    if (prevTask === undefined) {
      if (seenProofTx.size >= SEEN_CAP) {
        // FIFO eviction: Map preserves insertion order.
        seenProofTx.delete(seenProofTx.keys().next().value);
      }
      seenProofTx.set(proofTx, taskId);
    }
  }

  if (publicBalance < minimum) return { decision: 'REJECT', reason_code: 'THRESHOLD_MISMATCH' };
  // STRICT: the circuit treats current_block == expiry_block as expired
  // (witness calc fails for APPROVE at the boundary — verified 2026-11-15).
  if (currentBlock >= expiryBlock) return { decision: 'REJECT', reason_code: 'EXPIRED_CONDITION' };
  if (recipient !== conditionRecipient) return { decision: 'REJECT', reason_code: 'RECIPIENT_MISMATCH' };
  if (amount > maxTransfer) return { decision: 'REJECT', reason_code: 'AMOUNT_OVERFLOW' };

  return { decision: 'APPROVE', reason_code: 'VALID_CONDITION' };
}

function resetSeen() {
  seenProofTx.clear();
}

module.exports = { decide, resetSeen, seenProofTx };
