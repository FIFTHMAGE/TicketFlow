// Read token exclusively from localStorage — never from URL params (security)
let token = localStorage.getItem('admin_token');

if (!token) {
  logout();
}

// Fetch helper with auth header
async function fetchWithAuth(url, options = {}) {
  options.headers = options.headers || {};
  options.headers['Authorization'] = `Bearer ${token}`;
  
  const res = await fetch(url, options);
  if (res.status === 401) {
    logout();
    throw new Error('Unauthorized session expired');
  }
  return res;
}

function logout() {
  localStorage.removeItem('admin_token');
  document.cookie = "admin_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 UTC; SameSite=Strict";
  window.location.href = '/login.html';
}

window.addEventListener('DOMContentLoaded', () => {
  loadLedgerDashboard();
  loadSettlementsDashboard();
  
  // Poll ledger states
  setInterval(() => {
    loadLedgerDashboard();
    loadSettlementsDashboard();
  }, 4000);
});

async function loadLedgerDashboard() {
  try {
    const res = await fetchWithAuth('/api/admin/ledger');
    const data = await res.json();

    // Render accounts
    const grid = document.getElementById('accounts-grid');
    grid.innerHTML = '';
    data.accounts.forEach(acc => {
      let balanceFormatted = `₦${acc.balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      let typeClass = '';

      if (acc.id === 'SETTLEMENT_POOL') typeClass = 'settlement';
      else if (acc.id === 'PLATFORM_REVENUE') typeClass = 'revenue';
      else if (acc.id.startsWith('VENDOR_PAYABLE_')) typeClass = 'payable';

      const card = document.createElement('div');
      card.className = 'account-card glass';
      card.innerHTML = `
        <div class="account-title">${acc.name}</div>
        <div class="account-balance ${typeClass}">${balanceFormatted}</div>
      `;
      grid.appendChild(card);
    });

    // Render ledger entries table
    const tableBody = document.getElementById('ledger-table-body');
    if (data.entries.length === 0) {
      tableBody.innerHTML = `<tr><td colspan="5" class="text-center text-muted">No entries.</td></tr>`;
    } else {
      tableBody.innerHTML = '';
      data.entries.forEach(entry => {
        const row = document.createElement('tr');
        const amountColor = entry.type === 'DEBIT' ? '#10b981' : '#f87171';
        row.innerHTML = `
          <td>${entry.reference}</td>
          <td>${entry.account_id}</td>
          <td style="color: ${amountColor}; font-weight: bold;">${entry.type}</td>
          <td>₦${entry.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
          <td class="text-muted">${entry.description}</td>
        `;
        tableBody.appendChild(row);
      });
    }

    // Render transactions table
    const txBody = document.getElementById('transactions-table-body');
    if (!data.transactions || data.transactions.length === 0) {
      txBody.innerHTML = `<tr><td colspan="4" class="text-center text-muted">No transactions.</td></tr>`;
    } else {
      txBody.innerHTML = '';
      data.transactions.forEach(tx => {
        const row = document.createElement('tr');
        const showRefundButton = tx.status === 'ALLOCATED_TO_LEDGER';
        row.innerHTML = `
          <td>${tx.reference}</td>
          <td>₦${tx.gross_amount.toLocaleString()}</td>
          <td><span class="badge-status ${tx.status.toLowerCase()}">${tx.status}</span></td>
          <td>
            ${showRefundButton ? `<button class="action-btn borderless" style="padding: 4px 8px; font-size: 11px;" onclick="refundTransaction('${tx.reference}')">Refund</button>` : '<span class="text-muted">-</span>'}
          </td>
        `;
        txBody.appendChild(row);
      });
    }

    // Render flags table
    const flagsBody = document.getElementById('flags-table-body');
    if (data.reconciliationFlags.length === 0) {
      flagsBody.innerHTML = `<tr><td colspan="4" class="text-center text-muted">No flags detected.</td></tr>`;
      document.getElementById('reconciliation-status').innerHTML = `<span class="status-indicator-green"></span> Reconciled`;
    } else {
      flagsBody.innerHTML = '';
      data.reconciliationFlags.forEach(flag => {
        const row = document.createElement('tr');
        row.innerHTML = `
          <td>${flag.transaction_id}</td>
          <td style="color: #ef4444; font-weight: bold;">${flag.type}</td>
          <td>₦${flag.amount_difference.toLocaleString()}</td>
          <td class="text-muted">${flag.description}</td>
        `;
        flagsBody.appendChild(row);
      });
      document.getElementById('reconciliation-status').innerHTML = `<span class="status-indicator-green" style="background-color:#ef4444;box-shadow: 0 0 8px #ef4444;"></span> Mismatch Flags`;
    }
  } catch (err) {
    console.error('Error loading dashboard:', err);
  }
}

async function loadSettlementsDashboard() {
  try {
    const res = await fetchWithAuth('/api/admin/settlements');
    const data = await res.json();

    const tableBody = document.getElementById('batches-table-body');
    if (data.batches.length === 0) {
      tableBody.innerHTML = `<tr><td colspan="3" class="text-center text-muted">No batches.</td></tr>`;
    } else {
      tableBody.innerHTML = '';
      data.batches.forEach(batch => {
        const row = document.createElement('tr');
        const statusClass = batch.status.toLowerCase();
        row.innerHTML = `
          <td>${batch.id}</td>
          <td><span class="badge-status ${statusClass}">${batch.status}</span></td>
          <td>${new Date(batch.created_at).toLocaleString()}</td>
        `;
        tableBody.appendChild(row);
      });
    }

    // Render pending approvals table
    const appBody = document.getElementById('approvals-table-body');
    const pendingPayouts = data.payouts.filter(p => p.status === 'PENDING_APPROVAL');
    
    if (pendingPayouts.length === 0) {
      appBody.innerHTML = `<tr><td colspan="5" class="text-center text-muted">No payouts pending authorization.</td></tr>`;
    } else {
      appBody.innerHTML = '';
      const currentRole = localStorage.getItem('admin_role') || 'ADMIN';
      const currentUser = localStorage.getItem('admin_username') || 'admin';

      pendingPayouts.forEach(payout => {
        const row = document.createElement('tr');
        
        let hasSigned = false;
        if (currentRole === 'ADMIN' && payout.approved_by_admin) hasSigned = true;
        if (currentRole === 'FINANCE' && payout.approved_by_finance) hasSigned = true;

        const actionHtml = hasSigned 
          ? '<span class="text-muted">Signed</span>' 
          : `<button class="action-btn glow" style="padding: 6px 12px; font-size: 11px;" onclick="approvePayout('${payout.id}')">Sign Approval</button>`;

        row.innerHTML = `
          <td>${payout.id}</td>
          <td>₦${payout.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
          <td>${payout.approved_by_finance ? `✅ Signed (${payout.approved_by_finance})` : '❌ Pending'}</td>
          <td>${payout.approved_by_admin ? `✅ Signed (${payout.approved_by_admin})` : '❌ Pending'}</td>
          <td>${actionHtml}</td>
        `;
        appBody.appendChild(row);
      });
    }
  } catch (err) {
    console.error(err);
  }
}

async function triggerSettlementBatch() {
  try {
    const res = await fetchWithAuth('/api/admin/batches/trigger', { method: 'POST' });
    const data = await res.json();
    if (data.status === 'NO_PENDING_BALANCES') {
      alert('All accounts are fully settled or held for approval. No batch triggered.');
    } else {
      alert(`Settlement batch triggered! Status: ${data.status}`);
      loadSettlementsDashboard();
      loadLedgerDashboard();
    }
  } catch (err) {
    console.error(err);
  }
}

async function runReconciliationJob() {
  try {
    const res = await fetchWithAuth('/api/admin/reconcile', { method: 'POST' });
    const data = await res.json();
    alert(`Reconciliation job finished. Flags generated: ${data.flagsGenerated}`);
    loadLedgerDashboard();
  } catch (err) {
    console.error(err);
  }
}

async function approvePayout(payoutId) {
  try {
    const res = await fetchWithAuth('/api/admin/payouts/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payoutId })
    });
    
    if (res.ok) {
      alert('Payout approval successfully signed!');
      loadSettlementsDashboard();
    } else {
      const errData = await res.json();
      alert(`Error: ${errData.error}`);
    }
  } catch (err) {
    console.error(err);
  }
}

async function refundTransaction(transactionId) {
  if (!confirm(`Are you sure you want to refund transaction ${transactionId}?`)) return;

  try {
    const res = await fetchWithAuth('/api/admin/refund', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactionId })
    });

    if (res.ok) {
      alert('Transaction successfully refunded. Ledger updated.');
      loadLedgerDashboard();
    } else {
      const errData = await res.json();
      alert(`Error: ${errData.error}`);
    }
  } catch (err) {
    console.error(err);
  }
}
