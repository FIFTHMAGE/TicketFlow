const db = require('./db');

async function runReconciliationJob(userId = 'system') {
  await db.run('INSERT INTO audit_logs (username, action, details) VALUES (?, ?, ?)', [
    userId,
    'START_RECONCILIATION_JOB',
    'Reconciliation engine verification started.'
  ]);

  // Fetch confirmed/allocated transactions
  const transactions = await db.all(
    "SELECT * FROM transactions WHERE status IN ('PAYMENT_CONFIRMED', 'ALLOCATED_TO_LEDGER')"
  );

  let flagsCreated = 0;

  for (const tx of transactions) {
    const ledgerEntries = await db.all(
      "SELECT amount, type FROM ledger_entries WHERE reference = ? AND account_id = 'SETTLEMENT_POOL'",
      [tx.reference]
    );

    let ledgerPurchaseSum = 0;
    ledgerEntries.forEach((e) => {
      if (e.type === 'DEBIT') ledgerPurchaseSum += e.amount;
    });

    const confirmedAmount = tx.confirmed_amount !== null ? tx.confirmed_amount : tx.gross_amount;
    const discrepancy = Math.abs(ledgerPurchaseSum - confirmedAmount);

    if (discrepancy > 0.01) {
      const existingFlag = await db.get(
        'SELECT id FROM reconciliation_flags WHERE transaction_id = ? AND type = ?',
        [tx.reference, 'AMOUNT_MISMATCH']
      );

      if (!existingFlag) {
        await db.run(
          'INSERT INTO reconciliation_flags (transaction_id, type, amount_difference, description) VALUES (?, ?, ?, ?)',
          [
            tx.reference,
            'AMOUNT_MISMATCH',
            discrepancy,
            `Confirmed amount (₦${confirmedAmount}) does not match ledger pool DEBIT (₦${ledgerPurchaseSum})`
          ]
        );
        flagsCreated++;
      }
    }
  }

  // Audit double-entry balance across entire ledger
  const entries = await db.all('SELECT type, amount FROM ledger_entries');
  let totalDebits = 0;
  let totalCredits = 0;
  entries.forEach((e) => {
    if (e.type === 'DEBIT') totalDebits += e.amount;
    if (e.type === 'CREDIT') totalCredits += e.amount;
  });

  const isDoubleEntryValid = Math.abs(totalDebits - totalCredits) < 0.01;
  if (!isDoubleEntryValid) {
    // Use a stable key — only one LEDGER_UNBALANCED flag can ever exist
    const stableKey = 'LEDGER_DOUBLE_ENTRY_CHECK';
    const existingFlag = await db.get(
      'SELECT id FROM reconciliation_flags WHERE transaction_id = ? AND type = ?',
      [stableKey, 'LEDGER_UNBALANCED']
    );

    if (!existingFlag) {
      await db.run(
        'INSERT INTO reconciliation_flags (transaction_id, type, amount_difference, description) VALUES (?, ?, ?, ?)',
        [
          stableKey,
          'LEDGER_UNBALANCED',
          Math.abs(totalDebits - totalCredits),
          `Double-entry ledger unbalanced. Total Debits: ₦${totalDebits.toFixed(2)}, Total Credits: ₦${totalCredits.toFixed(2)}`
        ]
      );
      flagsCreated++;
    } else {
      // Update existing flag with latest figures (in case the gap changed)
      await db.run(
        'UPDATE reconciliation_flags SET amount_difference = ?, description = ? WHERE transaction_id = ? AND type = ?',
        [
          Math.abs(totalDebits - totalCredits),
          `Double-entry ledger unbalanced. Total Debits: ₦${totalDebits.toFixed(2)}, Total Credits: ₦${totalCredits.toFixed(2)}`,
          stableKey,
          'LEDGER_UNBALANCED'
        ]
      );
    }
  } else {
    // Ledger is now balanced — clear any existing LEDGER_UNBALANCED flag
    await db.run(
      "DELETE FROM reconciliation_flags WHERE transaction_id = ? AND type = ?",
      ['LEDGER_DOUBLE_ENTRY_CHECK', 'LEDGER_UNBALANCED']
    );
  }

  await db.run('INSERT INTO audit_logs (username, action, details) VALUES (?, ?, ?)', [
    userId,
    'END_RECONCILIATION_JOB',
    `Reconciliation finished. New flags: ${flagsCreated}`
  ]);

  return { status: 'FINISHED', flagsGenerated: flagsCreated };
}

module.exports = { runReconciliationJob };
