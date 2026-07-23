const db = require('./db');

async function runReconciliationJob(userId = 'system') {
  await db.run('INSERT INTO audit_logs (username, action, details) VALUES (?, ?, ?)', [
    userId,
    'START_RECONCILIATION_JOB',
    'Reconciliation engine verification started.'
  ]);

  // Fetch transactions with confirmed status
  const transactions = await db.all(
    "SELECT * FROM transactions WHERE status IN ('PAYMENT_CONFIRMED', 'ALLOCATED_TO_LEDGER')"
  );

  let flagsCreated = 0;

  for (const tx of transactions) {
    // 1. Fetch related ledger entries
    const ledgerEntries = await db.all(
      "SELECT amount, type FROM ledger_entries WHERE reference = ? AND account_id = 'SETTLEMENT_POOL'",
      [tx.reference]
    );

    // Calculate sum of DEBIT entries for this purchase transaction reference
    let ledgerPurchaseSum = 0;
    ledgerEntries.forEach((e) => {
      if (e.type === 'DEBIT') {
        ledgerPurchaseSum += e.amount;
      }
    });

    const confirmedAmount = tx.confirmed_amount !== null ? tx.confirmed_amount : tx.gross_amount;

    // Compare ledger DEBIT pool amount against the actual confirmed amount from the provider
    const discrepancy = Math.abs(ledgerPurchaseSum - confirmedAmount);
    if (discrepancy > 0.01) {
      // Check if a flag already exists to prevent duplicate flags
      const existingFlag = await db.get(
        'SELECT * FROM reconciliation_flags WHERE transaction_id = ? AND type = ?',
        [tx.reference, 'AMOUNT_MISMATCH']
      );

      if (!existingFlag) {
        await db.run(
          `INSERT INTO reconciliation_flags (transaction_id, type, amount_difference, description) 
           VALUES (?, ?, ?, ?)`,
          [
            tx.reference,
            'AMOUNT_MISMATCH',
            discrepancy,
            `Transaction confirmed amount (${confirmedAmount}) does not match ledger pool entry amount (${ledgerPurchaseSum})`
          ]
        );
        flagsCreated++;
      }
    }
  }

  // Audit double entry balance
  const entries = await db.all('SELECT type, amount FROM ledger_entries');
  let totalDebits = 0;
  let totalCredits = 0;
  entries.forEach((e) => {
    if (e.type === 'DEBIT') totalDebits += e.amount;
    if (e.type === 'CREDIT') totalCredits += e.amount;
  });

  const isDoubleEntryValid = Math.abs(totalDebits - totalCredits) < 0.01;
  if (!isDoubleEntryValid) {
    const flagRef = `LEDGER_DOUBLE_ENTRY_${Date.now()}`;
    const existingFlag = await db.get('SELECT * FROM reconciliation_flags WHERE transaction_id = ?', [flagRef]);
    if (!existingFlag) {
      await db.run(
        `INSERT INTO reconciliation_flags (transaction_id, type, amount_difference, description) 
         VALUES (?, ?, ?, ?)`,
        [
          flagRef,
          'LEDGER_UNBALANCED',
          Math.abs(totalDebits - totalCredits),
          `Double-entry ledger is unbalanced. Debits: ${totalDebits}, Credits: ${totalCredits}`
        ]
      );
      flagsCreated++;
    }
  }

  await db.run('INSERT INTO audit_logs (username, action, details) VALUES (?, ?, ?)', [
    userId,
    'END_RECONCILIATION_JOB',
    `Reconciliation engine finished. Flags generated: ${flagsCreated}`
  ]);

  return { status: 'FINISHED', flagsGenerated: flagsCreated };
}

module.exports = {
  runReconciliationJob
};
