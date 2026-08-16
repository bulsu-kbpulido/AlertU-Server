const { getFirestore } = require('firebase-admin/firestore');

// Initialize local Firestore instance directly from default app
const firestore = getFirestore();

// Counter doc lives at counters/admins, e.g. { count: 3 }.
// The backfill script (scripts/backfillAdminIds.js) seeds this doc the
// first time this feature is turned on for a project that already has
// admins without an adminId.
const COUNTER_REF = firestore.collection('counters').doc('admins');
const ID_PREFIX = 'ADMN-';
const ID_PAD_LENGTH = 3;

function formatAdminId(count) {
  return `${ID_PREFIX}${String(count).padStart(ID_PAD_LENGTH, '0')}`;
}

// Atomically reserves the next admin ID (e.g. "ADMN-004"). Uses a Firestore
// transaction so two simultaneous admin creations can never be handed the
// same number, even under concurrent requests.
async function getNextAdminId() {
  const nextId = await firestore.runTransaction(async (transaction) => {
    const counterSnap = await transaction.get(COUNTER_REF);
    const currentCount = counterSnap.exists ? Number(counterSnap.data().count) || 0 : 0;
    const nextCount = currentCount + 1;

    transaction.set(COUNTER_REF, { count: nextCount }, { merge: true });

    return formatAdminId(nextCount);
  });

  return nextId;
}

module.exports = { getNextAdminId, formatAdminId };