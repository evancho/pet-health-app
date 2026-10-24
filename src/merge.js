// Pure household sync logic: last-write-wins merge with tombstones and an
// outbox (pending op log). Mirrors the proven pattern from pantry-tracker.

export function lastWriteWins(local, remote) {
  const localAt = Number(local?.updatedAt) || 0;
  const remoteAt = Number(remote?.updatedAt) || 0;
  if (remoteAt > localAt) return 'remote';
  if (localAt > remoteAt) return 'local';
  return 'tie';
}

function remoteTombstoneWins(local, remote) {
  if (!remote?.deletedAt) return false;
  return Number(remote.deletedAt) >= (Number(local?.updatedAt) || 0);
}

export function mergeHousehold(localRecords, remoteRecords) {
  const localById = new Map(localRecords.map((r) => [r.id, r]));
  const remoteById = new Map(remoteRecords.map((r) => [r.id, r]));
  const records = [];
  const pushIds = [];
  const dropIds = [];

  for (const id of new Set([...localById.keys(), ...remoteById.keys()])) {
    const local = localById.get(id);
    const remote = remoteById.get(id);
    if (!remote) {
      if (local) {
        records.push(local);
        pushIds.push(id);
      }
      continue;
    }
    if (!local) {
      if (!remote.deletedAt) {
        records.push({ ...remote, photoMissing: Object.keys(remote.photoPaths || {}).length > 0 });
      }
      continue;
    }
    if (remoteTombstoneWins(local, remote)) {
      dropIds.push(id);
      continue;
    }
    const winner = lastWriteWins(local, remote);
    if (winner === 'remote') {
      records.push({ ...remote });
    } else {
      records.push(local);
      if (winner === 'local') pushIds.push(id);
    }
  }
  return { records, pushIds, dropIds };
}

function versionStamp(record) {
  return Math.max(Number(record?.updatedAt) || 0, Number(record?.deletedAt) || 0);
}

export function collapseRemote(remoteRecords) {
  const groups = new Map();
  for (const record of remoteRecords || []) {
    if (!record?.id) continue;
    const rows = groups.get(record.id);
    if (rows) rows.push(record);
    else groups.set(record.id, [record]);
  }
  const records = [];
  const staleFileIds = [];
  for (const group of groups.values()) {
    const ranked = [...group].sort((a, b) => {
      const byStamp = versionStamp(b) - versionStamp(a);
      if (byStamp) return byStamp;
      return (Number(b?.deletedAt) || 0) - (Number(a?.deletedAt) || 0);
    });
    const winner = ranked[0];
    records.push(winner);
    for (const loser of ranked.slice(1)) {
      if (loser.remoteFileId && loser.remoteFileId !== winner.remoteFileId) staleFileIds.push(loser.remoteFileId);
    }
  }
  return { records, staleFileIds };
}

export function nextStoredDriveFields(incoming, existing) {
  return {
    remoteFileId: incoming && incoming.remoteFileId !== undefined ? (incoming.remoteFileId || existing?.remoteFileId || null) : (existing?.remoteFileId || null),
    photoPaths: incoming && incoming.photoPaths !== undefined ? (incoming.photoPaths || existing?.photoPaths || {}) : (existing?.photoPaths || {}),
  };
}

export function prepareStoredRecord(existing, incoming, { queue = true } = {}) {
  if (!incoming) return { action: 'keep', record: existing || null };
  const existingAt = Number(existing?.updatedAt) || 0;
  const incomingAt = Number(incoming.updatedAt) || 0;
  if (existing && !queue && existingAt > incomingAt) return { action: 'keep', record: existing };
  if (existing && !queue && existingAt === incomingAt) {
    const remoteFileId = incoming.remoteFileId || existing.remoteFileId || null;
    const photoPaths = incoming.photoPaths !== undefined ? (incoming.photoPaths || {}) : (existing.photoPaths || {});
    if (remoteFileId === (existing.remoteFileId || null) && JSON.stringify(photoPaths) === JSON.stringify(existing.photoPaths || {})) {
      return { action: 'keep', record: existing };
    }
    return { action: 'patch', record: { ...existing, remoteFileId, photoPaths } };
  }
  const fields = nextStoredDriveFields(incoming, existing);
  return {
    action: 'write',
    record: { ...incoming, remoteFileId: fields.remoteFileId, photoPaths: fields.photoPaths },
  };
}

// Which photos to upload (local ids with blob but no remote id), which remote
// photo file ids to delete (no longer referenced), which to download (remote
// ids missing locally).
export function photoDelta(localRecord, remoteRecord, localPhotoIds) {
  const localPaths = localRecord?.photoPaths || {};
  const remotePaths = remoteRecord?.photoPaths || {};
  const referenced = new Set([...Object.keys(localPaths), ...Object.keys(remotePaths)]);
  const upload = [];
  const download = [];
  const deleteRemoteFileIds = [];
  for (const photoId of Object.keys(localPaths)) {
    if (!localPaths[photoId] && localPhotoIds.has(photoId)) upload.push(photoId);
  }
  for (const [photoId, remoteFileId] of Object.entries(remotePaths)) {
    if (remoteFileId && !localPhotoIds.has(photoId)) download.push({ photoId, remoteFileId });
  }
  for (const [photoId, remoteFileId] of Object.entries(remotePaths)) {
    if (remoteFileId && !referenced.has(photoId)) deleteRemoteFileIds.push(remoteFileId);
  }
  return { upload, download, deleteRemoteFileIds };
}

// pending rows: { key, id, type, op: 'upsert'|'delete', updatedAt, photoPaths }
export function reconcileHousehold({ localRecords = [], remoteRecords = [], pending = [] } = {}) {
  const collapsed = collapseRemote(remoteRecords);
  const remoteList = collapsed.records;
  const remoteById = new Map(remoteList.map((r) => [r.id, r]));
  const opById = new Map();
  for (const row of pending || []) {
    if (!row?.id || (row.op !== 'delete' && row.op !== 'upsert')) continue;
    opById.set(row.id, row);
  }
  const localById = new Map();
  for (const record of localRecords || []) {
    if (record?.id && !record.deletedAt) localById.set(record.id, record);
  }

  const ackDeletes = [];
  const seenDeleteAcks = new Set();
  function queueAckDelete(row) {
    if (!row?.id || seenDeleteAcks.has(row.id)) return;
    seenDeleteAcks.add(row.id);
    ackDeletes.push({ key: row.key, id: row.id, updatedAt: Number(row.updatedAt) || 0 });
  }

  const suppressed = new Set();
  for (const row of opById.values()) {
    if (row.op !== 'delete') continue;
    const local = localById.get(row.id);
    if (local && Number(local.updatedAt) > Number(row.updatedAt)) {
      queueAckDelete(row);
      continue;
    }
    suppressed.add(row.id);
  }

  const visibleLocal = [...localById.values()].filter((r) => !suppressed.has(r.id));
  const localTombstones = [...opById.values()]
    .filter((row) => row.op === 'delete' && suppressed.has(row.id))
    .map((row) => ({
      id: row.id,
      type: row.type,
      updatedAt: Number(row.updatedAt) || 0,
      deletedAt: Number(row.updatedAt) || 0,
      photoPaths: row.photoPaths || {},
    }));

  const merged = mergeHousehold([...visibleLocal, ...localTombstones], remoteList);
  const pull = [];
  const push = [];
  const ackUpserts = [];

  for (const record of merged.records) {
    if (record.deletedAt) continue;
    const op = opById.get(record.id);
    const local = visibleLocal.find((row) => row.id === record.id) || null;
    const remoteRecord = remoteById.get(record.id) || null;
    const recordAt = Number(record.updatedAt) || 0;
    const remoteAt = Number(remoteRecord?.updatedAt) || 0;
    const localAt = Number(local?.updatedAt) || 0;
    const pendingUpsertAt = op?.op === 'upsert' ? (Number(op.updatedAt) || 0) : 0;
    if (pendingUpsertAt > localAt && pendingUpsertAt > remoteAt) continue;

    const deleteAt = op?.op === 'delete' ? (Number(op.updatedAt) || 0) : 0;
    const deleteWins = op?.op === 'delete' && deleteAt >= recordAt;
    if ((!local || recordAt > localAt) && !deleteWins) {
      pull.push({
        ...record,
        remoteFileId: record.remoteFileId || remoteRecord?.remoteFileId || null,
      });
    }
    if (local && recordAt > remoteAt && recordAt >= pendingUpsertAt && !deleteWins) {
      push.push({
        ...local,
        remoteFileId: local.remoteFileId || remoteRecord?.remoteFileId || null,
      });
      continue;
    }
    if (deleteWins) continue;
    if (op?.op === 'delete') queueAckDelete(op);
    else if (op?.op === 'upsert') ackUpserts.push({ key: op.key, id: record.id, updatedAt: recordAt });
  }

  const tombstones = [];
  for (const row of opById.values()) {
    if (row.op !== 'delete' || seenDeleteAcks.has(row.id)) continue;
    const remoteRecord = remoteById.get(row.id);
    const deletedAt = Number(row.updatedAt) || 0;
    if (!remoteRecord || (remoteRecord.deletedAt && Number(remoteRecord.deletedAt) >= deletedAt)) {
      queueAckDelete(row);
      continue;
    }
    if (!remoteRecord.deletedAt && (Number(remoteRecord.updatedAt) || 0) > deletedAt) {
      queueAckDelete(row);
      continue;
    }
    tombstones.push({
      id: row.id,
      type: row.type || remoteRecord.type,
      updatedAt: deletedAt,
      deletedAt,
      photoPaths: row.photoPaths || remoteRecord.photoPaths || {},
      remoteFileId: remoteRecord.remoteFileId || null,
      householdId: row.householdId || remoteRecord.householdId || null,
    });
  }

  for (const row of opById.values()) {
    if (row.op !== 'upsert') continue;
    const local = localById.get(row.id);
    const remoteRecord = remoteById.get(row.id);
    const pendingAt = Number(row.updatedAt) || 0;
    const localAt = Number(local?.updatedAt) || 0;
    if (remoteRecord?.deletedAt && Number(remoteRecord.deletedAt) >= pendingAt && Number(remoteRecord.deletedAt) >= localAt) {
      ackUpserts.push({ key: row.key, id: row.id, updatedAt: pendingAt });
    }
  }

  const tombstoneIds = new Set(tombstones.map((row) => row.id));
  const pushIds = new Set(push.map((r) => r.id));
  const seenUpsertAcks = new Set();
  const uniqueUpserts = [];
  for (const row of ackUpserts) {
    if (pushIds.has(row.id) || tombstoneIds.has(row.id) || seenUpsertAcks.has(row.id)) continue;
    seenUpsertAcks.add(row.id);
    uniqueUpserts.push(row);
  }

  return {
    dropIds: merged.dropIds,
    pull: pull.filter((r) => !tombstoneIds.has(r.id)),
    push: push.filter((r) => !tombstoneIds.has(r.id)),
    tombstones,
    ackUpserts: uniqueUpserts,
    ackDeletes,
    staleFileIds: collapsed.staleFileIds,
  };
}

export function parseDriveFolderId(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const folder = text.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (folder) return folder[1];
  const fileD = text.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (fileD) return fileD[1];
  const query = text.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (query) return query[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(text)) return text;
  return '';
}

export function driveFolderLink(folderId) {
  return `https://drive.google.com/drive/folders/${folderId}`;
}

export function recordsInScope(records, scope) {
  const target = scope || null;
  return (records || []).filter((r) => r && !r.deletedAt && (r.householdId || null) === target);
}

export function migrationCandidates(localRecords, householdId, now) {
  return localRecords
    .filter((r) => r && !r.householdId && !r.deletedAt)
    .map((r) => ({ ...r, householdId, updatedAt: Math.max(Number(r.updatedAt) || 0, now) }));
}

export function roleLabel(role) {
  if (role === 'reader') return '只能檢視';
  if (role === 'writer' || role === 'owner') return '可編輯';
  return '';
}

export function syncStatusLabel({
  configured = false,
  user = null,
  activeHouseholdId = null,
  syncing = false,
  message = '',
  online = true,
  role = '',
  needsReauth = false,
} = {}) {
  if (!online) return { key: 'offline', label: '離線' };
  if (syncing) return { key: 'syncing', label: '同步中' };
  if (!configured) return { key: 'local', label: '只在這台裝置' };
  if (!user || needsReauth) return { key: 'login', label: '需登入才能同步' };
  if (!activeHouseholdId) return { key: 'folder', label: '尚未設定資料夾' };
  const text = String(message || '');
  if (role === 'reader' || /只能檢視/.test(text)) return { key: 'reader', label: '只能檢視' };
  if (/已同步/.test(text)) return { key: 'synced', label: '已同步' };
  if (text) return { key: 'error', label: '同步未完成' };
  return { key: 'pending', label: '尚未同步' };
}
