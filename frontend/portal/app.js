document.addEventListener('DOMContentLoaded', () => {
  const token = localStorage.getItem('vendor_token');
  if (!token) {
    window.location.href = '/portal/login.html';
    return;
  }

  const vendorName = localStorage.getItem('vendor_name') || 'Vendor';
  document.getElementById('userName').textContent = `Hello, ${vendorName}`;

  document.getElementById('logoutBtn').addEventListener('click', (e) => {
    e.preventDefault();
    localStorage.removeItem('vendor_token');
    localStorage.removeItem('vendor_name');
    window.location.href = '/portal/login.html';
  });

  loadStats();
  loadEvents();

  document.getElementById('createEventForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('eventName').value;
    const price = document.getElementById('eventPrice').value;
    const msgDiv = document.getElementById('createMsg');

    try {
      const res = await fetch('/api/vendor/events/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ name, price: parseFloat(price) })
      });
      const data = await res.json();
      if (res.ok) {
        msgDiv.textContent = 'Event created successfully!';
        msgDiv.style.color = 'green';
        document.getElementById('createEventForm').reset();
        loadEvents();
      } else {
        msgDiv.textContent = data.error || 'Failed to create event';
        msgDiv.style.color = 'red';
      }
    } catch (err) {
      msgDiv.textContent = 'Network error';
      msgDiv.style.color = 'red';
    }
  });

  async function loadStats() {
    try {
      const res = await fetch('/api/vendor/stats', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.status === 401 || res.status === 403) {
        window.location.href = '/portal/login.html';
        return;
      }
      const data = await res.json();
      document.getElementById('statTicketsSold').textContent = data.ticketsSold || 0;
      document.getElementById('statGrossEarnings').textContent = `NGN ${parseFloat(data.grossEarnings || 0).toLocaleString(undefined, {minimumFractionDigits: 2})}`;
      document.getElementById('statNetPayable').textContent = `NGN ${parseFloat(data.netPayable || 0).toLocaleString(undefined, {minimumFractionDigits: 2})}`;
    } catch (err) {
      console.error('Error loading stats', err);
    }
  }

  async function loadEvents() {
    try {
      const res = await fetch('/api/vendor/events', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      const tbody = document.getElementById('eventsTableBody');
      tbody.innerHTML = '';
      
      if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4">No events found. Create one below.</td></tr>';
        return;
      }

      data.forEach(event => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${event.name}</td>
          <td>NGN ${parseFloat(event.price).toLocaleString(undefined, {minimumFractionDigits: 2})}</td>
          <td>${event.sold_count || 0}</td>
          <td>${event.status}</td>
        `;
        tbody.appendChild(tr);
      });
    } catch (err) {
      console.error('Error loading events', err);
      document.getElementById('eventsTableBody').innerHTML = '<tr><td colspan="4">Error loading events.</td></tr>';
    }
  }
});
