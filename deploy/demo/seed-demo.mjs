// Seeds the public demo through the API. Safe to run more than once.
// Env: API_URL (default http://localhost:4000), ADMIN_API_TOKEN.

const API_URL = process.env.API_URL ?? 'http://localhost:4000';
const TOKEN = process.env.ADMIN_API_TOKEN;
if (!TOKEN) throw new Error('ADMIN_API_TOKEN is required');

// Busy testnet contracts, so the demo always has fresh events.
const CONTRACTS = [
  {
    contractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    label: 'Native XLM (SAC)',
  },
  { contractId: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA', label: 'USDC (SAC)' },
];

const VIEWER_TOKEN_NAME = 'Public demo (read-only)';

async function api(method, path, body) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  return { status: res.status, data };
}

const contracts = {};
const existing = await api('GET', '/contracts?limit=500');
for (const c of existing.data?.items ?? []) contracts[c.contractId] = c.id;

for (const c of CONTRACTS) {
  if (contracts[c.contractId]) {
    console.log(`contract already monitored: ${c.label}`);
    continue;
  }
  const res = await api('POST', '/contracts', { ...c, network: 'TESTNET' });
  if (res.status === 201) {
    contracts[c.contractId] = res.data.id;
    console.log(`added contract: ${c.label}`);
  } else {
    // Testnet is reset every few months; a contract may not exist yet after a reset.
    console.warn(`skipped ${c.label}: ${res.status} ${res.data?.error?.message ?? ''}`);
  }
}

const xlm = contracts[CONTRACTS[0].contractId];
const usdc = contracts[CONTRACTS[1].contractId];
const RULES = [
  xlm && {
    name: 'XLM transfer burst',
    type: 'EVENT_MATCH',
    contractRefId: xlm,
    severity: 'INFO',
    cooldownSeconds: 1800,
    config: { topics: ['transfer'], threshold: 25, windowSeconds: 300 },
  },
  usdc && {
    name: 'USDC quiet for 1 hour',
    type: 'INACTIVITY',
    contractRefId: usdc,
    severity: 'WARNING',
    config: { windowSeconds: 3600 },
  },
  {
    name: 'Storage expires within 7 days',
    type: 'TTL_EXPIRY',
    contractRefId: null,
    severity: 'CRITICAL',
    config: { ledgersThreshold: 17280 * 7 },
  },
  {
    name: 'Contract WASM upgraded',
    type: 'WASM_CHANGED',
    contractRefId: null,
    severity: 'WARNING',
    config: {},
  },
].filter(Boolean);

const rules = await api('GET', '/alert-rules');
const ruleNames = new Set((rules.data?.items ?? []).map((r) => r.name));
for (const r of RULES) {
  if (ruleNames.has(r.name)) continue;
  const res = await api('POST', '/alert-rules', r);
  console.log(
    res.status === 201 ? `added rule: ${r.name}` : `rule ${r.name} failed: ${res.status}`,
  );
}

const tokens = await api('GET', '/settings/tokens');
if ((tokens.data?.items ?? []).some((t) => t.name === VIEWER_TOKEN_NAME)) {
  console.log(
    `viewer token "${VIEWER_TOKEN_NAME}" already exists (delete it in Settings to issue a new one)`,
  );
} else {
  const res = await api('POST', '/settings/tokens', { name: VIEWER_TOKEN_NAME, role: 'VIEWER' });
  if (res.status !== 201) throw new Error(`could not create viewer token: ${res.status}`);
  console.log(`\nPublic read-only token (put this in the README):\n\n  ${res.data.token}\n`);
}
