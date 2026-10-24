import { describe, expect, it } from 'vitest';
import {
  collapseRemote,
  driveFolderLink,
  lastWriteWins,
  mergeHousehold,
  migrationCandidates,
  parseDriveFolderId,
  photoDelta,
  prepareStoredRecord,
  reconcileHousehold,
  recordsInScope,
  syncStatusLabel,
} from './merge.js';

const R = (id, updatedAt, extra = {}) => ({
  id,
  type: 'log',
  updatedAt,
  deletedAt: null,
  householdId: 'F1',
  photoPaths: {},
  ...extra,
});

describe('lastWriteWins', () => {
  it('picks newer side', () => {
    expect(lastWriteWins(R('a', 10), R('a', 20))).toBe('remote');
    expect(lastWriteWins(R('a', 30), R('a', 20))).toBe('local');
    expect(lastWriteWins(R('a', 20), R('a', 20))).toBe('tie');
  });
});

describe('mergeHousehold', () => {
  it('remote tombstone deletes local copy', () => {
    const { records, dropIds } = mergeHousehold([R('a', 10)], [R('a', 5, { deletedAt: 12 })]);
    expect(dropIds).toEqual(['a']);
    expect(records).toEqual([]);
  });
  it('local newer edit survives older remote tombstone', () => {
    const { records, dropIds } = mergeHousehold([R('a', 30)], [R('a', 5, { deletedAt: 12 })]);
    expect(dropIds).toEqual([]);
    expect(records[0].updatedAt).toBe(30);
  });
  it('remote-only record is pulled in', () => {
    const { records, pushIds } = mergeHousehold([], [R('b', 7)]);
    expect(records.map((r) => r.id)).toEqual(['b']);
    expect(pushIds).toEqual([]);
  });
});

describe('collapseRemote', () => {
  it('keeps newest duplicate and reports stale file ids', () => {
    const { records, staleFileIds } = collapseRemote([
      R('a', 5, { remoteFileId: 'old' }),
      R('a', 9, { remoteFileId: 'new' }),
    ]);
    expect(records.length).toBe(1);
    expect(records[0].remoteFileId).toBe('new');
    expect(staleFileIds).toEqual(['old']);
  });
});

describe('photoDelta', () => {
  it('classifies upload / download / stale-delete', () => {
    const local = { photoPaths: { p1: 'remoteFileA', p2: null } };
    const remote = { photoPaths: { p1: 'remoteFileA', p3: 'remoteFileC' } };
    const localPhotoIds = new Set(['p1', 'p2']);
    const delta = photoDelta(local, remote, localPhotoIds);
    expect(delta.upload).toEqual(['p2']);
    expect(delta.download).toEqual([{ photoId: 'p3', remoteFileId: 'remoteFileC' }]);
    expect(delta.deleteRemoteFileIds).toEqual([]);
  });
  it('no photo blob locally means no upload for that id', () => {
    const delta = photoDelta({ photoPaths: { p2: null } }, {}, new Set());
    expect(delta.upload).toEqual([]);
  });
});

describe('prepareStoredRecord', () => {
  it('queue=true always writes', () => {
    const { action } = prepareStoredRecord(R('a', 9), R('a', 5));
    expect(action).toBe('write');
  });
  it('queue=false keeps newer existing', () => {
    const { action, record } = prepareStoredRecord(R('a', 9), R('a', 5), { queue: false });
    expect(action).toBe('keep');
    expect(record.updatedAt).toBe(9);
  });
  it('queue=false patch stores drive fields only', () => {
    const { action, record } = prepareStoredRecord(
      R('a', 9, { remoteFileId: null }),
      R('a', 9, { remoteFileId: 'file1', title: 'newer but ignored' }),
      { queue: false },
    );
    expect(action).toBe('patch');
    expect(record.remoteFileId).toBe('file1');
    expect(record.title).toBeUndefined();
  });
});

describe('reconcileHousehold', () => {
  it('local newer pushes, remote newer pulls', () => {
    const out = reconcileHousehold({
      localRecords: [R('a', 30), R('b', 3)],
      remoteRecords: [R('a', 10, { remoteFileId: 'fa' }), R('b', 20, { remoteFileId: 'fb' })],
      pending: [],
    });
    expect(out.push.map((r) => r.id)).toEqual(['a']);
    expect(out.push[0].remoteFileId).toBe('fa');
    expect(out.pull.map((r) => r.id)).toEqual(['b']);
    expect(out.pull[0].remoteFileId).toBe('fb');
  });

  it('pending delete writes remote tombstone', () => {
    const out = reconcileHousehold({
      localRecords: [],
      remoteRecords: [R('a', 10, { remoteFileId: 'fa' })],
      pending: [{ key: 'F1:a', id: 'a', type: 'log', op: 'delete', updatedAt: 20, photoPaths: { p1: 'photof1' } }],
    });
    expect(out.tombstones.length).toBe(1);
    expect(out.tombstones[0].photoPaths).toEqual({ p1: 'photof1' });
    expect(out.ackDeletes).toEqual([]);
  });

  it('remote delete newer than pending delete is acked', () => {
    const out = reconcileHousehold({
      localRecords: [],
      remoteRecords: [R('a', 5, { deletedAt: 50, remoteFileId: 'fa' })],
      pending: [{ key: 'F1:a', id: 'a', type: 'log', op: 'delete', updatedAt: 20 }],
    });
    expect(out.tombstones).toEqual([]);
    expect(out.ackDeletes.map((a) => a.id)).toEqual(['a']);
  });

  it('local edit after delete supersedes the pending delete', () => {
    const out = reconcileHousehold({
      localRecords: [R('a', 40)],
      remoteRecords: [R('a', 10)],
      pending: [{ key: 'F1:a', id: 'a', type: 'log', op: 'delete', updatedAt: 20 }],
    });
    expect(out.ackDeletes.map((a) => a.id)).toEqual(['a']);
    expect(out.push.map((r) => r.id)).toEqual(['a']);
  });

  it('pending upsert newer than both sides is left alone', () => {
    const out = reconcileHousehold({
      localRecords: [R('a', 10)],
      remoteRecords: [R('a', 20)],
      pending: [{ key: 'F1:a', id: 'a', type: 'log', op: 'upsert', updatedAt: 50 }],
    });
    expect(out.push).toEqual([]);
    expect(out.pull).toEqual([]);
    expect(out.ackUpserts).toEqual([]);
  });
});

describe('folder id helpers', () => {
  it('parses links and raw ids', () => {
    expect(parseDriveFolderId('https://drive.google.com/drive/folders/abcDEF-123_xyz')).toBe('abcDEF-123_xyz');
    expect(parseDriveFolderId('https://drive.google.com/drive/folders/abc123456789?usp=sharing')).toBe('abc123456789');
    expect(parseDriveFolderId('https://drive.google.com/file/d/abc123456789/view')).toBe('abc123456789');
    expect(parseDriveFolderId('abc123456789')).toBe('abc123456789');
    expect(parseDriveFolderId('nope')).toBe('');
    expect(driveFolderLink('abc')).toBe('https://drive.google.com/drive/folders/abc');
  });
});

describe('scope helpers', () => {
  it('filters to one household', () => {
    const rows = [R('a', 1), R('b', 1, { householdId: null }), R('c', 1, { deletedAt: 2 })];
    expect(recordsInScope(rows, 'F1').map((r) => r.id)).toEqual(['a']);
    expect(recordsInScope(rows, null).map((r) => r.id)).toEqual(['b']);
  });
  it('migration stamps household and bumps updatedAt', () => {
    const out = migrationCandidates([R('a', 5, { householdId: null })], 'F1', 100);
    expect(out[0].householdId).toBe('F1');
    expect(out[0].updatedAt).toBe(100);
  });
});

describe('syncStatusLabel', () => {
  it('order of states', () => {
    expect(syncStatusLabel({ online: false }).key).toBe('offline');
    expect(syncStatusLabel({ configured: false }).key).toBe('local');
    expect(syncStatusLabel({ configured: true, user: null }).key).toBe('login');
    expect(syncStatusLabel({ configured: true, user: {}, activeHouseholdId: null }).key).toBe('folder');
    expect(syncStatusLabel({ configured: true, user: {}, activeHouseholdId: 'F', message: '已同步' }).key).toBe('synced');
    expect(syncStatusLabel({ configured: true, user: {}, activeHouseholdId: 'F', role: 'reader' }).key).toBe('reader');
  });
});
