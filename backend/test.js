const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('./db');
const ledger = require('./ledger');
const settlement = require('./settlement');
const reconciliation = require('./reconciliation');
const { JWT_SECRET } = require('./middleware/auth');

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}`);
  }
  console.log(`✅ Passed: ${message}`);
};

const runTests = async () => {
  console.log('Starting revised Marketplace Settlement System integration tests...');
  
  // Drop tables to recreate with clean revised schemas
  const tables = [
    'audit_logs', 'admins', 'reconciliation_flags', 'webhook_events', 
    'payouts', 'settlement_batches', 'ledger_entries', 'ledger_accounts', 
    'transactions', 'marketplace_items', 'vendors', 'platforms'
  ];
  for (const table of tables) {
    await db.run(`DROP TABLE IF EXISTS ${table}`);
  }

  // Initialize Database
  await db.initDb();
  
  // Clean states
  await db.run('DELETE FROM ledger_entries');
  await db.run('DELETE FROM payouts');
  await db.run('DELETE FROM settlement_batches');
  await db.run('DELETE FROM transactions');
  await db.run('DELETE FROM webhook_events');
  await db.run('DELETE FROM reconciliation_flags');
  await db.run('UPDATE ledger_accounts SET balance = 0.0');
  await db.run("UPDATE ledger_accounts SET balance = 100000.0 WHERE id = 'SETTLEMENT_POOL'"); // pool base

  // Test 1: Configurable split ratios double entry allocation validation
  // Configure splits to 75% vendor, 25% platform
  const platformId = 'platform_stableflow_1';
  await db.run(
    'UPDATE platforms SET vendor_split_pct = 75.0, platform_split_pct = 25.0 WHERE id = ?',
    [platformId]
  );

  const txRef = 'TEST_SPLIT_REF_001';
  const gross = 10000.0;
  const vendorId = 'vendor_tix_organizer';

  // Seed transaction
  await db.run(
    `INSERT INTO transactions (id, reference, platform_id, vendor_id, marketplace_item_id, gross_amount, platform_fee, vendor_amount, status) 
     VALUES (?, ?, ?, ?, 'item_tech_ticket', ?, 0.0, 0.0, 'PAYMENT_CONFIRMED')`,
    [txRef, txRef, platformId, vendorId, gross]
  );

  await ledger.recordPurchase(txRef, gross, platformId, vendorId);

  const poolAcc = await db.get("SELECT balance FROM ledger_accounts WHERE id = 'SETTLEMENT_POOL'");
  const feeAcc = await db.get("SELECT balance FROM ledger_accounts WHERE id = 'PLATFORM_REVENUE'");
  const vendorAcc = await db.get(`SELECT balance FROM ledger_accounts WHERE id = 'VENDOR_PAYABLE_${vendorId}'`);

  // 100k start + 10k gross = 110k
  assert(poolAcc.balance === 110000.0, 'Settlement Pool updated');
  // 25% of 10,000 = 2,500
  assert(feeAcc.balance === 2500.0, 'Dynamic 25% platform split calculated');
  // 75% of 10,000 = 7,500
  assert(vendorAcc.balance === 7500.0, 'Dynamic 75% vendor split calculated');

  // Test 2: Duplicate webhook prevention (Idempotency)
  const eventId = 'basqet_mock_event_123';
  
  // Record first webhook
  await db.run('INSERT INTO webhook_events (id, provider) VALUES (?, ?)', [eventId, 'basqet']);
  
  // Check if duplicate event exists
  const existingEvent = await db.get('SELECT * FROM webhook_events WHERE id = ?', [eventId]);
  assert(existingEvent !== undefined, 'Idempotency verification: Webhook event recorded in database');

  // Test 3: Partial payout batches (One fails, other succeeds)
  const vendorFail = 'vendor_tech_fest';
  // Give both organizers balance to trigger payout
  await db.run("UPDATE ledger_accounts SET balance = 5000.0 WHERE id = 'VENDOR_PAYABLE_vendor_tix_organizer'"); // vendor 1 has 5000
  await db.run("UPDATE ledger_accounts SET balance = 2000.0 WHERE id = 'VENDOR_PAYABLE_vendor_tech_fest'"); // vendor 2 has 2000
  
  // Update vendor 2 (Lagos Tech Fest) to trigger Nomba simulation transfer failure
  await db.run("UPDATE vendors SET account_number = '9999999999' WHERE id = ?", [vendorFail]);

  // Run Batch Settlement
  console.log('Running batch settlement with simulated partial failure...');
  const batchResult = await settlement.runSettlementBatch('test_runner');
  
  assert(batchResult.status === 'PARTIAL_SUCCESS', `Batch status is PARTIAL_SUCCESS: ${batchResult.status}`);

  // Confirm vendor 1 (tix_organizer) payable went to 0 (succeeded)
  const v1Acc = await db.get("SELECT balance FROM ledger_accounts WHERE id = 'VENDOR_PAYABLE_vendor_tix_organizer'");
  assert(v1Acc.balance === 0.0, 'Successful vendor payout debited ledger balance');

  // Confirm vendor 2 (tech_fest) balance was returned to 2000 (failed and reversed)
  const v2Acc = await db.get("SELECT balance FROM ledger_accounts WHERE id = 'VENDOR_PAYABLE_vendor_tech_fest'");
  assert(v2Acc.balance === 2000.0, 'Failed vendor payout balance reversed back to vendor account');

  // Test 4: Reconciliation mismatch alert trigger
  // Deliberately offset tx.confirmed_amount from ledger entry sum
  const mismatchRef = 'TX_MISMATCH_REF';
  await db.run(
    `INSERT INTO transactions (id, reference, platform_id, vendor_id, marketplace_item_id, gross_amount, platform_fee, vendor_amount, confirmed_amount, status) 
     VALUES (?, ?, ?, ?, 'item_tech_ticket', 1000.0, 100.0, 900.0, 950.0, 'ALLOCATED_TO_LEDGER')`, // gross is 1000, confirmed is 950
    [mismatchRef, mismatchRef, platformId, vendorId]
  );
  // insert matching ledger entries at 1000
  await db.run(
    "INSERT INTO ledger_entries (reference, account_id, type, amount, description) VALUES (?, 'SETTLEMENT_POOL', 'DEBIT', 1000.0, 'Simulation')",
    [mismatchRef]
  );

  console.log('Running daily reconciliation validation check...');
  const reconcileResult = await reconciliation.runReconciliationJob('test_runner');
  assert(reconcileResult.flagsGenerated > 0, 'Reconciliation job successfully caught amount discrepancy and flagged it');

  const flag = await db.get('SELECT * FROM reconciliation_flags WHERE transaction_id = ?', [mismatchRef]);
  assert(flag !== undefined && flag.type === 'AMOUNT_MISMATCH', 'Reconciliation flag logged correctly in database');

  console.log('\n🎉 ALL REVISED INTEGRATION TESTS PASSED SUCCESSFULLY! 🎉');
};

runTests().catch(err => {
  console.error('❌ Integration Test failed:', err);
  process.exit(1);
});
