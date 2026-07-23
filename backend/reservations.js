/**
 * Reservation Engine
 * Manages time-limited ticket holds before payment is completed.
 *
 * Flow:
 *  1. POST /api/reserve        → holds a seat, returns reservationId + expiresAt
 *  2. POST /api/purchase       → links the reservationId to a transaction
 *  3. Webhook confirmed        → reservation status → CONVERTED
 *  4. Timer expires (passive)  → released on next reserve/events fetch via expireStale()
 *  5. DELETE /api/reserve/:id  → customer cancels
 */

const db = require('./db');

const HOLD_MINUTES = 15; // how long a reservation lasts

/**
 * Sweep expired ACTIVE reservations — restores available_quantity.
 * Called opportunistically before reads to keep counts accurate.
 */
async function expireStale() {
  const now = new Date().toISOString();

  // Find all reservations that have expired but are still ACTIVE
  const expired = await db.all(
    "SELECT * FROM reservations WHERE status = 'ACTIVE' AND expires_at <= ?",
    [now]
  );

  for (const r of expired) {
    await db.run("UPDATE reservations SET status = 'EXPIRED' WHERE id = ?", [r.id]);
    await db.run(
      'UPDATE marketplace_items SET available_quantity = available_quantity + 1 WHERE id = ? AND available_quantity < total_quantity',
      [r.marketplace_item_id]
    );
  }

  return expired.length;
}

/**
 * Create a reservation for one ticket on a given event.
 */
async function createReservation(marketplaceItemId, customerName, customerEmail) {
  // Expire stale holds first to free up accurate inventory
  await expireStale();

  const item = await db.get(
    'SELECT * FROM marketplace_items WHERE id = ? AND status = ?',
    [marketplaceItemId, 'ACTIVE']
  );

  if (!item) throw Object.assign(new Error('Event not found or not active'), { status: 404 });
  if (item.available_quantity <= 0) throw Object.assign(new Error('This event is sold out'), { status: 409 });

  const reservationId = `RES_${Date.now()}_${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
  const expiresAt = new Date(Date.now() + HOLD_MINUTES * 60 * 1000).toISOString();

  // Decrement available quantity atomically
  const result = await db.run(
    'UPDATE marketplace_items SET available_quantity = available_quantity - 1 WHERE id = ? AND available_quantity > 0',
    [marketplaceItemId]
  );

  if (result.changes === 0) {
    throw Object.assign(new Error('Could not reserve ticket — sold out'), { status: 409 });
  }

  await db.run(
    `INSERT INTO reservations (id, marketplace_item_id, customer_name, customer_email, status, expires_at)
     VALUES (?, ?, ?, ?, 'ACTIVE', ?)`,
    [reservationId, marketplaceItemId, customerName, customerEmail, expiresAt]
  );

  return {
    reservationId,
    expiresAt,
    expiresInSeconds: HOLD_MINUTES * 60,
    item: {
      id: item.id,
      name: item.name,
      price: item.price
    }
  };
}

/**
 * Cancel a reservation and release the held seat back to inventory.
 */
async function cancelReservation(reservationId) {
  const reservation = await db.get(
    "SELECT * FROM reservations WHERE id = ? AND status = 'ACTIVE'",
    [reservationId]
  );

  if (!reservation) throw Object.assign(new Error('No active reservation found'), { status: 404 });

  const now = new Date().toISOString();
  if (reservation.expires_at <= now) {
    // Already expired — update status and don't double-release
    await db.run("UPDATE reservations SET status = 'EXPIRED' WHERE id = ?", [reservationId]);
    throw Object.assign(new Error('Reservation has already expired'), { status: 410 });
  }

  await db.run("UPDATE reservations SET status = 'CANCELLED' WHERE id = ?", [reservationId]);
  await db.run(
    'UPDATE marketplace_items SET available_quantity = available_quantity + 1 WHERE id = ? AND available_quantity < total_quantity',
    [reservation.marketplace_item_id]
  );

  return { status: 'cancelled', reservationId };
}

/**
 * Mark a reservation as CONVERTED (called after payment confirmed).
 */
async function convertReservation(reservationId) {
  const reservation = await db.get('SELECT * FROM reservations WHERE id = ?', [reservationId]);
  if (!reservation) return; // no-op if not found (direct purchase without reservation)

  const now = new Date().toISOString();
  if (reservation.status === 'ACTIVE' && reservation.expires_at > now) {
    await db.run(
      "UPDATE reservations SET status = 'CONVERTED' WHERE id = ?",
      [reservationId]
    );
  } else if (reservation.status === 'EXPIRED') {
    // Reservation expired before payment confirmed — restore quantity
    await db.run(
      'UPDATE marketplace_items SET available_quantity = available_quantity + 1 WHERE id = ? AND available_quantity < total_quantity',
      [reservation.marketplace_item_id]
    );
    throw Object.assign(new Error('Reservation expired before payment was confirmed'), { status: 410 });
  }
}

/**
 * Get reservation status (for polling from frontend).
 */
async function getReservation(reservationId) {
  const r = await db.get('SELECT * FROM reservations WHERE id = ?', [reservationId]);
  if (!r) throw Object.assign(new Error('Reservation not found'), { status: 404 });

  const now = Date.now();
  const expiresAt = new Date(r.expires_at).getTime();
  const secondsLeft = Math.max(0, Math.floor((expiresAt - now) / 1000));

  return { ...r, secondsLeft };
}

module.exports = { createReservation, cancelReservation, convertReservation, getReservation, expireStale };
