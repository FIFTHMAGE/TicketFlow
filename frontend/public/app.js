let activeEvent = null;
let activeTransactionId = null;
let activePaymentGateway = 'basqet';

const API_BASE = '/api-v1';

window.addEventListener('DOMContentLoaded', () => {
  loadEvents();
  loadPublicStats();
  loadBasqetCurrencies();
  
  // Periodically refresh public stats mockup panel (every 3 seconds)
  setInterval(() => {
    loadPublicStats();
  }, 3000);
});

async function loadBasqetCurrencies() {
  const select = document.getElementById('basqet-currency-select');
  if (!select) return;

  // Emoji fallback if icon_url fails
  const emojiMap = {
    USDT: '🟢', BTC: '🪙', ETH: '🔷', LTC: '🔵',
    QDX: '🟡', BNB: '🟠', SOL: '🟣', USDC: '🔵',
    XRP: '🔹', DOGE: '🐶', MATIC: '🔮', TRX: '♦️'
  };

  try {
    const res = await fetch(`${API_BASE}/basqet/currencies`);
    const data = await res.json();
    // Backend already filters ?type=CRYPTO, but guard just in case
    const currencies = (data.currencies || []).filter(c => c.type === 'CRYPTO');

    currencies.forEach(c => {
      const slug = c.slug?.toUpperCase();
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.dataset.slug = slug;
      opt.dataset.icon = c.icon_url || '';
      opt.textContent = `${emojiMap[slug] || '💠'}  ${c.slug} — ${c.name}`;
      select.appendChild(opt);
    });
  } catch (err) {
    console.error('Failed to load Basqet currencies:', err);
    const BASE_ICON = 'https://basquet-assets.s3.amazonaws.com/icons/currency';
    [{ id: 3, slug: 'USDT', name: 'Tether' },
     { id: 4, slug: 'BTC',  name: 'Bitcoin' },
     { id: 5, slug: 'QDX',  name: 'Quidax Token' },
     { id: 6, slug: 'ETH',  name: 'Ethereum' },
     { id: 7, slug: 'LTC',  name: 'Litecoin' }
    ].forEach(c => {
      const slug = c.slug.toUpperCase();
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.dataset.slug = slug;
      opt.dataset.icon = `${BASE_ICON}/${c.slug}.svg`;
      opt.textContent = `${emojiMap[slug] || '💠'}  ${c.slug} — ${c.name}`;
      select.appendChild(opt);
    });
  }
}

// Networks available per token slug
const NETWORK_MAP = {
  USDT:  [{ id: 'trc20', label: 'TRON (TRC20)' }, { id: 'erc20', label: 'Ethereum (ERC20)' }, { id: 'bep20', label: 'BNB Chain (BEP20)' }],
  USDC:  [{ id: 'erc20', label: 'Ethereum (ERC20)' }, { id: 'bep20', label: 'BNB Chain (BEP20)' }],
  BTC:   [{ id: 'bitcoin', label: 'Bitcoin Network' }],
  ETH:   [{ id: 'erc20', label: 'Ethereum (ERC20)' }],
  LTC:   [{ id: 'litecoin', label: 'Litecoin Network' }],
  BNB:   [{ id: 'bep20', label: 'BNB Chain (BEP20)' }],
  SOL:   [{ id: 'solana', label: 'Solana Network' }],
  XRP:   [{ id: 'xrp', label: 'XRP Ledger' }],
  DOGE:  [{ id: 'dogecoin', label: 'Dogecoin Network' }],
  MATIC: [{ id: 'polygon', label: 'Polygon (MATIC)' }],
  TRX:   [{ id: 'tron', label: 'TRON Network' }],
  QDX:   [{ id: 'erc20', label: 'Ethereum (ERC20)' }],
};

function toggleBasqetDropdown() {
  const select = document.getElementById('basqet-currency-select');
  const networkSel = document.getElementById('basqet-network-select');
  const btn = document.getElementById('basqet-crypto-btn');
  const isVisible = select.style.display !== 'none';

  if (isVisible) {
    select.style.display = 'none';
    networkSel.style.display = 'none';
  } else {
    // Deselect Nomba
    document.querySelectorAll('.crypto-btn').forEach(b => {
      b.style.backgroundColor = '';
      b.style.borderColor = '';
    });
    select.style.display = 'block';
    btn.style.borderColor = 'var(--green)';
    btn.style.backgroundColor = 'rgba(146, 203, 60, 0.08)';
    select.focus();
  }
}

function onBasqetCurrencyChange(sel) {
  const currencyId = parseInt(sel.value);
  const selectedOpt = sel.options[sel.selectedIndex];
  const tokenLabel = selectedOpt?.text || 'Crypto via Basqet';
  const slug = selectedOpt?.dataset?.slug || '';

  document.getElementById('basqet-selected-label').textContent = tokenLabel;

  // Reset network selection
  selectedGateway = 'basqet';
  selectedCurrencyId = null;
  document.getElementById('proceed-button-container').classList.add('hidden');

  // Populate network dropdown
  const networks = NETWORK_MAP[slug?.toUpperCase()] || [{ id: 'default', label: 'Default Network' }];
  const networkSel = document.getElementById('basqet-network-select');
  networkSel.innerHTML = `<option value="" disabled selected>② Select a network / chain...</option>`;
  networks.forEach(n => {
    const opt = document.createElement('option');
    opt.value = n.id;
    opt.textContent = n.label;
    opt.dataset.currencyId = currencyId;
    networkSel.appendChild(opt);
  });
  networkSel.style.display = 'block';
}

function onBasqetNetworkChange(sel) {
  const currencyId = parseInt(sel.options[sel.selectedIndex]?.dataset.currencyId);
  const networkLabel = sel.options[sel.selectedIndex]?.text || '';
  const tokenLabel = document.getElementById('basqet-selected-label')?.textContent || 'Crypto';

  // Update button label to show token + network
  const shortToken = tokenLabel.replace(/.*?\s+(\w+)\s+—.*/, '$1').trim();
  document.getElementById('basqet-selected-label').textContent =
    `${shortToken} via ${networkLabel}`;

  selectedGateway = 'basqet';
  selectedCurrencyId = currencyId;

  // Show proceed button
  document.getElementById('proceed-button-container').classList.remove('hidden');
}

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
          <div class="event-price">₦${isNaN(parseFloat(event.price)) ? event.price : parseFloat(event.price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
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
    if (!res.ok) return; // silently skip on server error
    const data = await res.json();
    if (!data || data.error) return; // guard against error response

    const poolBal = parseFloat(data.poolBalance) || 0;
    const revBal  = parseFloat(data.revenueBalance) || 0;

    const poolEl = document.getElementById('mockup-pool-bal');
    const revEl  = document.getElementById('mockup-rev-bal');
    if (poolEl) poolEl.innerText = `₦${poolBal.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
    if (revEl)  revEl.innerText  = `₦${revBal.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

    const list = document.getElementById('mockup-ledger-list');
    if (!list) return;
    const entries = data.latestEntries || [];
    if (entries.length === 0) {
      list.innerHTML = `<div class="ledger-line"><span class="ledger-status pending"></span>No ledger entries.</div>`;
    } else {
      list.innerHTML = '';
      entries.forEach(entry => {
        const line = document.createElement('div');
        line.className = 'ledger-line';
        const isDebit = entry.type === 'DEBIT';
        const dotClass = isDebit ? 'ledger-status' : 'ledger-status pending';
        const amt = parseFloat(entry.amount) || 0;
        line.innerHTML = `
          <span class="${dotClass}"></span>
          <span>${entry.account_id} — ${entry.type?.toLowerCase()} — ₦${amt.toLocaleString()}</span>
        `;
        list.appendChild(line);
      });
    }

    renderTicker(entries);
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

  // Reset iframe
  document.getElementById('nomba-iframe-container').classList.add('hidden');
  document.getElementById('nomba-checkout-iframe').src = '';
  document.getElementById('qr-code-box').classList.remove('hidden');
  document.getElementById('address-container-box').classList.remove('hidden');

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
    showCheckoutStatus('Please enter your name and email address to continue.', 'error');
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
    showCheckoutStatus('Please enter a valid email address.', 'error');
    return;
  }

  setProceedButtonLoading(true);

  // Switch screens early and hide QR details container until loaded
  document.getElementById('checkout-step-init').classList.add('hidden');
  document.getElementById('checkout-step-pay').classList.remove('hidden');
  document.getElementById('checkout-title').innerText = 'Complete Payment';
  
  // Hide visual payment boxes during loading so user doesn't see a blank placeholder
  document.getElementById('qr-code-box').classList.add('hidden');
  document.getElementById('address-container-box').classList.add('hidden');
  document.getElementById('nomba-iframe-container').classList.add('hidden');
  
  showCheckoutStatus('Preparing payment request...', 'pending');

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
        showCheckoutStatus(resData.error || 'Failed to reserve ticket. Please try again.', 'error');
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
    if (!res.ok || !initData.transaction) {
      showCheckoutStatus(`❌ ${initData.error || 'Failed to create transaction. Please try again.'}`, 'error');
      return;
    }
    const transaction = initData.transaction;
    
    activeTransactionId = transaction.id;

    showCheckoutStatus('Generating deposit address from Basqet...', 'pending');

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

      const amt = parseFloat(transaction.amount);
      const fiatFormatted = isNaN(amt) ? transaction.amount : amt.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

      document.getElementById('checkout-price-fiat').innerText = `₦${fiatFormatted}`;
      document.getElementById('checkout-price-crypto').innerText = `${amtFormatted} ${ticker}`;
      document.getElementById('deposit-address').value = details.payment_address;
      
      const qrBox = document.getElementById('qr-code-box');
      // If Basqet returns a Base64 qrCode, render it — otherwise show fallback mock
      if (details.qrCode) {
        qrBox.innerHTML = `<img src="${details.qrCode}" alt="QR Code" style="max-width: 150px; margin: 0 auto; display: block;">`;
      } else {
        qrBox.innerHTML = `<div class="mock-qr">${ticker} QR</div>`;
      }

      // Hide loading status overlay and reveal address/QR card
      document.getElementById('checkout-status-msg').classList.add('hidden');
      document.getElementById('qr-code-box').classList.remove('hidden');
      document.getElementById('address-container-box').classList.remove('hidden');
    } else {
      showCheckoutStatus(`❌ ${payData.error || 'Failed to initialize payment session'}`, 'error');
    }
  } catch (err) {
    console.error('Error initiating checkout:', err);
    showCheckoutStatus(`❌ Network error: ${err.message}`, 'error');
  } finally {
    setProceedButtonLoading(false);
  }
}

async function initiateNombaPayment() {
  const customerName = document.getElementById('checkout-customer-name').value.trim();
  const customerEmail = document.getElementById('checkout-customer-email').value.trim();
  activePaymentGateway = 'nomba';

  if (!customerName || !customerEmail) {
    showCheckoutStatus('Please enter your name and email address to continue.', 'error');
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
    showCheckoutStatus('Please enter a valid email address.', 'error');
    return;
  }

  setProceedButtonLoading(true);

  // Switch to payment step early so inline status messages are visible
  document.getElementById('checkout-step-init').classList.add('hidden');
  document.getElementById('checkout-step-pay').classList.remove('hidden');
  document.getElementById('checkout-title').innerText = 'Complete Payment';

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
        showCheckoutStatus(resData.error || 'Failed to reserve ticket. Please try again.', 'error');
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
    if (!res.ok || !initData.transaction) {
      showCheckoutStatus(`❌ ${initData.error || 'Failed to create transaction. Please try again.'}`, 'error');
      setProceedButtonLoading(false);
      return;
    }
    const transaction = initData.transaction;
    activeTransactionId = transaction.id;

    showCheckoutStatus('Connecting to Nomba checkout...', 'pending');

    const payRes = await fetch(`${API_BASE}/nomba/pay-initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactionId: activeTransactionId })
    });
    const payData = await payRes.json();
    
    if (payData.status === 'success') {
      const details = payData.data;
      
      const amt = parseFloat(transaction.amount);
      const fiatFormatted = isNaN(amt) ? transaction.amount : amt.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

      document.getElementById('checkout-price-fiat').innerText = `₦${fiatFormatted}`;
      document.getElementById('checkout-price-crypto').innerText = `Nomba Card / Bank Transfer`;

      // Hide the connecting message
      document.getElementById('checkout-status-msg').classList.add('hidden');

      if (details.checkoutUrl) {
        document.getElementById('deposit-address').value = details.checkoutUrl;
        document.getElementById('nomba-checkout-iframe').src = details.checkoutUrl;
        document.getElementById('nomba-iframe-container').classList.remove('hidden');
        document.getElementById('qr-code-box').classList.add('hidden');
        document.getElementById('address-container-box').classList.add('hidden');
      } else {
        document.getElementById('deposit-address').value = details.bank_account;
        document.getElementById('nomba-iframe-container').classList.add('hidden');
        document.getElementById('nomba-checkout-iframe').src = '';
        document.getElementById('qr-code-box').classList.remove('hidden');
        document.getElementById('address-container-box').classList.remove('hidden');
        const qrBox = document.getElementById('qr-code-box');
        qrBox.innerHTML = `
          <div style="font-size: 13px; text-align: center; color: #fff; padding: 20px; font-family: monospace; line-height: 1.6;">
            <strong>Nomba Sandbox Checkout</strong><br/><br/>
            Bank: ${details.bank_name || 'Nomba Bank'}<br/>
            Account: ${details.bank_account}
          </div>
        `;
      }
    } else {
      // Show the real server error inline so we can debug
      const errMsg = payData.error || 'Failed to initialize Nomba payment';
      showCheckoutStatus(`❌ ${errMsg}`, 'error');
      console.error('[NOMBA PAY-INITIATE]', errMsg);
    }
  } catch (err) {
    console.error('Error initiating Nomba checkout:', err);
    showCheckoutStatus(`❌ Network error: ${err.message}`, 'error');
  } finally {
    setProceedButtonLoading(false);
  }
}

function setProceedButtonLoading(isLoading) {
  const btn = document.getElementById('proceed-payment-btn');
  if (!btn) return;

  if (isLoading) {
    btn.disabled = true;
    btn.innerText = 'Initializing payment...';
    btn.style.opacity = '0.6';
    btn.style.cursor = 'not-allowed';
  } else {
    btn.disabled = false;
    btn.innerText = 'Proceed to Payment';
    btn.style.opacity = '1';
    btn.style.cursor = 'pointer';
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
  // Clear all button highlights
  document.querySelectorAll('.crypto-btn').forEach(card => {
    card.style.backgroundColor = '';
    card.style.borderColor = '';
  });

  // Highlight selected button
  btn.style.backgroundColor = 'rgba(146, 203, 60, 0.08)';
  btn.style.borderColor = 'var(--green)';

  // If Nomba selected, hide the crypto dropdown
  if (method === 'nomba') {
    const sel = document.getElementById('basqet-currency-select');
    if (sel) sel.style.display = 'none';
  }

  selectedGateway = method;
  selectedCurrencyId = currencyId;

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


