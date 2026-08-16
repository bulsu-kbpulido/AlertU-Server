// One-off backfill: assigns an adminId (ADMN-001, ADMN-002, ...) to every
// existing admin doc that doesn't have one yet, ordered by createdAt so the
// admin who's been around longest becomes ADMN-001. Also seeds counters/admins
// so new admins created afterward (via POST /create-admin) continue the
// sequence correctly.
//
// Run once, from the alertu_nodejs directory:
//   node scripts/backfillAdminIds.js
//
// Safe to re-run: admins that already have an adminId are left untouched,
// and the counter is only ever raised, never lowered.

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const serviceAccount = require('../serviceAccountKey.json');

// Ensure Firebase Admin is initialized before accessing Firestore
if (!getApps().length) {
  initializeApp({
    credential: cert(serviceAccount)
  });
}

const firestore = getFirestore();
const { formatAdminId } = require('../adminIdGenerator');

async function backfillAdminIds() {
  const snapshot = await firestore.collection('admins').get();

  if (snapshot.empty) {
    console.log('No admin documents found — nothing to backfill.');
    return;
  }

  // Docs missing createdAt (shouldn't normally happen, but the field was
  // only added once /create-admin started setting it) sort last, so they
  // don't jump ahead of admins with a real creation timestamp.
  const docs = snapshot.docs.slice().sort((a, b) => {
    const aTime = a.data().createdAt?.toMillis?.() ?? Infinity;
    const bTime = b.data().createdAt?.toMillis?.() ?? Infinity;
    return aTime - bTime;
  });

  const alreadyAssigned = docs.filter((d) => d.data().adminId);
  const needsAssignment = docs.filter((d) => !d.data().adminId);

  if (needsAssignment.length === 0) {
    console.log(`All ${docs.length} admin doc(s) already have an adminId — nothing to do.`);
    return;
  }

  // Start numbering after the highest adminId already in use, so re-runs
  // (or a project that already assigned a few by hand) don't collide.
  let highestExisting = 0;
  for (const d of alreadyAssigned) {
    const match = /^ADMN-(\d+)$/.exec(d.data().adminId || '');
    if (match) highestExisting = Math.max(highestExisting, Number(match[1]));
  }

  const batch = firestore.batch();
  let count = highestExisting;

  for (const docSnap of needsAssignment) {
    count += 1;
    const adminId = formatAdminId(count);
    batch.update(docSnap.ref, { adminId });
    console.log(`${docSnap.id} (${docSnap.data().name || docSnap.data().email || 'unnamed'}) → ${adminId}`);
  }

  await batch.commit();

  // Seed/raise the counter so the next live /create-admin call picks up
  // right after the last number handed out here.
  await firestore.collection('counters').doc('admins').set({ count }, { merge: true });

  console.log(`\nBackfilled ${needsAssignment.length} admin(s). Counter set to ${count}.`);
}

backfillAdminIds()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Backfill failed:', error);
    process.exit(1);
  });