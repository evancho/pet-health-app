import { prepareStoredRecord, recordsInScope } from './merge.js';

const DB_NAME = 'pet-health-app';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('records')) db.createObjectStore('records', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        dbPromise = null;
        reject(request.error || new Error('無法開啟資料庫'));
      };
    });
  }
  return dbPromise;
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('資料讀寫失敗'));
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('資料寫入中斷'));
    tx.onerror = () => reject(tx.error || new Error('資料寫入失敗'));
  });
}

export async function loadAll(householdId = null) {
  const db = await openDb();
  const records = await requestToPromise(db.transaction('records').objectStore('records').getAll());
  const photos = await requestToPromise(db.transaction('photos').objectStore('photos').getAll());
  const photoMap = new Map(photos.map((p) => [p.id, p.blob]));
  return recordsInScope(records, householdId)
    .map((record) => ({
      ...record,
      photoBlobs: Object.keys(record.photoPaths || {})
        .map((photoId) => ({ photoId, blob: photoMap.get(photoId) || null }))
        .filter((entry) => entry.blob),
    }))
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

export async function loadRaw(householdId = null) {
  const db = await openDb();
  const records = await requestToPromise(db.transaction('records').objectStore('records').getAll());
  return (records || []).filter((r) => r && (r.householdId || null) === (householdId || null));
}

export async function listOutbox() {
  const db = await openDb();
  return (await requestToPromise(db.transaction('outbox').objectStore('outbox').getAll())) || [];
}

// record.photoPaths: { photoId: remoteFileIdOrNull }. photoIds: array of photo
// ids that have blobs in the photos store (existing kept, new added).
export async function saveRecord(record, { photoIds = [], queue = true } = {}) {
  const db = await openDb();
  const existing = await requestToPromise(db.transaction('records').objectStore('records').get(record.id));
  const prepared = prepareStoredRecord(existing, record, { queue });
  if (prepared.action === 'keep') return existing;
  const stored = { ...prepared.record };

  const tx = db.transaction(['records', 'photos', 'outbox'], 'readwrite');
  const photos = tx.objectStore('photos');

  // photoIds is the source of truth for which photos this record keeps;
  // remote file ids are inherited from the existing row or the incoming paths.
  const wanted = new Set(photoIds);
  const prevPaths = existing?.photoPaths || {};
  const incomingPaths = prepared.record.photoPaths || {};
  stored.photoPaths = {};
  for (const photoId of wanted) {
    stored.photoPaths[photoId] = incomingPaths[photoId] ?? prevPaths[photoId] ?? null;
  }
  for (const photoId of Object.keys(prevPaths)) {
    if (!wanted.has(photoId)) photos.delete(photoId);
  }

  tx.objectStore('records').put(stored);
  if (queue && prepared.action === 'write' && stored.householdId) {
    tx.objectStore('outbox').put({
      key: `${stored.householdId}:${stored.id}`,
      id: stored.id,
      type: stored.type,
      householdId: stored.householdId,
      op: 'upsert',
      updatedAt: stored.updatedAt,
      photoPaths: stored.photoPaths,
    });
  }
  await transactionDone(tx);
  return stored;
}

export async function putPhoto(photoId, blob) {
  const db = await openDb();
  const tx = db.transaction('photos', 'readwrite');
  tx.objectStore('photos').put({ id: photoId, blob });
  await transactionDone(tx);
}

export async function getPhotoBlob(photoId) {
  const db = await openDb();
  const row = await requestToPromise(db.transaction('photos').objectStore('photos').get(photoId));
  return row?.blob || null;
}

export async function setPhotoRemoteFileId(recordId, photoId, remoteFileId) {
  const db = await openDb();
  const record = await requestToPromise(db.transaction('records').objectStore('records').get(recordId));
  if (!record) return null;
  record.photoPaths = { ...(record.photoPaths || {}), [photoId]: remoteFileId };
  const tx = db.transaction('records', 'readwrite');
  tx.objectStore('records').put(record);
  await transactionDone(tx);
  return record;
}

export async function deleteRecord(id, { queue = true, updatedAt = Date.now() } = {}) {
  const db = await openDb();
  const existing = await requestToPromise(db.transaction('records').objectStore('records').get(id));
  const tx = db.transaction(['records', 'photos', 'outbox'], 'readwrite');
  tx.objectStore('records').delete(id);
  if (existing?.photoPaths) {
    for (const photoId of Object.keys(existing.photoPaths)) tx.objectStore('photos').delete(photoId);
  }
  if (queue && existing?.householdId) {
    tx.objectStore('outbox').put({
      key: `${existing.householdId}:${existing.id}`,
      id,
      type: existing.type,
      householdId: existing.householdId,
      op: 'delete',
      updatedAt,
      photoPaths: existing.photoPaths || {},
    });
  }
  await transactionDone(tx);
}

export async function ackOutbox(key) {
  const db = await openDb();
  const tx = db.transaction('outbox', 'readwrite');
  tx.objectStore('outbox').delete(key);
  await transactionDone(tx);
}
