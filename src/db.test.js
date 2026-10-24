import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  ackOutbox,
  deleteRecord,
  getPhotoBlob,
  listOutbox,
  loadAll,
  loadRaw,
  putPhoto,
  saveRecord,
} from './db.js';
import { makeLog, makePet } from './domain.js';

const F = 'FOLDER1';

describe('db + outbox roundtrip', () => {
  it('saves, queues, acks, and deletes with photos', async () => {
    const pet = makePet({ name: '點點', species: 'dog', householdId: F });
    await saveRecord(pet, { photoIds: [], queue: true });
    const rows = await loadAll(F);
    expect(rows.map((r) => r.name)).toEqual(['點點']);

    let pending = await listOutbox();
    expect(pending.length).toBe(1);
    expect(pending[0].op).toBe('upsert');
    await ackOutbox(pending[0].key);
    expect(await listOutbox()).toEqual([]);

    // photo attach
    const blob = new Blob(['img'], { type: 'image/jpeg' });
    const photoId = 'ph1';
    await putPhoto(photoId, blob);
    const log = makeLog({ petId: pet.id, kind: 'food', householdId: F, photoPaths: { [photoId]: null } });
    await saveRecord(log, { photoIds: [photoId], queue: true });
    const withPhoto = (await loadAll(F)).find((r) => r.type === 'log');
    expect(withPhoto.photoBlobs.length).toBe(1);
    expect(await getPhotoBlob(photoId)).toBeTruthy();

    // editing without the photo drops the blob
    await saveRecord({ ...log, note: '改', updatedAt: Date.now() + 5 }, { photoIds: [], queue: true });
    expect(await getPhotoBlob(photoId)).toBe(null);
    const edited = (await loadAll(F)).find((r) => r.id === log.id);
    expect(Object.keys(edited.photoPaths)).toEqual([]);

    // delete queues a tombstone op and loadRaw keeps nothing hard-deleted locally
    await deleteRecord(log.id, { queue: true });
    pending = await listOutbox();
    const del = pending.find((row) => row.op === 'delete');
    expect(del.id).toBe(log.id);
    expect(del.type).toBe('log');
    expect((await loadAll(F)).map((r) => r.id)).toEqual([pet.id]);
    expect((await loadRaw(F)).map((r) => r.id)).toEqual([pet.id]);
    await ackOutbox(del.key);
  });

  it('queue=false remote pulls do not create outbox rows', async () => {
    const remote = makeLog({ petId: 'x', kind: 'daily', householdId: F });
    await saveRecord({ ...remote, id: 'remote1', updatedAt: 500 }, { photoIds: [], queue: false });
    const pending = await listOutbox();
    expect(pending.some((row) => row.id === 'remote1')).toBe(false);
    await deleteRecord('remote1', { queue: false });
    expect((await loadRaw(F)).some((r) => r.id === 'remote1')).toBe(false);
  });

  it('local-only records stay in null scope', async () => {
    const local = makePet({ name: '家貓', householdId: null });
    await saveRecord(local, { photoIds: [], queue: true });
    expect((await loadAll(null)).map((r) => r.name)).toContain('家貓');
    expect((await listOutbox()).some((r) => r.id === local.id)).toBe(false); // no queue without household
  });
});
