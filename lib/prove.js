// Proof Gatekeeper — Groth16 proof generation.
// Circuit inputs (verified by probing the official wasm):
//   registeredVkHash, proofVkHash, minimum, publicBalance, expiryBlock,
//   currentBlock, recipient, conditionRecipient, amount, maxTransfer,
//   decision (1 = APPROVE, 0 = REJECT), taskId, salt (private).
// Public signals (13): [hash, registeredVkHash, proofVkHash, minimum,
//   publicBalance, expiryBlock, currentBlock, recipient, conditionRecipient,
//   amount, maxTransfer, decision, taskId] — the first signal is a
//   salt-dependent binding hash the platform cannot recompute; the other 12
//   are the task fields, which the platform checks against the envelope.
//
// taskId mapping (OPEN — to confirm in practice):
//   The envelope's task_id is a string like "gk_24_9d1". The circuit needs a
//   field element. Default: keccak256(task_id as UTF-8) mod FIELD_PRIME.
//   Alternatives (set GATEKEEPER_TASK_ID_MODE): "numeric" (digits of the
//   suffix as a decimal number), "hex" (hex chars of the suffix as a number).
//   If the practice task's proof is rejected, switch the mode and retry.
//   The mapping is a single function here — no other code changes needed.
const crypto = require('crypto');
const { toField, keccak256ModP } = require('./field');
const { prove } = require('./snark');

function taskIdToField(taskId, mode) {
  const id = String(taskId || '');
  if (mode === 'numeric') {
    const digits = id.replace(/\D/g, '');
    return digits ? toField(BigInt(digits)) : 0n;
  }
  if (mode === 'hex') {
    const hex = id.replace(/[^0-9a-fA-F]/g, '');
    return hex ? toField(BigInt('0x' + hex)) : 0n;
  }
  // default: keccak256(utf8(task_id)) mod p
  return keccak256ModP([Buffer.from(id, 'utf8')]);
}

function buildInput(task, decision, taskIdMode) {
  const salt = '0x' + crypto.randomBytes(32).toString('hex');
  return {
    registeredVkHash: String(task.registered_vk),
    proofVkHash: String(task.proof_vk),
    minimum: String(task.minimum),
    publicBalance: String(task.public_balance),
    expiryBlock: String(task.expiry_block),
    currentBlock: String(task.current_block),
    recipient: String(task.recipient),
    conditionRecipient: String(task.condition_recipient),
    amount: String(task.amount),
    maxTransfer: String(task.max_transfer),
    decision: decision === 'APPROVE' ? '1' : '0',
    taskId: taskIdToField(task.task_id, taskIdMode).toString(),
    salt,
  };
}

async function proveTask(task, decision, taskIdMode) {
  const input = buildInput(task, decision, taskIdMode);
  const { proof, publicSignals } = await prove('gatekeeper', input);
  return { proof, publicSignals };
}

module.exports = { taskIdToField, buildInput, proveTask };
