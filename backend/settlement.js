const db = require('./db');
const ledger = require('./ledger');

const processingVendors = new Set();
const APPROVAL_THRESHOLD = 5000000.0; // ₦5,000,000

// Mock Nomba transfer API
const callNombaTransferAPI = async (payload, idempotencyKey) => {
  await new Promise((resolve) => setTimeout(resolve, 800));

  if (payload.accountNumber.endsWith('99') || payload.accountNumber === '9999999999') {
    return {
      status: false,
      code: '99',
      message: 'Account validation failed'
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

// Execute single payout logic
const executeSinglePayout = async (payoutId, vendorId, batchId, payoutAmount, vendor, idempotencyKey) => {
  try {
    const nombaPayload = {
      amount: payoutAmount,
      accountNumber: vendor.account_number,
      accountName: vendor.account_name,
      bankCode: '058',
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
        await ledger.reversePayout(payoutId, batchId, vendorId, payoutAmount, 'Nomba status failed');
      }
    } else {
      await ledger.reversePayout(payoutId, batchId, vendorId, payoutAmount, result.message || 'API rejected');
    }
  } catch (err) {
    console.error(`Error executing Nomba transfer for payout ${payoutId}:`, err);
    await ledger.reversePayout(payoutId, batchId, vendorId, payoutAmount, err.message);
  }
};

// Batch settlement worker
const runSettlementBatch = async (userId = 'system', ipAddress = '127.0.0.1') => {
  const batchId = `BATCH_${Date.now()}`;

  // Log action
  await db.run(
    'INSERT INTO audit_logs (username, action, details, ip_address) VALUES (?, ?, ?, ?)',
    [userId, 'START_SETTLEMENT_BATCH', `Initiated settlement batch: ${batchId}`, ipAddress]
  );

  // Retrieve vendors with active payable balance > 0
  const accounts = await db.all(
    "SELECT id, balance FROM ledger_accounts WHERE id LIKE 'VENDOR_PAYABLE_%' AND balance > 0"
  );

  // Also retrieve already created payouts that were pending approval but are now fully approved and ready for execution
  const approvedPayouts = await db.all(
    `SELECT * FROM payouts 
     WHERE status = 'PENDING_APPROVAL' 
     AND approved_by_finance IS NOT NULL 
     AND approved_by_admin IS NOT NULL`
  );

  if (accounts.length === 0 && approvedPayouts.length === 0) {
    await db.run(
      'INSERT INTO audit_logs (username, action, details, ip_address) VALUES (?, ?, ?, ?)',
      [userId, 'END_SETTLEMENT_BATCH', `No pending balances or approved payouts. Batch ${batchId} skipped.`, ipAddress]
    );
    return { batchId, status: 'NO_PENDING_BALANCES' };
  }

  await db.run('INSERT INTO settlement_batches (id, status) VALUES (?, ?)', [batchId, 'PENDING']);

  // 1. Process new payouts from ledger account balances
  for (const account of accounts) {
    const vendorId = account.id.replace('VENDOR_PAYABLE_', '');

    if (processingVendors.has(vendorId)) {
      continue;
    }
    processingVendors.add(vendorId);

    const payoutAmount = account.balance;
    const payoutId = `PAYOUT_${vendorId}_${Date.now()}`;
    const idempotencyKey = `payout_${vendorId}_batch_${batchId}`;

    try {
      const vendor = await db.get('SELECT * FROM vendors WHERE id = ?', [vendorId]);
      if (!vendor) {
        throw new Error(`Vendor details not found for ${vendorId}`);
      }

      // Check if threshold limit is reached
      if (payoutAmount >= APPROVAL_THRESHOLD) {
        // Insert as PENDING_APPROVAL and do not call Nomba transfer
        await db.run(
          `INSERT INTO payouts (id, vendor_id, batch_id, amount, idempotency_key, status) 
           VALUES (?, ?, ?, ?, ?, ?)`,
          [payoutId, vendorId, batchId, payoutAmount, idempotencyKey, 'PENDING_APPROVAL']
        );

        // Debit the ledger immediately to reserve/freeze the balance
        await ledger.recordPayout(payoutId, batchId, vendorId, payoutAmount);

        await db.run(
          'INSERT INTO audit_logs (username, action, details, before_state, after_state, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
          [
            userId,
            'PAYOUT_HELD_FOR_APPROVAL',
            `Payout of ₦${payoutAmount.toLocaleString()} held for Dual Authorization.`,
            `Vendor balance: ${payoutAmount}`,
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
      console.error(`Error processing payout:`, err);
    } finally {
      processingVendors.delete(vendorId);
    }
  }

  // 2. Process already approved payouts from previous batches
  for (const payout of approvedPayouts) {
    if (processingVendors.has(payout.vendor_id)) {
      continue;
    }
    processingVendors.add(payout.vendor_id);

    try {
      const vendor = await db.get('SELECT * FROM vendors WHERE id = ?', [payout.vendor_id]);
      if (!vendor) {
        throw new Error(`Vendor details not found for ${payout.vendor_id}`);
      }

      // Update batch link and set status to PROCESSING
      await db.run('UPDATE payouts SET batch_id = ?, status = ? WHERE id = ?', [
        batchId,
        'PROCESSING',
        payout.id
      ]);

      await executeSinglePayout(payout.id, payout.vendor_id, batchId, payout.amount, vendor, payout.idempotency_key);
    } catch (err) {
      console.error(err);
    } finally {
      processingVendors.delete(payout.vendor_id);
    }
  }

  // Update Batch overall status
  const payoutsInBatch = await db.all('SELECT status FROM payouts WHERE batch_id = ?', [batchId]);
  const statuses = payoutsInBatch.map((p) => p.status);

  let batchStatus = 'COMPLETED';
  if (statuses.includes('FAILED') && statuses.includes('COMPLETED')) {
    batchStatus = 'PARTIAL_SUCCESS';
  } else if (statuses.every((s) => s === 'FAILED')) {
    batchStatus = 'FAILED';
  } else if (statuses.includes('PROCESSING') || statuses.includes('PENDING_APPROVAL')) {
    batchStatus = 'PROCESSING';
  }

  await db.run('UPDATE settlement_batches SET status = ? WHERE id = ?', [batchStatus, batchId]);

  await db.run(
    'INSERT INTO audit_logs (username, action, details, ip_address) VALUES (?, ?, ?, ?)',
    [userId, 'END_SETTLEMENT_BATCH', `Settlement batch: ${batchId} finished with status ${batchStatus}`, ipAddress]
  );

  return { batchId, status: batchStatus };
};

// Approve payout logic
const approvePayout = async (payoutId, username, role, ipAddress = '127.0.0.1') => {
  const payout = await db.get('SELECT * FROM payouts WHERE id = ?', [payoutId]);
  if (!payout) throw new Error('Payout not found');
  if (payout.status !== 'PENDING_APPROVAL') throw new Error('Payout does not require approval');

  let updateQuery = '';
  if (role === 'ADMIN') {
    updateQuery = 'UPDATE payouts SET approved_by_admin = ? WHERE id = ?';
  } else if (role === 'FINANCE') {
    updateQuery = 'UPDATE payouts SET approved_by_finance = ? WHERE id = ?';
  } else {
    throw new Error('Unauthorized role for approval');
  }

  await db.run(updateQuery, [username, payoutId]);

  await db.run(
    'INSERT INTO audit_logs (username, action, details, before_state, after_state, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
    [
      username,
      'APPROVE_PAYOUT',
      `Approved payout ${payoutId} as ${role}`,
      JSON.stringify(payout),
      `Approved by ${role}`,
      ipAddress
    ]
  );

  return { status: 'success' };
};

// Process Nomba Webhook
const processNombaWebhook = async (payoutId, providerStatus, providerRef) => {
  const payout = await db.get('SELECT * FROM payouts WHERE id = ?', [payoutId]);
  if (!payout) {
    throw new Error(`Payout ${payoutId} not found`);
  }

  if (payout.status !== 'PROCESSING') {
    return { status: 'ALREADY_RESOLVED', payoutStatus: payout.status };
  }

  if (providerStatus === 'SUCCESS') {
    await db.run('UPDATE payouts SET status = ? WHERE id = ?', ['COMPLETED', payoutId]);
  } else {
    await ledger.reversePayout(payoutId, payout.batch_id, payout.vendor_id, payout.amount, `Webhook reported failure: ${providerStatus}`);
  }

  // Re-check batch status
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
  approvePayout,
  processNombaWebhook
};
