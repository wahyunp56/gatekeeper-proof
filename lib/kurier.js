// Kurier (zkVerify) proof submission — OPTIONAL, best-effort.
// The platform accepts the locally-generated Groth16 proof in the response
// (that is the primary evidence). Kurier adds an on-chain finalization
// pointer (proofReference) for the response. If no KURIER_API_KEY is set,
// or Kurier is slow/down, the server still responds with the local proof —
// Kurier never blocks or breaks a response.
//
// Flow (official zkVerify docs, https://docs.zkverify.io/overview/getting-started/kurier):
//   1. POST {API}/register-vk/{apiKey}  { proofType:'groth16',
//      proofOptions:{library:'snarkjs',curve:'bn128'}, vk }  -> { vkHash }
//      (once per circuit; cached in memory)
//   2. POST {API}/submit-proof/{apiKey} { proofType:'groth16', vkRegistered:true,
//      proofOptions:{...}, proofData:{ proof, publicSignals, vk: vkHash } }
//      -> { jobId, optimisticVerify }
//   3. GET  {API}/job-status/{apiKey}/{jobId} -> { status, txHash }
//      Poll until "Finalized" (or the caller's deadline).
// API key: free, self-serve — sign up at https://kurier.xyz (email).
// No payment is involved for an API key.
//
// Serverless note: the VK-hash cache is in-memory only (the Vercel
// filesystem is read-only except /tmp, and a cache file would not survive
// across instances anyway). Re-registering the VK costs one extra request
// per cold start at most — acceptable for a best-effort pointer.
const { getVerificationKey } = require('./snark');

const API_URL = process.env.KURIER_API_URL || 'https://api.kurier.xyz/api/v1';

let vkHashCache = {};

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Kurier ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

async function getJson(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Kurier ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

async function registerVk(apiKey, circuitName) {
  if (vkHashCache[circuitName]) return vkHashCache[circuitName];
  const vk = await getVerificationKey(circuitName);
  const data = await postJson(`${API_URL}/register-vk/${apiKey}`, {
    proofType: 'groth16',
    proofOptions: { library: 'snarkjs', curve: 'bn128' },
    vk,
  });
  const vkHash = data.vkHash || data.vk_hash;
  if (!vkHash) throw new Error('Kurier register-vk returned no vkHash');
  vkHashCache[circuitName] = vkHash;
  return vkHash;
}

// Submit a proof for on-chain finalization. Resolves to { jobId, proofReference }
// or null on any failure / timeout. Never throws to the caller.
async function submitProof(apiKey, circuitName, proof, publicSignals, deadlineMs = 15000) {
  if (!apiKey) return null;
  const t0 = Date.now();
  try {
    const vkHash = await registerVk(apiKey, circuitName);
    const data = await postJson(`${API_URL}/submit-proof/${apiKey}`, {
      proofType: 'groth16',
      vkRegistered: true,
      proofOptions: { library: 'snarkjs', curve: 'bn128' },
      proofData: { proof, publicSignals, vk: vkHash },
    });
    const jobId = data.jobId || data.job_id;
    if (!jobId) return null;
    // Poll until Finalized, or until the caller's deadline.
    while (Date.now() - t0 < deadlineMs) {
      const st = await getJson(`${API_URL}/job-status/${apiKey}/${jobId}`);
      const status = st.status || st.state || '';
      if (status === 'Finalized' || status === 'finalized') {
        return { jobId, proofReference: st.txHash || st.tx_hash || jobId };
      }
      if (status === 'Failed' || status === 'failed') return null;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return { jobId, proofReference: jobId };
  } catch (e) {
    console.error('[kurier] submission failed (best-effort, response unaffected):', e.message);
    return null;
  }
}

module.exports = { submitProof, registerVk };
