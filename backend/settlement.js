const db = require('./db');
const ledger = require('./ledger');

// Simple set to prevent overlapping in-memory worker runs per vendor
const processingVendors = new Set();

// Mock Nomba transfer request
const callNombaTransferAPI = async (payload, idempotencyKey) => {
  // Simulate network delay
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Simulating typical Nomba API behaviors (referencing Nomba doc)
  // For sandbox testing, we succeed most of the time
  // If account number ends in 99, fail it to demonstrate recovery flows
  if (payload.accountNumber.endsWith('99')) {
    return {
      status: false,
      code: '99',
      message: 'Account validation failed'
    };
  }

  // If amount is exactly 1234, simulate pending billing (needs webhook completion)
  if (payload.amount === 1234) {
    return {
      status: true,
      code: '200',
      message: 'Processing',
      data: {
        id: `NOMBA_TX_${Date.now()}`,
        status: 'PENDING_BILLING',
        amount: payload.amount
      }
    };
  }

  return {
    status: true,
    code: '200',
    message: 'Success',
    data: {
      id: `NOMBA_TX_${Date.now()}`,
      status: 'SUCCESS',
      amount: payload.amount
    }
  };
};

// Main function to execute settlement batch
const runSettlementBatch = async (userId = 'system') => {
  const batchId = `BATCH_${Date.now()}`;

  // Log action
  await db.run('INSERT INTO audit_logs (username, action, details) VALUES (?, ?, ?)', [
    userId,
    'START_SETTLEMENT_BATCH',
    `Initiated settlement batch: ${batchId}`
  ]);

  // Retrieve all vendors with active payable balance > 0
  const accounts = await db.all(
    "SELECT id, balance FROM ledger_accounts WHERE id LIKE 'VENDOR_PAYABLE_%' AND balance > 0"
  );

  if (accounts.length === 0) {
    await db.run('INSERT INTO audit_logs (username, action, details) VALUES (?, ?, ?)', [
      userId,
      'END_SETTLEMENT_BATCH',
      `No pending balances. Batch ${batchId} skipped.`
    ]);
    return { batchId, status: 'NO_PENDING_BALANCES' };
  }

  // Create Batch
  await db.run('INSERT INTO settlement_batches (id, status) VALUES (?, ?)', [batchId, 'PENDING']);

  for (const account of accounts) {
    const vendorId = account.id.replace('VENDOR_PAYABLE_', '');
    
    // Check local lock to prevent concurrent double payout processing
    if (processingVendors.has(vendorId)) {
      continue;
    }
    processingVendors.add(vendorId);

    const payoutAmount = account.balance;
    const payoutId = `PAYOUT_${vendorId}_${Date.now()}`;
    const idempotencyKey = `payout_${vendorId}_batch_${batchId}`;

    try {
      // Retrieve vendor bank details
      const vendor = await db.get('SELECT * FROM vendors WHERE id = ?', [vendorId]);
      if (!vendor) {
        throw new Error(`Vendor details not found for ${vendorId}`);
      }

      // 1. Create Payout entry in DB as PROCESSING and immediately update ledger
      await db.run(
        'INSERT INTO payouts (id, vendor_id, batch_id, amount, idempotency_key, status) VALUES (?, ?, ?, ?, ?, ?)',
        [payoutId, vendorId, batchId, payoutAmount, idempotencyKey, 'PROCESSING']
      );

      // Debit the vendor balance immediately on the ledger before calling API
      await ledger.recordPayout(payoutId, batchId, vendorId, payoutAmount);

      // 2. Call Nomba Payout Infrastructure
      const nombaPayload = {
        amount: payoutAmount,
        accountNumber: vendor.account_number,
        accountName: vendor.account_name,
        bankCode: '058', // Mock bank code
        merchantTxRef: payoutId,
        senderName: 'StableFlow',
        narration: `Payout Batch ${batchId}`
      };

      const result = await callNombaTransferAPI(nombaPayload, idempotencyKey);

      if (result.status && result.data) {
        const providerRef = result.data.id;
        await db.run('UPDATE payouts SET provider_reference = ? WHERE id = ?', [providerRef, payoutId]);

        if (result.data.status === 'SUCCESS') {
          // Mark Completed
          await db.run('UPDATE payouts SET status = ? WHERE id = ?', ['COMPLETED', payoutId]);
        } else if (result.data.status === 'PENDING_BILLING') {
          // Keep status as PROCESSING, wait for webhook callback
        } else {
          // Treat as failed and reverse balance
          await ledger.reversePayout(payoutId, batchId, vendorId, payoutAmount, 'Nomba status failed');
        }
      } else {
        // Validation failed / Nomba returned error code
        await ledger.reversePayout(payoutId, batchId, vendorId, payoutAmount, result.message || 'API rejected');
      }
    } catch (err) {
      console.error(`Error processing payout for vendor ${vendorId}:`, err);
      // Reverse payout on generic error
      try {
        await ledger.reversePayout(payoutId, batchId, vendorId, payoutAmount, err.message);
      } catch (revErr) {
        console.error(`Double-fault: failed to reverse payout for ${vendorId}:`, revErr);
      }
    } finally {
      // Unlock vendor processing
      processingVendors.delete(vendorId);
    }
  }

  // Update Batch overall status based on payout results
  const payoutsInBatch = await db.all('SELECT status FROM payouts WHERE batch_id = ?', [batchId]);
  const statuses = payoutsInBatch.map((p) => p.status);

  let batchStatus = 'COMPLETED';
  if (statuses.includes('FAILED') && statuses.includes('COMPLETED')) {
    batchStatus = 'PARTIAL_SUCCESS';
  } else if (statuses.every((s) => s === 'FAILED')) {
    batchStatus = 'FAILED';
  } else if (statuses.includes('PROCESSING')) {
    batchStatus = 'PROCESSING';
  }

  await db.run('UPDATE settlement_batches SET status = ? WHERE id = ?', [batchStatus, batchId]);

  await db.run('INSERT INTO audit_logs (username, action, details) VALUES (?, ?, ?)', [
    userId,
    'END_SETTLEMENT_BATCH',
    `Settlement batch: ${batchId} finished with status ${batchStatus}`
  ]);

  return { batchId, status: batchStatus };
};

// Nomba Webhook processing to settle pending payouts
const processNombaWebhook = async (payoutId, providerStatus, providerRef) => {
  const payout = await db.get('SELECT * FROM payouts WHERE id = ?', [payoutId]);
  if (!payout) {
    throw new Error(`Payout ${payoutId} not found`);
  }

  if (payout.status !== 'PROCESSING') {
    // Already resolved (e.g. idempotency, duplicate webhook retry)
    return { status: 'ALREADY_RESOLVED', payoutStatus: payout.status };
  }

  if (providerStatus === 'SUCCESS') {
    await ledger.recordPayout(payoutId, payout.batch_id, payout.vendor_id, payout.amount);
  } else {
    await ledger.reversePayout(payoutId, payout.batch_id, payout.vendor_id, payout.amount, `Webhook reported failure: ${providerStatus}`);
  }

  // Re-check overall batch status
  const payoutsInBatch = await db.all('SELECT status FROM payouts WHERE batch_id = ?', [payout.batch_id]);
  const statuses = payoutsInBatch.map((p) => p.status);
  let batchStatus = 'COMPLETED';
  if (statuses.includes('FAILED') && statuses.includes('COMPLETED')) {
    batchStatus = 'PARTIAL_SUCCESS';
  } else if (statuses.every((s) => s === 'FAILED')) {
    batchStatus = 'FAILED';
  } else if (statuses.includes('PROCESSING')) {
    batchStatus = 'PROCESSING';
  }
  await db.run('UPDATE settlement_batches SET status = ? WHERE id = ?', [batchStatus, payout.batch_id]);

  return { status: 'RESOLVED', payoutStatus: providerStatus === 'SUCCESS' ? 'COMPLETED' : 'FAILED' };
};

module.exports = {
  runSettlementBatch,
  processNombaWebhook
};
