// Session + sync orchestrator: Google token, household folder selection,
// pull/push/photos/tombstones against Drive. UI gets status via onStatus.
import {
  ackOutbox,
  deleteRecord,
  getPhotoBlob,
  listOutbox,
  loadAll,
  loadRaw,
  putPhoto,
  saveRecord,
  setPhotoRemoteFileId,
} from './db.js';
import {
  clearGoogleToken,
  createHouseholdFolder,
  deleteDriveFile,
  downloadPhotoFile,
  driveConfigured,
  ensureGoogleAccess,
  explainDriveError,
  forgetGoogleAccount,
  googleAccountHint,
  googleProfile,
  hasGoogleToken,
  listFolderPermissions,
  listRemoteRecords,
  readHouseholdFolder,
  rememberGoogleAccount,
  requestGoogleAccess,
  shareFolderWriter,
  signOutGoogle as driveSignOut,
  uploadPhotoFile,
  visibleFolderEditors,
  writeRemoteRecord,
} from './drive.js';
import {
  driveFolderLink,
  migrationCandidates,
  parseDriveFolderId,
  reconcileHousehold,
  syncStatusLabel,
} from './merge.js';

const USER_KEY = 'peth.google-user';
const ACTIVE_KEY = 'peth.drive-folder';

const state = {
  configured: driveConfigured(),
  user: readJson(USER_KEY),
  household: null, // { id, name, role }
  syncing: false,
  message: '',
  needsReauth: false,
};

let onStatus = () => {};
let onSynced = () => {};

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function emit() {
  onStatus(statusSnapshot());
}

export function statusSnapshot() {
  const online = navigator.onLine !== false;
  const label = syncStatusLabel({
    configured: state.configured,
    user: state.user,
    activeHouseholdId: state.household?.id || null,
    syncing: state.syncing,
    message: state.message,
    online,
    role: state.household?.role || '',
    needsReauth: state.needsReauth,
  });
  return {
    ...label,
    configured: state.configured,
    user: state.user,
    household: state.household,
    message: state.message,
  };
}

export function initSession({ onStatusChange, onSynced: synced }) {
  onStatus = onStatusChange || (() => {});
  onSynced = synced || (() => {});
  if (state.configured && state.household?.id && hasGoogleToken()) {
    // token exists only in memory; nothing else to restore at boot
  }
  emit();
}

export function setHouseholdFromStorage() {
  let id = '';
  try { id = localStorage.getItem(ACTIVE_KEY) || ''; } catch {}
  if (id) {
    state.household = { id, name: '共用資料夾', role: '' };
    emit();
  }
}

export async function googleSignIn() {
  const token = await requestGoogleAccess({ prompt: 'select_account', hint: googleAccountHint() });
  const profile = await googleProfile();
  state.user = profile;
  try { localStorage.setItem(USER_KEY, JSON.stringify(profile)); } catch {}
  rememberGoogleAccount(profile.email);
  state.needsReauth = false;
  state.message = '';
  emit();
  return profile;
}

export async function restoreSilent() {
  if (!state.configured || !state.user) return false;
  try {
    await ensureGoogleAccess({ prompt: 'none', hint: googleAccountHint() });
    const profile = await googleProfile();
    state.user = profile;
    try { localStorage.setItem(USER_KEY, JSON.stringify(profile)); } catch {}
    emit();
    return true;
  } catch {
    return false;
  }
}

export async function googleSignOut() {
  await driveSignOut();
  state.user = null;
  state.household = null;
  state.needsReauth = false;
  try {
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(ACTIVE_KEY);
  } catch {}
  forgetGoogleAccount();
  clearGoogleToken();
  emit();
}

export async function createFolder(name) {
  await ensureGoogleAccess();
  const folder = await createHouseholdFolder(name || '寵物健康');
  state.household = folder;
  try { localStorage.setItem(ACTIVE_KEY, folder.id); } catch {}
  state.message = '';
  emit();
  await runSync();
  return folder;
}

export async function joinFolder(linkOrId) {
  const id = parseDriveFolderId(linkOrId);
  if (!id) throw new Error('資料夾連結看不懂，請貼 Drive 資料夾的網址。');
  await ensureGoogleAccess();
  const folder = await readHouseholdFolder(id);
  state.household = folder;
  try { localStorage.setItem(ACTIVE_KEY, folder.id); } catch {}
  state.message = '';
  emit();
  await runSync();
  return folder;
}

export function currentFolderLink() {
  return state.household ? driveFolderLink(state.household.id) : '';
}

export async function listMembers() {
  if (!state.household) return [];
  await ensureGoogleAccess();
  const permissions = await listFolderPermissions(state.household.id);
  return {
    members: visibleFolderEditors(permissions, { selfEmail: state.user?.email || '' }),
    folderLink: driveFolderLink(state.household.id),
  };
}

export async function inviteMember(email) {
  if (!state.household) return;
  await ensureGoogleAccess();
  await shareFolderWriter(state.household.id, email);
}

export async function migrateLocalToHousehold() {
  if (!state.household) return;
  const localRecords = await loadAll(null);
  if (!localRecords.length) return;
  const stamped = migrationCandidates(localRecords, state.household.id, Date.now());
  for (const record of stamped) {
    const photoIds = Object.keys(record.photoPaths || {});
    await saveRecord({ ...record, photoPaths: record.photoPaths || {} }, { photoIds, queue: true });
  }
}

// Main sync pass. Returns snapshot text.
export async function runSync() {
  if (!state.configured) { state.message = ''; emit(); return; }
  if (!state.user) { state.needsReauth = true; state.message = '需登入才能同步'; emit(); return; }
  if (!state.household?.id) { state.message = '尚未設定共用資料夾'; emit(); return; }
  if (state.syncingFlag) return;
  state.syncingFlag = true;
  state.syncing = true;
  state.message = '';
  emit();
  try {
    await ensureGoogleAccess();
    const folderId = state.household.id;
    const [allStored, pending, remoteRecords] = await Promise.all([
      loadAllRaw(folderId),
      listOutbox(),
      listRemoteRecords(folderId),
    ]);
    const householdPending = pending.filter((row) => row.householdId === folderId);
    const out = reconcileHousehold({
      localRecords: allStored,
      remoteRecords,
      pending: householdPending,
    });

    for (const id of out.dropIds) {
      await deleteRecord(id, { queue: false });
    }
    for (const record of out.pull) {
      await saveRecord({ ...record, householdId: folderId }, { photoIds: Object.keys(record.photoPaths || {}), queue: false });
    }
    // photos missing locally -> download first so pulled records show images
    for (const record of out.pull) {
      for (const [photoId, remoteFileId] of Object.entries(record.photoPaths || {})) {
        if (!remoteFileId) continue;
        if (await getPhotoBlob(photoId)) continue;
        const buf = await downloadPhotoFile(remoteFileId);
        await putPhoto(photoId, new Blob([buf], { type: 'image/jpeg' }));
      }
    }

    // push local winners with their photos
    for (const record of out.push) {
      let paths = { ...(record.photoPaths || {}) };
      for (const photoId of Object.keys(paths)) {
        if (paths[photoId]) continue;
        const blob = await getPhotoBlob(photoId);
        if (!blob) continue;
        const fileId = await uploadPhotoFile(folderId, photoId, blob);
        paths[photoId] = fileId;
        await setPhotoRemoteFileId(record.id, photoId, fileId);
      }
      const remoteFileId = await writeRemoteRecord(folderId, { ...record, photoPaths: paths });
      await saveRecord({ ...record, photoPaths: paths, remoteFileId }, { photoIds: Object.keys(paths), queue: false });
    }

    // tombstones: overwrite remote json as deleted, remove photo files
    for (const tomb of out.tombstones) {
      await writeRemoteRecord(folderId, tomb);
      for (const remoteFileId of Object.values(tomb.photoPaths || {})) {
        await deleteDriveFile(remoteFileId);
      }
    }
    for (const stale of out.staleFileIds) await deleteDriveFile(stale);

    for (const ack of [...out.ackUpserts, ...out.ackDeletes]) await ackOutbox(ack.key);

    // keep local copy of tombstoned records for remote photo cleanup safety: drop them
    for (const tomb of out.tombstones) {
      await deleteRecord(tomb.id, { queue: false });
    }

    if (state.household.role !== 'reader') await migrateLocalToHousehold();

    state.message = '已同步';
    state.needsReauth = false;
    onSynced();
    return state.message;
  } catch (error) {
    if (String(error?.code) === '401') state.needsReauth = true;
    state.message = explainDriveError(error);
    return state.message;
  } finally {
    state.syncing = false;
    state.syncingFlag = false;
    emit();
  }
}

// raw rows including tombstones (deletedAt) for the folder scope
async function loadAllRaw(folderId) {
  return loadRaw(folderId);
}

export function sessionState() {
  return state;
}
