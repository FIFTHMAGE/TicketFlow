const db = require('./db');
const ledger = require('./ledger');
const { callNombaTransferAPI } = require('./nomba');

const processingVendors = new Set();
const APPROVAL_THRESHOLD = 5000000; // ₦5,000,000

// Execute a single vendor payout via Nomba
const executeSinglePayout = async (payoutId, vendorId, batchId, payoutAmount, vendor, idempotencyKey) => {
  try {
    const nombaPayload = {
      amount: payoutAmount,
      accountNumber: vendor.account_number,
      accountName: vendor.account_name,
      bankCode: vendor.bank_code || '058',
      merchantTxRef: payoutId,
      senderName: 'StableFlow',
      narration: `Payout Batch ${batchId}`
    };

    const result = await callNombaTransferAPI(nombaPayload, idempotencyKey);

    if (result.status && result.data) {
      const providerRef = result.data.id;
      await db.run('UPDATE payouts SET provider_reference = ? WHERE id = ?', [providerRef, payoutId]);

      if (result.data.status === 'SUCCESS') {
        await db.run('UPDATE payouts SET status = ? WHERE id = ?', ['COMPLETED', payoutId]);
      } else {
        // Pending async confirmation from Nomba webhook
        await db.run('UPDATE payouts SET status = ? WHERE id = ?', ['PROCESSING', payoutId]);
      }
    } else {
      await ledger.reversePayout(payoutId, batchId, vendorId, payoutAmount, result.message || 'API rejected');
    }
  } catch (err) {
    console.error(`[SETTLEMENT] Error executing payout ${payoutId}:`, err);
    await ledger.reversePayout(payoutId, batchId, vendorId, payoutAmount, err.message);
  }
};

// Run a settlement batch
const runSettlementBatch = async (userId = 'system', ipAddress = '127.0.0.1') => {
  const batchId = `BATCH_${Date.now()}`;

  await db.run(
    'INSERT INTO audit_logs (username, action, details, ip_address) VALUES (?, ?, ?, ?)',
    [userId, 'START_SETTLEMENT_BATCH', `Initiated settlement batch: ${batchId}`, ipAddress]
  );

  // Vendors with active payable balance > 0
  const accounts = await db.all(
    "SELECT id, balance FROM ledger_accounts WHERE id LIKE 'VENDOR_PAYABLE_%' AND balance > 0"
  );

  // Already approved high-value payouts waiting for execution
  const approvedPayouts = await db.all(
    `SELECT * FROM payouts 
     WHERE status = 'PENDING_APPROVAL' 
     AND approved_by_finance IS NOT NULL 
     AND approved_by_admin IS NOT NULL`
  );

  if (accounts.length === 0 && approvedPayouts.length === 0) {
    await db.run(
      'INSERT INTO audit_logs (username, action, details, ip_address) VALUES (?, ?, ?, ?)',
      [userId, 'END_SETTLEMENT_BATCH', `No pending balances. Batch ${batchId} skipped.`, ipAddress]
    );
    return { batchId, status: 'NO_PENDING_BALANCES' };
  }

  await db.run('INSERT INTO settlement_batches (id, status) VALUES (?, ?)', [batchId, 'PENDING']);

  // 1. Process new payouts from current ledger balances
  for (const account of accounts) {
    const vendorId = account.id.replace('VENDOR_PAYABLE_', '');

    if (processingVendors.has(vendorId)) continue;
    processingVendors.add(vendorId);

    const payoutAmount = account.balance;
    const payoutId = `PAYOUT_${vendorId}_${Date.now()}`;
    const idempotencyKey = `payout_${vendorId}_batch_${batchId}`;

    try {
      const vendor = await db.get('SELECT * FROM vendors WHERE id = ?', [vendorId]);
      if (!vendor) throw new Error(`Vendor not found: ${vendorId}`);

      if (payoutAmount >= APPROVAL_THRESHOLD) {
        // Hold for dual authorisation — freeze balance immediately
        await db.run(
          'INSERT INTO payouts (id, vendor_id, batch_id, amount, idempotency_key, status) VALUES (?, ?, ?, ?, ?, ?)',
          [payoutId, vendorId, batchId, payoutAmount, idempotencyKey, 'PENDING_APPROVAL']
        );
        await ledger.recordPayout(payoutId, batchId, vendorId, payoutAmount);

        await db.run(
          'INSERT INTO audit_logs (username, action, details, before_state, after_state, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
          [
            userId,
            'PAYOUT_HELD_FOR_APPROVAL',
            `Payout of ₦${payoutAmount.toLocaleString()} held for Dual Authorization`,
            `Vendor balance: ₦${payoutAmount}`,
            'Reserved/Frozen in Ledger',
            ipAddress
          ]
        );
      } else {
        // Normal payout flow
        await db.run(
          'INSERT INTO payouts (id, vendor_id, batch_id, amount, idempotency_key, status) VALUES (?, ?, ?, ?, ?, ?)',
          [payoutId, vendorId, batchId, payoutAmount, idempotencyKey, 'PROCESSING']
        );
        await ledger.recordPayout(payoutId, batchId, vendorId, payoutAmount);
        await executeSinglePayout(payoutId, vendorId, batchId, payoutAmount, vendor, idempotencyKey);
      }
    } catch (err) {
      console.error('[SETTLEMENT] Payout error:', err);
    } finally {
      processingVendors.delete(vendorId);
    }
  }

  // 2. Execute already-approved high-value payouts
  for (const payout of approvedPayouts) {
    if (processingVendors.has(payout.vendor_id)) continue;
    processingVendors.add(payout.vendor_id);

    try {
      const vendor = await db.get('SELECT * FROM vendors WHERE id = ?', [payout.vendor_id]);
      if (!vendor) throw new Error(`Vendor not found: ${payout.vendor_id}`);

      await db.run('UPDATE payouts SET batch_id = ?, status = ? WHERE id = ?', [
        batchId, 'PROCESSING', payout.id
      ]);

      await executeSinglePayout(payout.id, payout.vendor_id, batchId, payout.amount, vendor, payout.idempotency_key);
    } catch (err) {
      console.error('[SETTLEMENT] Approved payout error:', err);
    } finally {
      processingVendors.delete(payout.vendor_id);
    }
  }

  // Resolve batch status
  const payoutsInBatch = await db.all('SELECT status FROM payouts WHERE batch_id = ?', [batchId]);
  const statuses = payoutsInBatch.map((p) => p.status);

  let batchStatus = 'COMPLETED';
  if (statuses.includes('FAILED') && statuses.includes('COMPLETED')) {
    batchStatus = 'PARTIAL_SUCCESS';
  } else if (statuses.length > 0 && statuses.every((s) => s === 'FAILED')) {
    batchStatus = 'FAILED';
  } else if (statuses.includes('PROCESSING') || statuses.includes('PENDING_APPROVAL')) {
    batchStatus = 'PROCESSING';
  }

  await db.run('UPDATE settlement_batches SET status = ? WHERE id = ?', [batchStatus, batchId]);

  await db.run(
    'INSERT INTO audit_logs (username, action, details, ip_address) VALUES (?, ?, ?, ?)',
    [userId, 'END_SETTLEMENT_BATCH', `Batch ${batchId} finished — ${batchStatus}`, ipAddress]
  );

  return { batchId, status: batchStatus };
};

// Approve a pending high-value payout
const approvePayout = async (payoutId, username, role, ipAddress = '127.0.0.1') => {
  const payout = await db.get('SELECT * FROM payouts WHERE id = ?', [payoutId]);
  if (!payout) throw new Error('Payout not found');
  if (payout.status !== 'PENDING_APPROVAL') throw new Error('Payout does not require approval');

  if (role === 'ADMIN') {
    if (payout.approved_by_admin) throw new Error('ADMIN has already signed this payout');
    await db.run('UPDATE payouts SET approved_by_admin = ? WHERE id = ?', [username, payoutId]);
  } else if (role === 'FINANCE') {
    if (payout.approved_by_finance) throw new Error('FINANCE has already signed this payout');
    await db.run('UPDATE payouts SET approved_by_finance = ? WHERE id = ?', [username, payoutId]);
  } else {
    throw new Error('Unauthorized role for approval');
  }

  await db.run(
    'INSERT INTO audit_logs (username, action, details, before_state, after_state, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
    [username, 'APPROVE_PAYOUT', `Signed payout ${payoutId} as ${role}`, JSON.stringify(payout), `Approved by ${role}`, ipAddress]
  );

  return { status: 'success', message: `Payout signed by ${role}` };
};

// Handle async Nomba webhook confirmation
const processNombaWebhook = async (payoutId, providerStatus, providerRef) => {
  const payout = await db.get('SELECT * FROM payouts WHERE id = ?', [payoutId]);
  if (!payout) throw new Error(`Payout ${payoutId} not found`);

  if (payout.status !== 'PROCESSING') {
    return { status: 'ALREADY_RESOLVED', payoutStatus: payout.status };
  }

  if (providerStatus === 'SUCCESS') {
    await db.run('UPDATE payouts SET status = ?, provider_reference = ? WHERE id = ?', ['COMPLETED', providerRef, payoutId]);
  } else {
    await ledger.reversePayout(payoutId, payout.batch_id, payout.vendor_id, payout.amount, `Webhook failure: ${providerStatus}`);
  }

  // Re-check and update batch status
  const payoutsInBatch = await db.all('SELECT status FROM payouts WHERE batch_id = ?', [payout.batch_id]);
  const statuses = payoutsInBatch.map((p) => p.status);
  let batchStatus = 'COMPLETED';
  if (statuses.includes('FAILED') && statuses.includes('COMPLETED')) batchStatus = 'PARTIAL_SUCCESS';
  else if (statuses.every((s) => s === 'FAILED')) batchStatus = 'FAILED';
  else if (statuses.includes('PROCESSING')) batchStatus = 'PROCESSING';
  await db.run('UPDATE settlement_batches SET status = ? WHERE id = ?', [batchStatus, payout.batch_id]);

  return { status: 'RESOLVED', payoutStatus: providerStatus === 'SUCCESS' ? 'COMPLETED' : 'FAILED' };
};

module.exports = { runSettlementBatch, approvePayout, processNombaWebhook };
