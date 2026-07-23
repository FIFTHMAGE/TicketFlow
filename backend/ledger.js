const db = require('./db');

// Record a successful ticket purchase in the ledger
// DEBIT Settlement Pool (Asset)
// CREDIT Vendor Payable (Liability)
// CREDIT Platform Revenue (Revenue)
const recordPurchase = async (txRef, grossAmount, platformId, vendorId) => {
  return db.runTransaction(async () => {
    // 1. Fetch splits configuration from platforms table
    const platform = await db.get('SELECT * FROM platforms WHERE id = ?', [platformId]);
    if (!platform) {
      throw new Error(`Platform ${platformId} not found`);
    }

    const { vendor_split_pct, platform_split_pct } = platform;
    if (Math.abs((vendor_split_pct + platform_split_pct) - 100.0) > 0.01) {
      throw new Error(`Platform split percentages must sum to 100. Currently: ${vendor_split_pct} + ${platform_split_pct}`);
    }

    const platformFee = (grossAmount * platform_split_pct) / 100.0;
    const vendorAmount = (grossAmount * vendor_split_pct) / 100.0;

    // Validate balance constraints: Debits = Credits
    const debitTotal = grossAmount;
    const creditTotal = platformFee + vendorAmount;
    if (Math.abs(debitTotal - creditTotal) > 0.01) {
      throw new Error(`Double-entry validation failed: Debits (${debitTotal}) must equal Credits (${creditTotal})`);
    }

    const vendorAccount = `VENDOR_PAYABLE_${vendorId}`;

    // 2. Check if vendor account exists, create if not
    const vAcc = await db.get('SELECT * FROM ledger_accounts WHERE id = ?', [vendorAccount]);
    if (!vAcc) {
      await db.run(
        'INSERT INTO ledger_accounts (id, name, type, balance) VALUES (?, ?, ?, 0.0)',
        [vendorAccount, `Vendor Payable - ${vendorId}`, 'LIABILITY']
      );
    }

    // 3. Insert ledger entries
    // DEBIT Settlement Pool
    await db.run(
      'INSERT INTO ledger_entries (reference, account_id, type, amount, description) VALUES (?, ?, ?, ?, ?)',
      [txRef, 'SETTLEMENT_POOL', 'DEBIT', grossAmount, `Crypto Payment Received for Ticket Purchase - Reference: ${txRef}`]
    );

    // CREDIT Vendor Payable
    await db.run(
      'INSERT INTO ledger_entries (reference, account_id, type, amount, description) VALUES (?, ?, ?, ?, ?)',
      [txRef, vendorAccount, 'CREDIT', vendorAmount, `Vendor Allocation (${vendor_split_pct}%) - Ticket Purchase - Reference: ${txRef}`]
    );

    // CREDIT Platform Revenue
    await db.run(
      'INSERT INTO ledger_entries (reference, account_id, type, amount, description) VALUES (?, ?, ?, ?, ?)',
      [txRef, 'PLATFORM_REVENUE', 'CREDIT', platformFee, `Platform Commission Fee (${platform_split_pct}%) - Reference: ${txRef}`]
    );

    // 4. Update ledger account balances
    await db.run('UPDATE ledger_accounts SET balance = balance + ? WHERE id = ?', [grossAmount, 'SETTLEMENT_POOL']);
    await db.run('UPDATE ledger_accounts SET balance = balance + ? WHERE id = ?', [vendorAmount, vendorAccount]);
    await db.run('UPDATE ledger_accounts SET balance = balance + ? WHERE id = ?', [platformFee, 'PLATFORM_REVENUE']);

    // 5. Update transaction status in DB to ALLOCATED_TO_LEDGER
    await db.run('UPDATE transactions SET status = ? WHERE reference = ?', ['ALLOCATED_TO_LEDGER', txRef]);

    return { status: 'success', platformFee, vendorAmount };
  });
};

// Record a vendor payout in the ledger
// DEBIT Vendor Payable (Liability decreases)
// CREDIT Settlement Pool (Asset decreases)
const recordPayout = async (payoutId, batchId, vendorId, amount) => {
  return db.runTransaction(async () => {
    const vendorAccount = `VENDOR_PAYABLE_${vendorId}`;

    // Verify vendor has sufficient balance
    const vAcc = await db.get('SELECT * FROM ledger_accounts WHERE id = ?', [vendorAccount]);
    if (!vAcc || vAcc.balance < amount) {
      throw new Error(`Insufficient funds for vendor payout. Available: ${vAcc ? vAcc.balance : 0}, Required: ${amount}`);
    }

    // 1. Insert Ledger entries
    // DEBIT Vendor Payable
    await db.run(
      'INSERT INTO ledger_entries (reference, account_id, type, amount, description) VALUES (?, ?, ?, ?, ?)',
      [payoutId, vendorAccount, 'DEBIT', amount, `Vendor Batch Payout - Batch: ${batchId}, Payout: ${payoutId}`]
    );

    // CREDIT Settlement Pool
    await db.run(
      'INSERT INTO ledger_entries (reference, account_id, type, amount, description) VALUES (?, ?, ?, ?, ?)',
      [payoutId, 'SETTLEMENT_POOL', 'CREDIT', amount, `Settlement Pool Payout to Vendor - Batch: ${batchId}, Payout: ${payoutId}`]
    );

    // 2. Update ledger account balances
    await db.run('UPDATE ledger_accounts SET balance = balance - ? WHERE id = ?', [amount, vendorAccount]);
    await db.run('UPDATE ledger_accounts SET balance = balance - ? WHERE id = ?', [amount, 'SETTLEMENT_POOL']);

    return { status: 'success' };
  });
};

// Return returned/failed payout to vendor payable balance
const reversePayout = async (payoutId, batchId, vendorId, amount, reason) => {
  return db.runTransaction(async () => {
    const vendorAccount = `VENDOR_PAYABLE_${vendorId}`;

    // Reversal entry (inverse of payout)
    // DEBIT Settlement Pool
    await db.run(
      'INSERT INTO ledger_entries (reference, account_id, type, amount, description) VALUES (?, ?, ?, ?, ?)',
      [payoutId, 'SETTLEMENT_POOL', 'DEBIT', amount, `REVERSAL: Payout Failed. Returning to Settlement Pool. Reason: ${reason}`]
    );

    // CREDIT Vendor Payable
    await db.run(
      'INSERT INTO ledger_entries (reference, account_id, type, amount, description) VALUES (?, ?, ?, ?, ?)',
      [payoutId, vendorAccount, 'CREDIT', amount, `REVERSAL: Payout Failed. Refunding Vendor Balance. Reason: ${reason}`]
    );

    // Update balances
    await db.run('UPDATE ledger_accounts SET balance = balance + ? WHERE id = ?', [amount, vendorAccount]);
    await db.run('UPDATE ledger_accounts SET balance = balance + ? WHERE id = ?', [amount, 'SETTLEMENT_POOL']);

    // Update Payout Status to FAILED
    await db.run('UPDATE payouts SET status = ? WHERE id = ?', ['FAILED', payoutId]);

    return { status: 'success' };
  });
};

module.exports = {
  recordPurchase,
  recordPayout,
  reversePayout
};
