/**
 * Real Nomba API client
 * Docs: https://developer.nomba.com/docs/products/transfers/transfer-to-banks
 */

// Dynamically toggle endpoints based on Environment
// Production: https://api.nomba.com/v1
// Sandbox/Dev: https://api.nomba.com/c/v1
const NOMBA_BASE = process.env.NODE_ENV === 'production' 
  ? 'https://api.nomba.com/v1' 
  : 'https://api.nomba.com/c/v1';

const NOMBA_CLIENT_ID = process.env.NOMBA_CLIENT_ID;
const NOMBA_CLIENT_SECRET = process.env.NOMBA_CLIENT_SECRET;
const NOMBA_ACCOUNT_ID = process.env.NOMBA_ACCOUNT_ID;

let _tokenCache = null;
let _tokenExpiry = 0;

/**
 * Obtain a bearer token from Nomba OAuth endpoint.
 * Caches the token in memory until 60s before expiry.
 */
async function getNombaToken() {
  const now = Date.now();
  if (_tokenCache && now < _tokenExpiry) {
    return _tokenCache;
  }

  if (!NOMBA_CLIENT_ID || !NOMBA_CLIENT_SECRET) {
    throw new Error('NOMBA_CLIENT_ID and NOMBA_CLIENT_SECRET must be set');
  }

  const resp = await fetch(`${NOMBA_BASE}/auth/token/issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: NOMBA_CLIENT_ID,
      clientSecret: NOMBA_CLIENT_SECRET,
      grantType: 'client_credentials'
    })
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Nomba OAuth failed: ${resp.status} — ${body}`);
  }

  const data = await resp.json();
  _tokenCache = data.data?.access_token || data.access_token;
  // Nomba tokens expire in 3600s; refresh 60s early
  const expiresIn = (data.data?.expires_in || data.expires_in || 3600) - 60;
  _tokenExpiry = now + expiresIn * 1000;

  return _tokenCache;
}

/**
 * Execute a single bank transfer via the Nomba Transfers API.
 * @param {Object} payload
 * @param {number}  payload.amount         - Amount in naira (will be converted to kobo)
 * @param {string}  payload.accountNumber  - Beneficiary account number
 * @param {string}  payload.accountName    - Beneficiary name
 * @param {string}  payload.bankCode       - Beneficiary bank code
 * @param {string}  payload.merchantTxRef  - Your unique transaction reference (idempotency key)
 * @param {string}  payload.narration      - Transfer narration
 * @param {string}  idempotencyKey         - Nomba idempotency header value
 */
async function callNombaTransferAPI(payload, idempotencyKey) {
  // Fallback to simulation when credentials are not configured
  if (!NOMBA_CLIENT_ID || !NOMBA_CLIENT_SECRET || !NOMBA_ACCOUNT_ID) {
    console.warn('[NOMBA] Credentials not configured — running in simulation mode');
    return simulateNombaTransfer(payload);
  }

  try {
    const token = await getNombaToken();

    const body = {
      amount: Math.round(payload.amount * 100), // convert naira → kobo
      accountNumber: payload.accountNumber,
      accountName: payload.accountName,
      bankCode: payload.bankCode,
      merchantTxRef: payload.merchantTxRef,
      senderName: 'StableFlow',
      narration: payload.narration || 'StableFlow vendor payout',
      currency: 'NGN'
    };

    const resp = await fetch(`${NOMBA_BASE}/transfers/bank`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'accountId': NOMBA_ACCOUNT_ID,
        'Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify(body)
    });

    const data = await resp.json();

    if (!resp.ok) {
      console.error('[NOMBA] Transfer API error:', data);
      return {
        status: false,
        code: String(resp.status),
        message: data?.message || 'Nomba API returned an error'
      };
    }

    // Nomba returns { code: "00", data: { ... } } on success
    const isSuccess = data.code === '00' || data.data?.status === 'SUCCESS';

    return {
      status: isSuccess,
      code: data.code,
      message: data.message || 'Transfer submitted',
      data: {
        id: data.data?.id || data.data?.transactionRef || payload.merchantTxRef,
        status: isSuccess ? 'SUCCESS' : 'PENDING',
        amount: payload.amount
      }
    };
  } catch (err) {
    console.error('[NOMBA] callNombaTransferAPI error:', err.message);
    return {
      status: false,
      code: 'NET_ERR',
      message: err.message
    };
  }
}

/**
 * Simulation fallback — mirrors the mock in the original settlement.js
 * but kept here so settlement.js stays clean.
 */
async function simulateNombaTransfer(payload) {
  await new Promise((resolve) => setTimeout(resolve, 800));

  if (payload.accountNumber.endsWith('99') || payload.accountNumber === '9999999999') {
    return { status: false, code: '99', message: 'Account validation failed (simulation)' };
  }

  return {
    status: true,
    code: '00',
    message: 'Success (simulation)',
    data: {
      id: `SIM_NOMBA_TX_${Date.now()}`,
      status: 'SUCCESS',
      amount: payload.amount
    }
  };
}

module.exports = { callNombaTransferAPI };
