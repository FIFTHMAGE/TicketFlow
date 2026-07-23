// Global States
let activeEvent = null;
let activeTransactionId = null;

// API URL (assuming relative for deployment or local hosting)
const API_BASE = '/api';

// On page load
window.addEventListener('DOMContentLoaded', () => {
  loadEvents();
  loadLedgerDashboard();
  loadSettlementsDashboard();
  runReconciliationCheck();

  // Poll ledger states every 5 seconds
  setInterval(() => {
    loadLedgerDashboard();
    loadSettlementsDashboard();
    runReconciliationCheck();
  }, 5000);
});

// Fetch events from server
async function loadEvents() {
  const container = document.getElementById('events-grid');
  try {
    const res = await fetch(`${API_BASE}/events`);
    const events = await res.json();
    
    container.innerHTML = '';
    events.forEach(event => {
      const card = document.createElement('div');
      card.className = 'event-card glass';
      card.innerHTML = `
        <div class="event-info">
          <h3>${event.name}</h3>
          <div class="event-meta">
            <p><strong>Organizer:</strong> ${event.vendor_name}</p>
            <p><strong>Platform:</strong> ${event.platform_name}</p>
          </div>
        </div>
        <div class="event-price-action">
          <div class="event-price">₦${event.price.toLocaleString()}</div>
          <button class="action-btn" onclick="openCheckout('${event.id}')">Buy Ticket</button>
        </div>
      `;
      container.appendChild(card);
    });
  } catch (err) {
    console.error('Error loading events:', err);
    container.innerHTML = `<div class="error-msg text-center text-danger">Failed to load events. Ensure backend is running.</div>`;
  }
}

// Open Checkout Modal
async function openCheckout(eventId) {
  activeEvent = eventId;
  document.getElementById('checkout-modal').classList.add('active');
  document.getElementById('checkout-step-init').classList.remove('hidden');
  document.getElementById('checkout-step-pay').classList.add('hidden');
}

function closeCheckout() {
  document.getElementById('checkout-modal').classList.remove('active');
  activeEvent = null;
  activeTransactionId = null;
}

// Initialize payment (locks in transaction)
async function initiatePayment(currencyId) {
  const customerName = "Demo Customer";
  const customerEmail = "customer@example.com";

  try {
    // 1. Initialize stableflow purchase
    const res = await fetch(`${API_BASE}/purchase`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: activeEvent, customerName, customerEmail })
    });
    const initData = await res.json();
    const transaction = initData.transaction;
    
    activeTransactionId = transaction.id;

    // 2. Lock currency rate with simulated Basqet API
    const payRes = await fetch(`${API_BASE}/basqet/pay-initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactionId: activeTransactionId, currencyId })
    });
    const payData = await payRes.json();
    
    if (payData.status === 'success') {
      const details = payData.data;
      
      document.getElementById('checkout-price-fiat').innerText = `₦${transaction.amount.toLocaleString()}`;
      document.getElementById('checkout-price-crypto').innerText = `${details.payment_amount.toFixed(6)} ${details.ticker}`;
      document.getElementById('deposit-address').value = details.payment_address;
      
      // Update QR mock text
      const qrBox = document.getElementById('qr-code-box');
      qrBox.innerHTML = `<div class="mock-qr">${details.ticker} QR</div>`;

      document.getElementById('checkout-step-init').classList.add('hidden');
      document.getElementById('checkout-step-pay').classList.remove('hidden');
    }
  } catch (err) {
    console.error('Error initiating checkout:', err);
    alert('Failed to initialize checkout session');
  }
}

// Confirm simulation payment on Basqet sandbox
async function confirmPaymentSimulation() {
  if (!activeTransactionId) return;

  try {
    const res = await fetch(`${API_BASE}/basqet/confirm-simulation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactionId: activeTransactionId })
    });
    const data = await res.json();
    
    if (data.status === 'success') {
      alert('Simulated Crypto Payment Complete. Ledger updated.');
      closeCheckout();
      
      // Refresh boards
      loadLedgerDashboard();
      runReconciliationCheck();
    }
  } catch (err) {
    console.error('Error completing simulated payment:', err);
    alert('Verification failed');
  }
}

// Load Ledger dashboard info
async function loadLedgerDashboard() {
  try {
    const res = await fetch(`${API_BASE}/admin/ledger`);
    const data = await res.json();

    // Accounts Grid rendering
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

    // Ledger entries table rendering
    const tableBody = document.getElementById('ledger-table-body');
    if (data.entries.length === 0) {
      tableBody.innerHTML = `<tr><td colspan="5" class="text-center text-muted">No entries generated yet.</td></tr>`;
      return;
    }

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
  } catch (err) {
    console.error('Error loading ledger dashboard:', err);
  }
}

// Load Settlements Dashboard
async function loadSettlementsDashboard() {
  try {
    const res = await fetch(`${API_BASE}/admin/settlements`);
    const data = await res.json();

    const tableBody = document.getElementById('batches-table-body');
    if (data.batches.length === 0) {
      tableBody.innerHTML = `<tr><td colspan="3" class="text-center text-muted">No batches run yet.</td></tr>`;
      return;
    }

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
  } catch (err) {
    console.error('Error loading settlements dashboard:', err);
  }
}

// Trigger Settlement Payout Batch
async function triggerSettlementBatch() {
  try {
    const res = await fetch(`${API_BASE}/admin/batches/trigger`, {
      method: 'POST'
    });
    const data = await res.json();
    
    if (data.status === 'NO_PENDING_BALANCES') {
      alert('Reconciliation: All vendor accounts are settled. No batch triggered.');
    } else {
      alert(`Settlement batch triggered successfully! Status: ${data.status}`);
      loadSettlementsDashboard();
      loadLedgerDashboard();
    }
  } catch (err) {
    console.error('Error triggering batch:', err);
    alert('Failed to trigger payout batch');
  }
}

// Run Reconciliation check
async function runReconciliationCheck() {
  try {
    const res = await fetch(`${API_BASE}/admin/reconcile`);
    const data = await res.json();

    const indicator = document.getElementById('reconciliation-status');
    if (data.status === 'RECONCILED') {
      indicator.innerHTML = `<span class="status-indicator-green"></span> Ledger Reconciled`;
      indicator.style.borderColor = 'rgba(16, 185, 129, 0.2)';
      indicator.style.backgroundColor = 'rgba(16, 185, 129, 0.1)';
      indicator.style.color = '#10b981';
    } else {
      indicator.innerHTML = `<span class="status-indicator-green" style="background-color:#ef4444;box-shadow: 0 0 8px #ef4444;"></span> Ledger Discrepancy!`;
      indicator.style.borderColor = 'rgba(239, 68, 68, 0.2)';
      indicator.style.backgroundColor = 'rgba(239, 68, 68, 0.1)';
      indicator.style.color = '#ef4444';
    }
  } catch (err) {
    console.error('Error running reconciliation check:', err);
  }
}
