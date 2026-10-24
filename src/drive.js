// Google Drive household sync transport (GIS token popup + Drive REST).
// Same proven flow as pantry-tracker: no backend, token kept in memory only.

const SCOPE = 'https://www.googleapis.com/auth/drive';
const GIS_SRC = 'https://accounts.google.com/gsi/client';

let gisPromise = null;
let tokenClient = null;
let token = null;

export function driveConfigured() {
  return Boolean(import.meta.env.VITE_GOOGLE_CLIENT_ID);
}

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = GIS_SRC;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        gisPromise = null;
        reject(new Error('無法載入 Google 登入'));
      };
      document.head.append(script);
    });
  }
  return gisPromise;
}

function clientId() {
  const id = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  if (!id) {
    const error = new Error('這個網站還沒有 Google 登入設定。');
    error.code = 'not-configured';
    throw error;
  }
  return id;
}

function authHeader() {
  if (!token?.accessToken || token.expiresAt <= Date.now() + 60000) {
    const error = new Error('Google 登入已過期，請重新登入。');
    error.code = '401';
    throw error;
  }
  return { Authorization: `Bearer ${token.accessToken}` };
}

async function driveFetch(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    const wrapped = new Error(error?.message || 'Failed to fetch');
    wrapped.code = 'network';
    throw wrapped;
  }
  if (response.ok) return response;
  let detail = '';
  try {
    const body = await response.json();
    detail = body?.error?.message || '';
  } catch {
    detail = '';
  }
  const error = new Error(detail || `Drive ${response.status}`);
  error.code = String(response.status);
  throw error;
}

export function hasGoogleToken() {
  return Boolean(token?.accessToken && token.expiresAt > Date.now() + 60000);
}

export function rememberGoogleAccount(email) {
  if (email) try { localStorage.setItem('peth.googleAccount', email); } catch {}
}

export function googleAccountHint() {
  try { return localStorage.getItem('peth.googleAccount') || ''; } catch { return ''; }
}

export function clearGoogleToken() {
  token = null;
}

export function forgetGoogleAccount() {
  try { localStorage.removeItem('peth.googleAccount'); } catch {}
}

export function ensureGoogleAccess({ prompt = '', hint = '' } = {}) {
  if (hasGoogleToken()) return Promise.resolve(token);
  return requestGoogleAccess({ prompt, hint });
}

export function requestGoogleAccess({ prompt = 'select_account', hint = '' } = {}) {
  return loadGis().then(() => new Promise((resolve, reject) => {
    const id = clientId();
    const remembered = String(hint || googleAccountHint() || '').trim();
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: id,
      scope: SCOPE,
      ...(remembered ? { hint: remembered } : {}),
      callback: (response) => {
        if (response.error) {
          const error = new Error(response.error);
          error.code = response.error;
          reject(error);
          return;
        }
        token = {
          accessToken: response.access_token,
          expiresAt: Date.now() + Number(response.expires_in || 3600) * 1000,
        };
        resolve(token);
      },
    });
    tokenClient.requestAccessToken(remembered ? { prompt, hint: remembered } : { prompt });
  }));
}

export async function signOutGoogle() {
  const accessToken = token?.accessToken;
  token = null;
  tokenClient = null;
  forgetGoogleAccount();
  if (!accessToken || !window.google?.accounts?.oauth2?.revoke) return;
  await new Promise((resolve) => {
    window.google.accounts.oauth2.revoke(accessToken, () => resolve());
  });
}

export async function googleProfile() {
  const response = await driveFetch('https://www.googleapis.com/drive/v3/about?fields=user', {
    headers: authHeader(),
  });
  const body = await response.json();
  const user = body.user || {};
  return {
    email: user.emailAddress || '',
    displayName: user.displayName || user.emailAddress || 'Google 帳號',
  };
}

async function createFile({ name, mimeType, parents, mediaType, media }) {
  const boundary = `peth-${crypto.randomUUID()}`;
  const meta = { name, mimeType };
  if (parents) meta.parents = parents;
  const preamble = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${mediaType}\r\n\r\n`;
  const ending = `\r\n--${boundary}--\r\n`;
  const body = new Blob([preamble, media, ending]);
  const response = await driveFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name', {
    method: 'POST',
    headers: {
      ...authHeader(),
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  return response.json();
}

async function updateMedia(fileId, mediaType, media) {
  const response = await driveFetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&fields=id`, {
    method: 'PATCH',
    headers: {
      ...authHeader(),
      'Content-Type': mediaType,
    },
    body: media,
  });
  return response.json();
}

async function findNamedFile(folderId, name) {
  const q = `'${folderId}' in parents and name = '${name.replaceAll("'", "\\'")}' and trashed = false`;
  const url = new URL('https://www.googleapis.com/drive/v3/files');
  url.searchParams.set('q', q);
  url.searchParams.set('fields', 'files(id,name)');
  url.searchParams.set('pageSize', '1');
  const response = await driveFetch(url, { headers: authHeader() });
  const body = await response.json();
  return body.files?.[0]?.id || '';
}

const TYPE_PREFIX = { pet: 'pet', log: 'log', medical: 'med' };

function recordFileName(record) {
  return `${TYPE_PREFIX[record.type] || 'rec'}-${record.id}.json`;
}

function photoFileName(photoId) {
  return `photo-${photoId}.jpg`;
}

export async function createHouseholdFolder(name) {
  const response = await driveFetch('https://www.googleapis.com/drive/v3/files?fields=id,name', {
    method: 'POST',
    headers: {
      ...authHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: name.trim(),
      mimeType: 'application/vnd.google-apps.folder',
      appProperties: { petHealthApp: 'root' },
    }),
  });
  const folder = await response.json();
  return { id: folder.id, name: folder.name, role: 'owner' };
}

export async function readHouseholdFolder(folderId) {
  const response = await driveFetch(`https://www.googleapis.com/drive/v3/files/${folderId}?fields=id,name,mimeType,trashed,capabilities(canEdit)`, {
    headers: authHeader(),
  });
  const folder = await response.json();
  if (folder.trashed || folder.mimeType !== 'application/vnd.google-apps.folder') {
    throw new Error('這不是可用的雲端硬碟資料夾。');
  }
  return {
    id: folder.id,
    name: folder.name || '寵物健康',
    role: folder.capabilities?.canEdit ? 'writer' : 'reader',
  };
}

export function visibleFolderEditors(permissions, { selfEmail = '' } = {}) {
  const self = String(selfEmail || '').trim().toLowerCase();
  const rows = (permissions || [])
    .filter((row) => row && !row.deleted && row.type === 'user' && (row.role === 'owner' || row.role === 'writer'))
    .map((row) => {
      const email = row.emailAddress || '';
      const owner = row.role === 'owner';
      return {
        id: row.id,
        email,
        name: row.displayName || email || 'Google 帳號',
        role: owner ? 'owner' : 'writer',
        removable: !owner,
        self: Boolean(self) && email.toLowerCase() === self,
      };
    });
  rows.sort((a, b) => Number(b.role === 'owner') - Number(a.role === 'owner') || a.email.localeCompare(b.email, 'zh-Hant'));
  return rows;
}

export async function listFolderPermissions(folderId) {
  const permissions = [];
  let pageToken = '';
  do {
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${folderId}/permissions`);
    url.searchParams.set('fields', 'nextPageToken,permissions(id,type,role,emailAddress,displayName,deleted)');
    url.searchParams.set('pageSize', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await driveFetch(url, { headers: authHeader() });
    const body = await response.json();
    permissions.push(...(body.permissions || []));
    pageToken = body.nextPageToken || '';
  } while (pageToken);
  return permissions;
}

export async function shareFolderWriter(folderId, email) {
  const response = await driveFetch(`https://www.googleapis.com/drive/v3/files/${folderId}/permissions?sendNotificationEmail=true`, {
    method: 'POST',
    headers: {
      ...authHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type: 'user',
      role: 'writer',
      emailAddress: email.trim(),
    }),
  });
  if (response.status !== 204) await response.json().catch(() => {});
}

export async function listRemoteRecords(folderId) {
  const files = [];
  let pageToken = '';
  do {
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('q', `'${folderId}' in parents and trashed = false and (name contains 'pet-' or name contains 'log-' or name contains 'med-')`);
    url.searchParams.set('fields', 'nextPageToken,files(id,name)');
    url.searchParams.set('pageSize', '200');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await driveFetch(url, { headers: authHeader() });
    const body = await response.json();
    files.push(...(body.files || []));
    pageToken = body.nextPageToken || '';
  } while (pageToken);

  const records = [];
  for (const file of files) {
    const matched = /^(pet|log|med)-(.+)\.json$/.exec(file.name || '');
    if (!matched) continue;
    const response = await driveFetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, {
      headers: authHeader(),
    });
    const record = await response.json();
    records.push({
      ...record,
      id: record.id || matched[2],
      type: record.type || ({ pet: 'pet', log: 'log', med: 'medical' })[matched[1]],
      remoteFileId: file.id,
      householdId: folderId,
    });
  }
  return records;
}

export async function writeRemoteRecord(folderId, record) {
  const payload = JSON.stringify({
    id: record.id,
    type: record.type,
    petId: record.petId ?? null,
    name: record.name ?? '',
    species: record.species ?? '',
    birthday: record.birthday ?? '',
    unit: record.unit ?? '',
    kind: record.kind ?? '',
    weight: record.weight ?? null,
    food: record.food ?? '',
    poop: record.poop ?? '',
    temp: record.temp ?? null,
    note: record.note ?? '',
    dt: record.dt ?? '',
    medType: record.medType ?? '',
    title: record.title ?? '',
    date: record.date ?? '',
    nextDate: record.nextDate ?? '',
    done: record.done ?? false,
    photoPaths: record.photoPaths || {},
    householdId: folderId,
    createdAt: record.createdAt || record.updatedAt || Date.now(),
    updatedAt: record.updatedAt || Date.now(),
    deletedAt: record.deletedAt || null,
  });
  const fileName = recordFileName(record);
  const existing = record.remoteFileId || await findNamedFile(folderId, fileName);
  if (existing) {
    await updateMedia(existing, 'application/json', payload);
    return existing;
  }
  const created = await createFile({
    name: fileName,
    mimeType: 'application/json',
    parents: [folderId],
    mediaType: 'application/json',
    media: payload,
  });
  return created.id;
}

export async function uploadPhotoFile(folderId, photoId, blob) {
  const fileName = photoFileName(photoId);
  const existing = await findNamedFile(folderId, fileName);
  if (existing) {
    await updateMedia(existing, blob.type || 'image/jpeg', blob);
    return existing;
  }
  const created = await createFile({
    name: fileName,
    mimeType: blob.type || 'image/jpeg',
    parents: [folderId],
    mediaType: blob.type || 'image/jpeg',
    media: blob,
  });
  return created.id;
}

export async function downloadPhotoFile(fileId) {
  const response = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: authHeader(),
  });
  return response.arrayBuffer();
}

export async function deleteDriveFile(fileId) {
  if (!fileId) return;
  try {
    await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method: 'DELETE',
      headers: authHeader(),
    });
  } catch (error) {
    if (String(error.code) !== '404') throw error;
  }
}

export function explainDriveError(error) {
  const code = String(error?.code || '');
  if (code === '401') return 'Google 登入已過期，請重新登入。';
  if (code === '403') return '這個雲端硬碟資料夾不能寫入，或是 Google 權限沒開好。';
  if (code === '404') return '找不到那個雲端硬碟資料夾。';
  if (code === 'network') return '連不到 Google，檢查網路後再試。';
  if (code === 'access_denied') return '你取消了 Google 登入。';
  return error?.message || '同步失敗，稍後再試。';
}
