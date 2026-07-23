let activeEvent = null;
let activeTransactionId = null;

const API_BASE = '/api';

window.addEventListener('DOMContentLoaded', () => {
  loadEvents();
});

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
    container.innerHTML = `<div class="error-msg text-center text-danger">Failed to load events.</div>`;
  }
}

function openCheckout(eventId) {
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

async function initiatePayment(currencyId) {
  activePaymentGateway = 'basqet';
  const customerName = "Demo Customer";
  const customerEmail = "customer@example.com";

  try {
    const res = await fetch(`${API_BASE}/purchase`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: activeEvent, customerName, customerEmail })
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
      
      document.getElementById('checkout-price-fiat').innerText = `₦${transaction.amount.toLocaleString()}`;
      document.getElementById('checkout-price-crypto').innerText = `${details.payment_amount.toFixed(6)} ${details.ticker}`;
      document.getElementById('deposit-address').value = details.payment_address;
      
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

let activePaymentGateway = 'basqet';

async function initiateNombaPayment() {
  const customerName = "Demo Customer";
  const customerEmail = "customer@example.com";
  activePaymentGateway = 'nomba';

  try {
    const res = await fetch(`${API_BASE}/purchase`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: activeEvent, customerName, customerEmail })
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
        <div style="font-size: 13px; text-align: center; color: #fff; padding: 20px;">
          <strong>Nomba Checkout</strong><br/>
          Bank: Nomba microfinance Bank<br/>
          Account: ${details.bank_account}
        </div>
      `;

      document.getElementById('checkout-step-init').classList.add('hidden');
      document.getElementById('checkout-step-pay').classList.remove('hidden');
    }
  } catch (err) {
    console.error('Error initiating Nomba checkout:', err);
    alert('Failed to initialize checkout session');
  }
}

async function confirmPaymentSimulation() {
  if (!activeTransactionId) return;

  try {
    const url = activePaymentGateway === 'nomba' 
      ? `${API_BASE}/nomba/confirm-simulation`
      : `${API_BASE}/basqet/confirm-simulation`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactionId: activeTransactionId })
    });
    const data = await res.json();
    
    if (data.status === 'success') {
      alert(`Simulated ${activePaymentGateway === 'nomba' ? 'Nomba' : 'Basqet'} Payment Complete. Ledger updated.`);
      closeCheckout();
    }
  } catch (err) {
    console.error('Error completing simulated payment:', err);
    alert('Verification failed');
  }
}
