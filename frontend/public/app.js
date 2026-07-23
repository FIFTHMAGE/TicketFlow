let activeEvent = null;
let activeTransactionId = null;
let activePaymentGateway = 'basqet';

const API_BASE = '/api-v1';

window.addEventListener('DOMContentLoaded', () => {
  loadEvents();
  loadPublicStats();
  
  // Periodically refresh public stats mockup panel (every 3 seconds)
  setInterval(() => {
    loadPublicStats();
  }, 3000);
});

async function loadEvents() {
  const container = document.getElementById('events-grid');
  try {
    const res = await fetch(`${API_BASE}/events`);
    const events = await res.json();
    
    container.innerHTML = '';
    events.forEach(event => {
      const card = document.createElement('div');
      card.className = 'event-card';
      const isSoldOut = event.available_quantity <= 0;
      const buttonHtml = isSoldOut 
        ? `<button class="btn-primary" disabled style="background-color: var(--line); color: var(--sand); cursor: not-allowed; transform: none;">Sold Out</button>`
        : `<button class="btn-primary" onclick="openCheckout('${event.id}', ${event.price})">Buy Ticket</button>`;

      const stockColor = event.available_quantity < 10 ? '#ef4444' : 'var(--sand)';
      const stockText = isSoldOut 
        ? `<span style="color: #ef4444; font-weight: bold;">Sold Out</span>`
        : `<span style="color: ${stockColor}; font-weight: 500;">${event.available_quantity} left</span> of ${event.total_quantity}`;

      card.innerHTML = `
        <div>
          <div class="event-title">${event.name}</div>
          <div class="event-meta" style="display: flex; justify-content: space-between; align-items: center; margin-top: 8px;">
            <span style="font-size: 0.8rem;">Organizer: ${event.vendor_name}</span>
            <span style="font-size: 0.78rem; color: var(--sand);">${stockText}</span>
          </div>
        </div>
        <div class="event-price-row">
          <div class="event-price">₦${event.price.toLocaleString()}</div>
          ${buttonHtml}
        </div>
      `;
      container.appendChild(card);
    });
  } catch (err) {
    console.error('Error loading events:', err);
    container.innerHTML = `<div class="error-msg text-center text-danger">Failed to load events.</div>`;
  }
}

async function loadPublicStats() {
  try {
    const res = await fetch(`${API_BASE}/public-stats`);
    const data = await res.json();

    // Update mockup balances
    document.getElementById('mockup-pool-bal').innerText = `₦${data.poolBalance.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
    document.getElementById('mockup-rev-bal').innerText = `₦${data.revenueBalance.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

    // Update mockup ledger journal logs
    const list = document.getElementById('mockup-ledger-list');
    if (data.latestEntries.length === 0) {
      list.innerHTML = `<div class="ledger-line"><span class="ledger-status pending"></span>No ledger entries.</div>`;
    } else {
      list.innerHTML = '';
      data.latestEntries.forEach(entry => {
        const line = document.createElement('div');
        line.className = 'ledger-line';
        const isDebit = entry.type === 'DEBIT';
        const dotClass = isDebit ? 'ledger-status' : 'ledger-status pending';
        
        line.innerHTML = `
          <span class="${dotClass}"></span>
          <span>${entry.account_id} — ${entry.type.toLowerCase()} — ₦${entry.amount.toLocaleString()}</span>
        `;
        list.appendChild(line);
      });
    }

    // Render interactive ticker with real ledger values if available
    renderTicker(data.latestEntries);
  } catch (err) {
    console.error('Error loading stats:', err);
  }
}

function renderTicker(entries) {
  const track = document.getElementById('tickerTrack');
  if (!track) return;

  // Fallback default items if database is clean
  let items = [
    { id: '4821', amt: '₦25,000', to: '₦22,500' },
    { id: '4822', amt: '₦18,500', to: '₦16,650' },
    { id: '4823', amt: '₦40,000', to: '₦36,000' },
    { id: '4824', amt: '₦25,000', to: '₦22,500' },
  ];

  // If we have actual ledger entries, map them into the scrolling ticker
  if (entries && entries.length > 0) {
    const purchaseEntries = entries.filter(e => e.account_id === 'SETTLEMENT_POOL' && e.type === 'DEBIT');
    if (purchaseEntries.length > 0) {
      items = purchaseEntries.map((e, idx) => {
        const refShort = e.reference.substring(7, 11) || `TX${idx}`;
        return {
          id: refShort,
          amt: `₦${e.amount.toLocaleString()}`,
          to: `₦${(e.amount * 0.9).toLocaleString()}` // approx split
        };
      });
    }
  }

  const build = () => items.map(i => `
    <span class="ticker-item">
      <span>TICKET #${i.id}</span>
      <span class="amount">${i.amt}</span>
      <span class="arrow">→</span>
      <span>SETTLED</span>
      <span class="arrow">→</span>
      <span class="amount">${i.to}</span>
      <span>SENT</span>
    </span>
  `).join('');
  track.innerHTML = build() + build();
}

let activeReservationId = null;
let countdownInterval = null;

function startReservationTimer(expiresAt) {
  if (countdownInterval) clearInterval(countdownInterval);
  const banner = document.getElementById('reservation-timer-banner');
  const timerText = document.getElementById('hold-countdown-time');
  banner.style.display = 'block';

  const target = new Date(expiresAt).getTime();

  function update() {
    const now = Date.now();
    const diff = target - now;

    if (diff <= 0) {
      clearInterval(countdownInterval);
      timerText.textContent = "Expired";
      alert("Your ticket reservation has expired. Please select the event again.");
      closeCheckout();
      return;
    }

    const mins = Math.floor(diff / 60000);
    const secs = Math.floor((diff % 60000) / 1000);
    timerText.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  update();
  countdownInterval = setInterval(update, 1000);
}

let selectedGateway = null;
let selectedCurrencyId = null;

function openCheckout(eventId, price) {
  activeEvent = eventId;
  selectedGateway = null;
  selectedCurrencyId = null;
  
  // Set interactive ticket price
  document.getElementById('ticket-interactive-price').innerText = `₦${price.toLocaleString()}`;

  document.getElementById('checkout-title').innerText = 'Select Payment Method';
  document.getElementById('checkout-modal').classList.add('active');
  document.getElementById('checkout-step-init').classList.remove('hidden');
  document.getElementById('checkout-step-pay').classList.add('hidden');
  document.getElementById('proceed-button-container').classList.add('hidden');
  document.getElementById('checkout-status-msg').classList.add('hidden');

  // Clear all button selections
  document.querySelectorAll('.crypto-btn').forEach(btn => {
    btn.style.backgroundColor = '';
    btn.style.borderColor = '';
  });
  
  // Reset reservation state
  activeReservationId = null;
  document.getElementById('reservation-timer-banner').style.display = 'none';
  if (countdownInterval) clearInterval(countdownInterval);
}

async function closeCheckout() {
  document.getElementById('checkout-modal').classList.remove('active');
  document.getElementById('checkout-status-msg').classList.add('hidden');
  if (countdownInterval) clearInterval(countdownInterval);

  // If a reservation was created but not paid/converted, release it immediately on cancel
  if (activeReservationId && !activeTransactionId) {
    try {
      await fetch(`${API_BASE}/reserve/${activeReservationId}`, { method: 'DELETE' });
    } catch (e) {
      console.warn("Could not release reservation:", e);
    }
  }

  activeEvent = null;
  activeTransactionId = null;
  activeReservationId = null;
  loadEvents(); // refresh catalogs and remaining quantity instantly
}

async function initiatePayment(currencyId) {
  activePaymentGateway = 'basqet';
  const customerName = document.getElementById('checkout-customer-name').value.trim();
  const customerEmail = document.getElementById('checkout-customer-email').value.trim();

  if (!customerName || !customerEmail) {
    alert('Please enter your name and email address to continue.');
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
    alert('Please enter a valid email address.');
    return;
  }

  try {
    // 1. Reserve the ticket first
    if (!activeReservationId) {
      const resVal = await fetch(`${API_BASE}/reserve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: activeEvent, customerName, customerEmail })
      });
      const resData = await resVal.json();
      if (!resVal.ok) {
        alert(resData.error || 'Failed to reserve ticket');
        return;
      }
      activeReservationId = resData.reservationId;
      startReservationTimer(resData.expiresAt);
    }

    // 2. Initialize purchase linking reservation
    const res = await fetch(`${API_BASE}/purchase`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: activeEvent, customerName, customerEmail, reservationId: activeReservationId })
    });
    const initData = await res.json();
    const transaction = initData.transaction;
    
    activeTransactionId = transaction.id;

    const payRes = await fetch(`${API_BASE}/basqet/pay-initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactionId: activeTransactionId, currencyId })
    });
    const payData = await payRes.json();
    
    if (payData.status === 'success') {
      const details = payData.data;
      
      let ticker = details.ticker || details.payment_currency;
      if (!ticker) {
        if (currencyId === 3) ticker = 'USDT';
        else if (currencyId === 4) ticker = 'BTC';
        else if (currencyId === 6) ticker = 'ETH';
        else ticker = 'Crypto';
      }

      // Handle raw string or number conversion for payment_amount
      const rawAmt = details.payment_amount;
      const amtNum = typeof rawAmt === 'string' ? parseFloat(rawAmt) : rawAmt;
      const amtFormatted = amtNum ? amtNum.toFixed(6) : '0.000000';

      document.getElementById('checkout-price-fiat').innerText = `₦${transaction.amount.toLocaleString()}`;
      document.getElementById('checkout-price-crypto').innerText = `${amtFormatted} ${ticker}`;
      document.getElementById('deposit-address').value = details.payment_address;
      
      const qrBox = document.getElementById('qr-code-box');
      // If Basqet returns a Base64 qrCode, render it — otherwise show fallback mock
      if (details.qrCode) {
        qrBox.innerHTML = `<img src="${details.qrCode}" alt="QR Code" style="max-width: 150px; margin: 0 auto; display: block;">`;
      } else {
        qrBox.innerHTML = `<div class="mock-qr">${ticker} QR</div>`;
      }

      document.getElementById('checkout-title').innerText = 'Complete Payment';
      document.getElementById('checkout-step-init').classList.add('hidden');
      document.getElementById('checkout-step-pay').classList.remove('hidden');
    }
  } catch (err) {
    console.error('Error initiating checkout:', err);
    alert('Failed to initialize checkout session');
  }
}

async function initiateNombaPayment() {
  const customerName = document.getElementById('checkout-customer-name').value.trim();
  const customerEmail = document.getElementById('checkout-customer-email').value.trim();
  activePaymentGateway = 'nomba';

  if (!customerName || !customerEmail) {
    alert('Please enter your name and email address to continue.');
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
    alert('Please enter a valid email address.');
    return;
  }

  try {
    // 1. Reserve the ticket first
    if (!activeReservationId) {
      const resVal = await fetch(`${API_BASE}/reserve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: activeEvent, customerName, customerEmail })
      });
      const resData = await resVal.json();
      if (!resVal.ok) {
        alert(resData.error || 'Failed to reserve ticket');
        return;
      }
      activeReservationId = resData.reservationId;
      startReservationTimer(resData.expiresAt);
    }

    // 2. Initialize purchase linking reservation
    const res = await fetch(`${API_BASE}/purchase`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: activeEvent, customerName, customerEmail, reservationId: activeReservationId })
    });
    const initData = await res.json();
    const transaction = initData.transaction;
    
    activeTransactionId = transaction.id;

    const payRes = await fetch(`${API_BASE}/nomba/pay-initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactionId: activeTransactionId })
    });
    const payData = await payRes.json();
    
    if (payData.status === 'success') {
      const details = payData.data;
      
      document.getElementById('checkout-price-fiat').innerText = `₦${transaction.amount.toLocaleString()}`;
      document.getElementById('checkout-price-crypto').innerText = `Nomba Card / Transfer`;
      document.getElementById('deposit-address').value = details.bank_account;
      
      const qrBox = document.getElementById('qr-code-box');
      qrBox.innerHTML = `
        <div style="font-size: 13px; text-align: center; color: #fff; padding: 20px; font-family: monospace;">
          <strong>Nomba Checkout</strong><br/><br/>
          Bank: Nomba Bank<br/>
          Account: ${details.bank_account}
        </div>
      `;

      document.getElementById('checkout-title').innerText = 'Complete Payment';
      document.getElementById('checkout-step-init').classList.add('hidden');
      document.getElementById('checkout-step-pay').classList.remove('hidden');
    }
  } catch (err) {
    console.error('Error initiating Nomba checkout:', err);
    alert('Failed to initialize checkout session');
  }
}

function showCheckoutStatus(msg, type = 'pending') {
  const container = document.getElementById('checkout-status-msg');
  container.innerText = msg;
  container.classList.remove('hidden');

  if (type === 'success') {
    container.style.backgroundColor = 'rgba(146, 203, 60, 0.08)';
    container.style.borderColor = 'var(--green)';
    container.style.color = '#92cb3c';
  } else if (type === 'error') {
    container.style.backgroundColor = 'rgba(235, 87, 87, 0.08)';
    container.style.borderColor = '#eb5757';
    container.style.color = '#eb5757';
  } else {
    // pending
    container.style.backgroundColor = 'rgba(242, 201, 76, 0.08)';
    container.style.borderColor = '#f2c94c';
    container.style.color = '#f2c94c';
  }
}

async function checkPaymentStatus() {
  if (!activeTransactionId) return;

  // Clear previous message
  document.getElementById('checkout-status-msg').classList.add('hidden');

  try {
    const url = activePaymentGateway === 'nomba' 
      ? `${API_BASE}/nomba/verify`
      : `${API_BASE}/basqet/verify`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactionId: activeTransactionId })
    });
    const data = await res.json();
    
    if (data.status === 'success') {
      showCheckoutStatus(`Payment Confirmed! Redirecting...`, 'success');
      setTimeout(() => {
        activeReservationId = null; // cleared since it's converted
        closeCheckout();
        loadPublicStats(); // refresh visual dashboard instantly
      }, 2000);
    } else {
      // Show pending check details returned by server in custom message box
      showCheckoutStatus(data.message || 'Payment verification is pending. Please wait.', 'pending');
    }
  } catch (err) {
    console.error('Error verifying payment:', err);
    showCheckoutStatus('Verification check failed. Please try again.', 'error');
  }
}

function selectPaymentOption(btn, method, currencyId) {
  // Clear other active options styling
  document.querySelectorAll('.crypto-btn').forEach(card => {
    card.style.backgroundColor = '';
    card.style.borderColor = '';
  });

  // Highlight selection
  btn.style.backgroundColor = 'rgba(146, 203, 60, 0.08)';
  btn.style.borderColor = 'var(--green)';

  // Save state
  selectedGateway = method;
  selectedCurrencyId = currencyId;

  // Reveal proceed button container
  document.getElementById('proceed-button-container').classList.remove('hidden');
}

function handleProceedPayment() {
  if (selectedGateway === 'nomba') {
    initiateNombaPayment();
  } else if (selectedGateway === 'basqet' && selectedCurrencyId) {
    initiatePayment(selectedCurrencyId);
  } else {
    alert('Please select a payment method first.');
  }
}


