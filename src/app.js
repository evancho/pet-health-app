import {
  KINDS, MEDTYPES, POOPS, SPECIES, UNITS,
  ageLabel, bumpNextDate, daysSince, dueInfo, kindLabel, makeLog, makeMedical,
  makePet, medTypeLabel, newId, poopLabel, speciesEmoji, todayStr, weightSeries,
} from './domain.js';
import { deleteRecord, getPhotoBlob, loadAll, putPhoto, saveRecord } from './db.js';
import { compressImage } from './images.js';
import {
  createFolder, currentFolderLink, googleSignIn, googleSignOut, initSession,
  inviteMember, joinFolder, listMembers, restoreSilent, runSync, setHouseholdFromStorage,
  statusSnapshot,
} from './session.js';
import { driveConfigured } from './drive.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const state = {
  scope: null,
  records: [],
  petId: +(localStorage.getItem('peth.petId') || 0),
  dailyPhotos: [], medPhotos: [], petPhoto: [],
  kind: 'daily', poop: '', medType: 'vaccine', species: 'dog', editPetId: 0,
  status: null,
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toast(msg, color) {
  const t = $('#toast');
  t.textContent = msg; t.style.background = color || 'var(--green)'; t.style.color = '#fff';
  t.hidden = false; clearTimeout(t._h); t._h = setTimeout(() => (t.hidden = true), 2200);
}
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return String(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/* ---------- data ---------- */
async function refresh() {
  state.records = await loadAll(state.scope);
  const pets = state.records.filter((r) => r.type === 'pet');
  if (!pets.some((p) => p.id === state.petId)) state.petId = pets[0]?.id || 0;
  renderTabs();
  if (state.petId) { $('#empty').hidden = true; $('#dashboard').hidden = false; renderAll(); }
  else { $('#dashboard').hidden = true; $('#empty').hidden = false; }
}

function pets() { return state.records.filter((r) => r.type === 'pet'); }
function pet() { return pets().find((p) => p.id === state.petId) || {}; }
function logsFor(petId) { return state.records.filter((r) => r.type === 'log' && r.petId === petId); }
function medicalFor(petId) { return state.records.filter((r) => r.type === 'medical' && r.petId === petId); }

function renderTabs() {
  const nav = $('#petTabs');
  nav.innerHTML = '';
  for (const p of pets()) {
    const b = document.createElement('button');
    b.textContent = `${speciesEmoji(p.species)} ${p.name}`;
    b.className = p.id === state.petId ? 'on' : '';
    b.onclick = () => { state.petId = p.id; try { localStorage.setItem('peth.petId', String(p.id)); } catch {} renderTabs(); renderAll(); };
    nav.appendChild(b);
  }
  const add = document.createElement('button');
  add.textContent = '＋寵物';
  add.onclick = () => openPetSheet(0);
  nav.appendChild(add);
}

/* ---------- dashboard ---------- */
function renderAll() { renderCards(); renderUpcoming(); drawChart(); renderFeed(); }

async function renderCards() {
  const p = pet();
  const unit = p.unit || 'kg';
  const logs = logsFor(p.id);
  const series = weightSeries(logs, p.id);
  let wHtml = '—', delta = '';
  if (series.length) {
    const last = series[series.length - 1].weight;
    wHtml = `${last} ${unit}`;
    if (series.length > 1) {
      const diff = +(last - series[series.length - 2].weight).toFixed(2);
      if (diff > 0) delta = `<div class="l up">▲ +${diff}</div>`;
      else if (diff < 0) delta = `<div class="l down">▼ ${diff}</div>`;
    }
  }
  const visit = medicalFor(p.id).filter((m) => m.date).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  const sinceVet = visit ? `${daysSince(visit.date) ?? '—'} 天` : '—';
  const age = ageLabel(p.birthday);
  const face = p.photoId ? await getPhotoBlob(p.photoId) : null;
  const faceHtml = face ? `<img class="petface" src="${URL.createObjectURL(face)}" alt="">` : `<div class="v">${speciesEmoji(p.species)} ${esc(p.name)}</div>`;
  $('#statCards').innerHTML = `
    <div class="card">${faceHtml}${face ? `<div class="l">${esc(age || p.name)}（可編輯）</div>` : ''}</div>
    <div class="card"><div class="v">${wHtml}</div>${delta || '<div class="l">最近體重</div>'}</div>
    <div class="card"><div class="v">${sinceVet}</div><div class="l">距上次就診</div></div>`;
  $('#statCards').firstElementChild.onclick = () => openPetSheet(state.petId);
}

function renderUpcoming() {
  const items = medicalFor(state.petId).filter((m) => (m.nextDate && !m.done) || !m.done);
  const box = $('#upcoming');
  if (!items.length) { box.hidden = true; return; }
  box.hidden = false;
  const sorted = [...items].sort((a, b) => (a.nextDate || '9999') < (b.nextDate || '9999') ? -1 : 1);
  $('#upcomingList').innerHTML = sorted.map((m) => {
    let dueHtml = '<span class="due okk">未結</span>';
    const due = dueInfo(m.nextDate);
    if (due) {
      if (due.key === 'over') dueHtml = `<span class="due over">逾期 ${-due.days} 天（${esc(m.nextDate)}）</span>`;
      else if (due.key === 'soon') dueHtml = `<span class="due soon">${due.days === 0 ? '今天' : `${due.days} 天後`}（${esc(m.nextDate)}）</span>`;
      else dueHtml = `<span class="due okk">${esc(m.nextDate)}</span>`;
    }
    return `<div class="upitem"><b>${medTypeLabel(m.medType)} ${esc(m.title)}</b>${dueHtml}
      <button class="donext" data-done="${m.id}">標記完成</button>
      ${m.nextDate ? `<button class="donext" data-next="${m.id}">＋${m.medType === 'vaccine' || m.medType === 'surgery' ? '1年' : '1月'}</button>` : ''}
    </div>`;
  }).join('');
  $$('#upcomingList [data-done]').forEach((b) => (b.onclick = async () => {
    const m = state.records.find((r) => r.id === b.dataset.done);
    await saveRecord({ ...m, done: true, updatedAt: Date.now() }, { photoIds: Object.keys(m.photoPaths || {}), queue: true });
    await refresh(); queueSyncSoon();
  }));
  $$('#upcomingList [data-next]').forEach((b) => (b.onclick = async () => {
    const m = state.records.find((r) => r.id === b.dataset.next);
    await saveRecord({ ...m, nextDate: bumpNextDate(m.nextDate, m.medType), updatedAt: Date.now() }, { photoIds: Object.keys(m.photoPaths || {}), queue: true });
    await refresh(); queueSyncSoon();
  }));
}

function drawChart() {
  const c = $('#weightChart'), ctx = c.getContext('2d');
  const pts = weightSeries(logsFor(state.petId), state.petId);
  ctx.clearRect(0, 0, c.width, c.height);
  if (!pts.length) {
    ctx.fillStyle = '#a0703c'; ctx.font = '22px sans-serif';
    ctx.fillText('還沒有體重資料 — 記一筆有體重的紀錄就會畫曲線', 30, 130);
    return;
  }
  const W = c.width, H = c.height, padL = 60, padR = 20, padT = 24, padB = 40;
  const xs = pts.map((p) => Date.parse(p.dt));
  const ys = pts.map((p) => p.weight);
  let xmin = Math.min(...xs), xmax = Math.max(...xs);
  if (xmin === xmax) { xmin -= 86400000; xmax += 86400000; }
  let ymin = Math.min(...ys), ymax = Math.max(...ys);
  const span = ymax - ymin || Math.max(ymax * 0.1, 1);
  ymin -= span * 0.15; ymax += span * 0.15;
  const X = (t) => padL + ((t - xmin) / (xmax - xmin)) * (W - padL - padR);
  const Y = (v) => padT + (1 - (v - ymin) / (ymax - ymin)) * (H - padT - padB);
  ctx.strokeStyle = '#e6cf9a'; ctx.lineWidth = 1; ctx.fillStyle = '#a0703c'; ctx.font = '18px sans-serif';
  for (let i = 0; i <= 3; i++) {
    const v = ymin + ((ymax - ymin) * i) / 3, y = Y(v);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillText(v.toFixed(1), 8, y + 6);
  }
  ctx.beginPath();
  pts.forEach((p, i) => { const x = X(xs[i]), y = Y(ys[i]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.strokeStyle = '#e06666'; ctx.lineWidth = 3; ctx.stroke();
  ctx.fillStyle = '#e06666';
  pts.forEach((p, i) => { ctx.beginPath(); ctx.arc(X(xs[i]), Y(ys[i]), 5, 0, 7); ctx.fill(); });
  ctx.fillStyle = '#a0703c'; ctx.font = '16px sans-serif';
  ctx.fillText(String(pts[0].dt).slice(0, 10), padL, H - 12);
  const lastLabel = String(pts[pts.length - 1].dt).slice(0, 10);
  ctx.fillText(lastLabel, W - padR - ctx.measureText(lastLabel).width, H - 12);
}

/* ---------- feed ---------- */
async function renderFeed() {
  const items = [];
  for (const r of state.records) {
    if (r.petId !== state.petId) continue;
    if (r.type === 'log' || r.type === 'medical') items.push(r);
  }
  items.sort((a, b) => String(b.dt || b.date || b.createdAt) .localeCompare(String(a.dt || a.date || a.createdAt)));
  const unit = pet().unit || 'kg';
  const parts = [];
  for (const r of items) {
    const photos = await photoHtml(r);
    const foot = `<div class="efoot"><button data-delrec="${r.id}">刪除</button></div>`;
    if (r.type === 'log') {
      const tags = [];
      if (r.weight != null) tags.push(`⚖️ ${r.weight} ${unit}`);
      if (r.temp != null) tags.push(`🌡 ${r.temp}°C`);
      if (r.food) tags.push(`🍖 ${esc(r.food)}`);
      if (r.poop) tags.push(poopLabel(r.poop));
      parts.push(`<div class="entry"><div class="ehead"><span class="ekind">${kindLabel(r.kind)}</span>
        <span class="edate">${esc(fmtTime(r.dt))}</span></div>
        ${tags.length ? `<div class="etext">${tags.map((t) => `<span class="tag">${t}</span>`).join('')}</div>` : ''}
        ${r.note ? `<div class="etext">${esc(r.note)}</div>` : ''}
        ${photos}${foot}</div>`);
    } else {
      const tags = [];
      if (r.date) tags.push(`📅 ${esc(r.date)}`);
      if (r.nextDate) tags.push(`🔁 下次 ${esc(r.nextDate)}`);
      if (r.done) tags.push('<span class="donetag">✅ 已完成</span>');
      parts.push(`<div class="entry med"><div class="ehead"><span class="ekind">${medTypeLabel(r.medType)} ${esc(r.title)}</span>
        <span class="edate">${esc(fmtTime(r.createdAt))}</span></div>
        ${tags.length ? `<div class="etext">${tags.map((t) => `<span class="tag">${t}</span>`).join('')}</div>` : ''}
        ${r.note ? `<div class="etext">${esc(r.note)}</div>` : ''}
        ${photos}
        <div class="efoot">
          <button data-meddone="${r.id}" data-v="${r.done ? 1 : 0}">${r.done ? '標為未完成' : '標記完成'}</button>
          <button data-delrec="${r.id}">刪除</button></div></div>`);
    }
  }
  $('#feed').innerHTML = parts.join('') || '<div class="empty">目前沒有紀錄</div>';

  $$('#feed [data-delrec]').forEach((b) => (b.onclick = async () => {
    if (!confirm('刪掉這筆紀錄？家人那邊也會跟著刪。')) return;
    await deleteRecord(b.dataset.delrec, { queue: true });
    toast('已刪除', 'var(--red)');
    await refresh(); queueSyncSoon();
  }));
  $$('#feed [data-meddone]').forEach((b) => (b.onclick = async () => {
    const r = state.records.find((x) => x.id === b.dataset.meddone);
    await saveRecord({ ...r, done: !r.done, updatedAt: Date.now() }, { photoIds: Object.keys(r.photoPaths || {}), queue: true });
    await refresh(); queueSyncSoon();
  }));
}

async function photoHtml(record) {
  const ids = Object.keys(record.photoPaths || {});
  if (!ids.length) return '';
  const cells = [];
  for (const photoId of ids) {
    const blob = await getPhotoBlob(photoId);
    if (blob) cells.push(`<img src="${URL.createObjectURL(blob)}" onclick="openLightbox(this.src)" alt="">`);
    else cells.push('<span class="missing">🖼 照片尚未下載</span>');
  }
  return `<div class="ephotos">${cells.join('')}</div>`;
}
window.openLightbox = (src) => { $('#lightboxImg').src = src; $('#lightbox').hidden = false; };
$('#lightbox').onclick = () => ($('#lightbox').hidden = true);

/* ---------- sheets ---------- */
function openSheet(id) {
  $$('.sheet').forEach((s) => (s.hidden = true));
  $('#sheetBack').hidden = false;
  $(id).hidden = false;
}
function closeSheets() {
  $$('.sheet').forEach((s) => (s.hidden = true));
  $('#sheetBack').hidden = true;
}
$('#sheetBack').onclick = closeSheets;
$$('.sheet .cancel').forEach((b) => (b.onclick = closeSheets));

function chipGrid(container, list, cur, onPick) {
  container.innerHTML = '';
  for (const it of list) {
    const b = document.createElement('button');
    b.textContent = it.label;
    b.className = it.id === cur ? 'on' : '';
    b.onclick = () => { onPick(it.id); chipGrid(container, list, it.id, onPick); };
    container.appendChild(b);
  }
}

/* photo staging (compress immediately, hold blobs, flush on save) */
async function handlePicked(input, thumbsEl, store, { single = false } = {}) {
  for (const file of Array.from(input.files || [])) {
    if (single && store.length) store.length = 0;
    const item = { photoId: newId(), blob: null, status: 'processing', url: URL.createObjectURL(file) };
    store.push(item);
    renderThumbs(thumbsEl, store);
    const blob = await compressImage(file);
    if (blob) { item.blob = blob; item.url = URL.createObjectURL(blob); item.status = 'ready'; }
    else item.status = 'fail';
    renderThumbs(thumbsEl, store);
  }
  input.value = '';
}
function renderThumbs(thumbsEl, store) {
  thumbsEl.innerHTML = '';
  store.forEach((item, i) => {
    const div = document.createElement('div');
    div.className = 'th';
    div.innerHTML = `<img src="${item.url}" alt="">${item.status === 'processing' ? '<div class="st">處理中</div>' : item.status === 'fail' ? '<div class="st" style="color:#f87171">失敗</div>' : ''}<button class="x">×</button>`;
    div.querySelector('.x').onclick = () => { store.splice(i, 1); renderThumbs(thumbsEl, store); };
    thumbsEl.appendChild(div);
  });
}
function stagedPhotoIds(store) {
  return store.filter((p) => p.status === 'ready').map((p) => p.photoId);
}
async function flushPhotos(store) {
  for (const item of store) {
    if (item.status === 'ready' && item.blob) await putPhoto(item.photoId, item.blob);
  }
}

/* existing photos kept when editing a record: extra photoIds passed in */
function mergedPhotoIds(store, keepIds = []) {
  return [...keepIds, ...stagedPhotoIds(store)];
}

/* daily sheet */
function openDaily() {
  state.kind = 'daily'; state.poop = ''; state.dailyPhotos = [];
  $('#dWeight').value = ''; $('#dTemp').value = ''; $('#dFood').value = '';
  $('#dNote').value = ''; $('#dThumbs').innerHTML = '';
  chipGrid($('#kindGrid'), KINDS, state.kind, (k) => (state.kind = k));
  chipGrid($('#poopGrid'), POOPS.map((p) => ({ id: p.v, label: p.label })), state.poop, (p) => (state.poop = p));
  openSheet('#sheetDaily');
  setTimeout(() => $('#dWeight').focus(), 100);
}
$('#btnAddDaily').onclick = openDaily;
$('#dPhotos').onchange = (e) => handlePicked(e.target, $('#dThumbs'), state.dailyPhotos);
$('#dSave').onclick = async () => {
  if (state.dailyPhotos.some((p) => p.status === 'processing')) { toast('照片處理中，稍候', 'var(--amber)'); return; }
  const petId = state.petId;
  if (!petId) { toast('先建立寵物', 'var(--amber)'); return; }
  await flushPhotos(state.dailyPhotos);
  const photoPaths = Object.fromEntries(stagedPhotoIds(state.dailyPhotos).map((id) => [id, null]));
  const record = makeLog({ petId, kind: state.kind, weight: $('#dWeight').value, temp: $('#dTemp').value, food: $('#dFood').value, poop: state.poop, note: $('#dNote').value, dt: new Date().toISOString(), householdId: state.scope, photoPaths });
  await saveRecord(record, { photoIds: Object.keys(photoPaths), queue: true });
  closeSheets(); toast('已存入 ✅');
  await refresh(); queueSyncSoon();
};

/* medical sheet */
function openMedical() {
  state.medType = 'vaccine'; state.medPhotos = [];
  $('#mTitle').value = ''; $('#mDate').value = todayStr(); $('#mNext').value = '';
  $('#mDone').checked = false; $('#mNote').value = ''; $('#mThumbs').innerHTML = '';
  chipGrid($('#medTypeGrid'), MEDTYPES, state.medType, (t) => (state.medType = t));
  openSheet('#sheetMedical');
  setTimeout(() => $('#mTitle').focus(), 100);
}
$('#btnAddMedical').onclick = openMedical;
$('#mPhotos').onchange = (e) => handlePicked(e.target, $('#mThumbs'), state.medPhotos);
$('#mSave').onclick = async () => {
  if (!$('#mTitle').value.trim()) { toast('請填標題', 'var(--amber)'); return; }
  if (state.medPhotos.some((p) => p.status === 'processing')) { toast('照片處理中，稍候', 'var(--amber)'); return; }
  if (!state.petId) { toast('先建立寵物', 'var(--amber)'); return; }
  await flushPhotos(state.medPhotos);
  const photoPaths = Object.fromEntries(stagedPhotoIds(state.medPhotos).map((id) => [id, null]));
  const record = makeMedical({ petId: state.petId, medType: state.medType, title: $('#mTitle').value, date: $('#mDate').value, nextDate: $('#mNext').value, done: $('#mDone').checked, note: $('#mNote').value, householdId: state.scope, photoPaths });
  await saveRecord(record, { photoIds: Object.keys(photoPaths), queue: true });
  closeSheets(); toast('已存入 ✅');
  await refresh(); queueSyncSoon();
};

/* pet sheet */
function openPetSheet(editId) {
  state.editPetId = editId || 0;
  const p = editId ? pets().find((x) => x.id === editId) : null;
  state.petPhoto = [];
  state.keepPetPhotoIds = p?.photoId ? [p.photoId] : [];
  $('#petSheetTitle').textContent = p ? `編輯 ${p.name}` : '＋ 新增寵物';
  state.species = p?.species || 'dog';
  $('#pName').value = p?.name || '';
  $('#pBirthday').value = p?.birthday || '';
  $('#pUnit').value = UNITS.includes(p?.unit) ? p.unit : 'kg';
  $('#pNote').value = p?.note || '';
  $('#pDelete').hidden = !p;
  $('#pThumbs').innerHTML = '';
  if (p?.photoId) {
    getPhotoBlob(p.photoId).then((blob) => {
      if (!blob) return;
      state.petPhoto.push({ photoId: p.photoId, blob, status: 'ready', url: URL.createObjectURL(blob) });
      renderThumbs($('#pThumbs'), state.petPhoto);
    });
  }
  chipGrid($('#speciesGrid'), SPECIES, state.species, (s) => (state.species = s));
  openSheet('#sheetPet');
}
$('#pPhoto').onchange = async (e) => {
  state.keepPetPhotoIds = [];
  state.petPhoto = [];
  await handlePicked(e.target, $('#pThumbs'), state.petPhoto, { single: true });
};
$('#pDelete').onclick = async () => {
  if (!confirm(`刪除 ${pet().name} 和他所有紀錄？照片也會一起刪，家人那邊會跟著刪，無法復原！`)) return;
  const doomed = [pet().id, ...logsFor(pet().id).map((r) => r.id), ...medicalFor(pet().id).map((r) => r.id)];
  for (const id of doomed) await deleteRecord(id, { queue: true });
  state.petId = 0;
  closeSheets();
  await refresh(); queueSyncSoon();
};
$('#pSave').onclick = async () => {
  if (!$('#pName').value.trim()) { toast('請填名字', 'var(--amber)'); return; }
  if (state.petPhoto.some((p) => p.status === 'processing')) { toast('照片處理中，稍候', 'var(--amber)'); return; }
  await flushPhotos(state.petPhoto);
  const existing = state.editPetId ? pets().find((x) => x.id === state.editPetId) : null;
  const photoId = state.petPhoto[0]?.photoId || null;
  const photoPaths = photoId ? { [photoId]: state.petPhoto[0].remoteFileId || (existing?.photoPaths || {})[photoId] || null } : {};
  const record = makePet({
    id: state.editPetId || undefined,
    name: $('#pName').value, species: state.species, birthday: $('#pBirthday').value,
    unit: $('#pUnit').value, note: $('#pNote').value, householdId: state.scope, photoPaths,
    createdAt: existing?.createdAt, remoteFileId: existing?.remoteFileId,
  });
  await saveRecord(record, { photoIds: Object.keys(photoPaths), queue: true });
  closeSheets(); toast('已存入 ✅');
  await refresh(); queueSyncSoon();
};

/* ---------- settings / sync ---------- */
function paintStatus() {
  state.status = statusSnapshot();
  const pill = $('#syncPill');
  pill.textContent = state.status.label;
  pill.className = `pill ${state.status.key}`;
}

let syncTimer = 0;
function queueSyncSoon() {
  if (!state.status?.household) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => runSync(), 1200);
}

function renderSettings() {
  const st = state.status || statusSnapshot();
  const panel = $('#syncPanel');
  const parts = [];
  parts.push(`<div class="muted">${st.configured ? '家人同步：每人用<span style="color:var(--text)">自己的 Google 帳號</span>，共用地同一個雲端硬碟資料夾，資料自動同步（含照片）。' : '這個建置沒有 Google 登入設定，資料只留在這台裝置。'}</div>`);
  if (st.configured) {
    if (!st.user) {
      parts.push(`<div class="syncbox"><div class="row"><button id="sLogin" class="primary">使用 Google 登入</button></div>
        <div class="muted">登入後可選一個共用資料夾，和家人共同編輯同一份寵物資料。</div></div>`);
    } else {
      parts.push(`<div class="syncbox">
        <div class="row"><b>${esc(st.user.displayName || st.user.email)}</b><span class="tag">${st.household ? esc(st.household.name) : '尚未選資料夾'}</span><button id="sSync">立即同步</button></div>`);
      if (!st.household) {
        parts.push(`<div class="row"><input id="sFolderName" placeholder="資料夾名稱（例：我們的寵物）"><button id="sCreate" class="primary">建立共用資料夾</button></div>
          <div class="row"><input id="sJoinLink" placeholder="或貼家人分享的 Drive 資料夾連結"><button id="sJoin">加入</button></div>`);
      } else {
        parts.push(`<div class="row"><button id="sMembers">成員與分享</button><button id="sCopyLink">複製資料夾連結</button></div>`);
      }
      parts.push(`<div class="row"><button id="sLogout">登出 Google</button></div>`);
      parts.push('</div>');
    }
  }
  panel.innerHTML = parts.join('');

  const bind = (id, fn) => { const el = $(`#${id}`); if (el) el.onclick = fn; };
  bind('sLogin', async () => {
    try { await googleSignIn(); renderSettings(); runSync(); } catch (e) { toast(String(e.message || e), 'var(--red)'); }
  });
  bind('sLogout', async () => { await googleSignOut(); state.scope = null; renderSettings(); refresh(); });
  bind('sSync', async () => { const msg = await runSync(); if (msg) toast(msg, msg === '已同步' ? undefined : 'var(--red)'); });
  bind('sCreate', async () => {
    try {
      await createFolder($('#sFolderName').value || '寵物健康');
      state.scope = statusSnapshot().household?.id || null;
      renderSettings(); refresh();
      toast('共用資料夾已建立 ✅');
    } catch (e) { toast(String(e.message || e), 'var(--red)'); }
  });
  bind('sJoin', async () => {
    try {
      await joinFolder($('#sJoinLink').value);
      state.scope = statusSnapshot().household?.id || null;
      renderSettings(); refresh();
      toast('已加入共用資料夾 ✅');
    } catch (e) { toast(String(e.message || e), 'var(--red)'); }
  });
  bind('sCopyLink', async () => {
    const link = currentFolderLink();
    if (!link) return;
    try { await navigator.clipboard.writeText(link); toast('連結已複製，傳給家人即可'); } catch { prompt('複製這個連結：', link); }
  });
  bind('sMembers', async () => {
    try {
      const { members, folderLink } = await listMembers();
      const list = members.map((m) => `<div class="member">👤 ${esc(m.name)} <span class="tag">${m.role === 'owner' ? '擁有者' : '可編輯'}</span>${m.self ? '<span class="tag">你</span>' : ''}</div>`).join('');
      panel.insertAdjacentHTML('beforeend', `<div class="syncbox"><b>共同編輯的家人</b>${list || '<span class="muted">只有你</span>'}
        <div class="muted">把連結分享給家人，請他用 Google 帳號開啟並選同一個資料夾：</div>
        <div class="row"><input value="${esc(folderLink)}" readonly><button id="sCopyLink2">複製</button></div>
        <div class="row"><input id="sInviteEmail" type="email" placeholder="家人 Google email"><button id="sInvite">直接邀他編輯</button></div></div>`);
      $('#sCopyLink2').onclick = async () => { try { await navigator.clipboard.writeText(folderLink); toast('已複製'); } catch {} };
      $('#sInvite').onclick = async () => {
        try { await inviteMember($('#sInviteEmail').value); toast('已邀請，他開連結即可'); } catch (e) { toast(String(e.message || e), 'var(--red)'); }
      };
    } catch (e) { toast(String(e.message || e), 'var(--red)'); }
  });
}
$('#btnSettings').onclick = () => { renderSettings(); openSheet('#sheetSettings'); };
$('#syncPill').onclick = () => {
  const st = state.status || statusSnapshot();
  if (st.key === 'login' || st.key === 'folder' || !st.household) { renderSettings(); openSheet('#sheetSettings'); }
  else runSync().then((msg) => msg && toast(msg, msg === '已同步' ? undefined : 'var(--red)'));
};

/* ---------- boot ---------- */
export function startApp() {
  initSession({
    onStatusChange: (st) => { state.status = st; paintStatus(); },
    onSynced: () => { if (state.scope) refresh(); },
  });
  paintStatus();
  (async () => {
    if (driveConfigured()) {
      const restored = await restoreSilent();
      if (restored) setHouseholdFromStorage();
      const st = statusSnapshot();
      if (st.household) { state.scope = st.household.id; }
    }
    await refresh();
    if (state.scope) runSync();
  })();
  window.addEventListener('online', () => { paintStatus(); if (state.scope) runSync(); });
  window.addEventListener('offline', paintStatus);
}
