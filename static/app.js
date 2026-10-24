"use strict";
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const KINDS = [
  { id: "daily", label: "📝 一般" },
  { id: "weight", label: "⚖️ 體重" },
  { id: "food", label: "🍖 飲食" },
  { id: "poop", label: "💩 排便" },
  { id: "symptom", label: "🤒 症狀" },
  { id: "activity", label: "🏃 活動" },
];
const POOPS = [
  { v: "dry", label: "🟤硬" }, { v: "nice", label: "💩正常" },
  { v: "soft", label: "🟡软" }, { v: "loose", label: "💧稀" }, { v: "none", label: "🚫沒有" },
];
const MEDTYPES = [
  { id: "vaccine", label: "💉 疫苗" }, { id: "med", label: "💊 用藥" },
  { id: "visit", label: "🏥 就診" }, { id: "deworm", label: "🪱 驅蟲" },
  { id: "surgery", label: "🔪 手術" }, { id: "other", label: "📌 其他" },
];
const SPECIES = [
  { id: "dog", label: "🐶 狗" }, { id: "cat", label: "🐱 貓" },
  { id: "rabbit", label: "🐰 兔" }, { id: "bird", label: "🐦 鳥" },
  { id: "other", label: "🐾 其他" },
];
const POOP_LABEL = Object.fromEntries(POOPS.map(p => [p.v, p.label]));
const MEDTYPE_LABEL = Object.fromEntries(MEDTYPES.map(t => [t.id, t.label]));
const KIND_LABEL = Object.fromEntries(KINDS.map(k => [k.id, k.label]));

const state = {
  pets: [], petId: +(localStorage.getItem("petId") || 0),
  logs: [], medical: [], photos: [],
  dailyPhotos: [], medPhotos: [],
  kind: "daily", poop: "", medType: "vaccine", species: "dog", editPetId: 0,
};

function today() { return new Date().toLocaleDateString("sv"); }
function nowTime() {
  const d = new Date();
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function toast(msg, color) {
  const t = $("#toast");
  t.textContent = msg; t.style.background = color || "var(--green)";
  t.hidden = false; clearTimeout(t._h); t._h = setTimeout(() => (t.hidden = true), 2200);
}
async function api(path, opts) {
  const res = await fetch(path, opts);
  const obj = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(obj.error || res.status);
  return obj;
}
function formBody(obj) {
  return Object.entries(obj).map(([k, v]) =>
    encodeURIComponent(k) + "=" + encodeURIComponent(v ?? "")).join("&");
}

/* ---------- pets ---------- */
async function loadPets() {
  state.pets = await api("/api/pets");
  if (!state.pets.some(p => p.id === state.petId)) state.petId = state.pets[0]?.id || 0;
  renderTabs();
  if (state.petId) await loadPetData();
  else { $("#dashboard").hidden = true; $("#empty").hidden = false; }
}
function renderTabs() {
  const nav = $("#petTabs");
  nav.innerHTML = "";
  for (const p of state.pets) {
    const b = document.createElement("button");
    b.textContent = (p.species === "dog" ? "🐶 " : p.species === "cat" ? "🐱 " : p.species === "rabbit" ? "🐰 " : p.species === "bird" ? "🐦 " : "🐾 ") + p.name;
    b.className = p.id === state.petId ? "on" : "";
    b.onclick = () => { state.petId = p.id; localStorage.setItem("petId", p.id); renderTabs(); loadPetData(); };
    nav.appendChild(b);
  }
}
async function loadPetData() {
  const d = await api("/api/pets/" + state.petId + "/logs");
  state.logs = d.logs; state.medical = d.medical; state.photos = d.photos;
  $("#empty").hidden = true; $("#dashboard").hidden = false;
  renderAll();
}
function pet() { return state.pets.find(p => p.id === state.petId) || {}; }
function photosOf(kind, id) {
  return state.photos.filter(p => (kind === "log" ? p.log_id : p.med_id) === id);
}

/* ---------- dashboard ---------- */
function renderAll() { renderCards(); renderUpcoming(); drawChart(); renderFeed(); }

function renderCards() {
  const unit = pet().unit || "kg";
  const wl = state.logs.filter(l => l.weight != null).sort((a, b) => a.dt < b.dt ? -1 : 1);
  let wHtml = "—", delta = "";
  if (wl.length) {
    const last = wl[wl.length - 1].weight;
    wHtml = last + " " + unit;
    if (wl.length > 1) {
      const diff = +(last - wl[wl.length - 2].weight).toFixed(2);
      if (diff > 0) delta = `<div class="l up">▲ +${diff}</div>`;
      else if (diff < 0) delta = `<div class="l down">▼ ${diff}</div>`;
    }
  }
  const visit = state.medical.filter(m => m.type === "visit" && m.date).sort((a, b) => a.date < b.date ? 1 : -1)[0];
  let sinceVet = "—";
  if (visit) {
    const days = Math.floor((Date.now() - new Date(visit.date)) / 86400000);
    sinceVet = days + " 天";
  }
  const bday = pet().birthday;
  let age = pet().name || "";
  if (bday) {
    const days = Math.floor((Date.now() - new Date(bday)) / 86400000);
    age = days >= 365 ? Math.floor(days / 365) + " 歲" : days + " 天";
  }
  $("#statCards").innerHTML = `
    <div class="card"><div class="v">${esc(age)}</div><div class="l">${esc(pet().name)}（點名字可編輯）</div></div>
    <div class="card"><div class="v">${wHtml}</div>${delta || '<div class="l">最近體重</div>'}</div>
    <div class="card"><div class="v">${sinceVet}</div><div class="l">距上次就診</div></div>`;
  $("#statCards").firstElementChild.style.cursor = "pointer";
  $("#statCards").firstElementChild.onclick = () => openPetSheet(state.petId);
}

function renderUpcoming() {
  const items = state.medical.filter(m => (m.next_date && !m.done) || !m.done);
  const box = $("#upcoming");
  if (!items.length) { box.hidden = true; return; }
  box.hidden = false;
  const todayStr = today();
  const sorted = [...items].sort((a, b) => (a.next_date || "9999") < (b.next_date || "9999") ? -1 : 1);
  $("#upcomingList").innerHTML = sorted.map(m => {
    let dueHtml = '<span class="due okk">未結</span>';
    if (m.next_date) {
      const days = Math.round((new Date(m.next_date) - new Date(todayStr)) / 86400000);
      if (days < 0) dueHtml = `<span class="due over">逾期 ${-days} 天（${esc(m.next_date)}）</span>`;
      else if (days <= 7) dueHtml = `<span class="due soon">${days === 0 ? "今天" : days + " 天後"}（${esc(m.next_date)}）</span>`;
      else dueHtml = `<span class="due okk">${esc(m.next_date)}</span>`;
    }
    return `<div class="upitem"><b>${MEDTYPE_LABEL[m.type] || "📌"} ${esc(m.title)}</b>${dueHtml}
      <button class="donext" data-done="${m.id}">標記完成</button>
      ${m.next_date ? `<button class="donext" data-next="${m.id}">＋${esc(m.type === "vaccine" ? "1年" : "1月")}</button>` : ""}
    </div>`;
  }).join("");
  $$("#upcomingList [data-done]").forEach(b => b.onclick = async () => {
    await api("/api/medical/" + b.dataset.done, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ done: true }) });
    loadPetData();
  });
  $$("#upcomingList [data-next]").forEach(b => b.onclick = async () => {
    const m = state.medical.find(x => x.id === +b.dataset.next);
    const d = new Date(m.next_date);
    if (m.type === "vaccine") d.setFullYear(d.getFullYear() + 1); else d.setMonth(d.getMonth() + 1);
    await api("/api/medical/" + m.id, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ next_date: d.toLocaleDateString("sv") }) });
    loadPetData();
  });
}

function drawChart() {
  const c = $("#weightChart"), ctx = c.getContext("2d");
  const pts = state.logs.filter(l => l.weight != null).sort((a, b) => a.dt < b.dt ? -1 : 1);
  ctx.clearRect(0, 0, c.width, c.height);
  if (pts.length < 1) {
    ctx.fillStyle = "#94a3b8"; ctx.font = "22px sans-serif";
    ctx.fillText("还没有体重资料 — 记一笔有体重的纪录就会画曲线", 30, 130);
    return;
  }
  const W = c.width, H = c.height, padL = 60, padR = 20, padT = 24, padB = 40;
  const xs = pts.map(p => new Date(p.dt).getTime());
  const ys = pts.map(p => p.weight);
  let xmin = Math.min(...xs), xmax = Math.max(...xs);
  if (xmin === xmax) { xmin -= 86400000; xmax += 86400000; }
  let ymin = Math.min(...ys), ymax = Math.max(...ys);
  const span = (ymax - ymin) || Math.max(ymax * 0.1, 1);
  ymin -= span * 0.15; ymax += span * 0.15;
  const X = t => padL + (t - xmin) / (xmax - xmin) * (W - padL - padR);
  const Y = v => padT + (1 - (v - ymin) / (ymax - ymin)) * (H - padT - padB);
  ctx.strokeStyle = "#334155"; ctx.lineWidth = 1; ctx.fillStyle = "#94a3b8"; ctx.font = "18px sans-serif";
  for (let i = 0; i <= 3; i++) {
    const v = ymin + (ymax - ymin) * i / 3, y = Y(v);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillText(v.toFixed(1), 8, y + 6);
  }
  ctx.beginPath();
  pts.forEach((p, i) => { const x = X(xs[i]), y = Y(ys[i]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.strokeStyle = "#10b981"; ctx.lineWidth = 3; ctx.stroke();
  ctx.fillStyle = "#10b981";
  pts.forEach((p, i) => { ctx.beginPath(); ctx.arc(X(xs[i]), Y(ys[i]), 5, 0, 7); ctx.fill(); });
  ctx.fillStyle = "#94a3b8"; ctx.font = "16px sans-serif";
  ctx.fillText(pts[0].dt.slice(0, 10), padL, H - 12);
  const lastLabel = pts[pts.length - 1].dt.slice(0, 10);
  ctx.fillText(lastLabel, W - padR - ctx.measureText(lastLabel).width, H - 12);
}

/* ---------- feed ---------- */
function renderFeed() {
  const items = [];
  for (const l of state.logs) items.push({ ts: l.dt, kind: "log", o: l });
  for (const m of state.medical) items.push({ ts: (m.date || m.created_at || "") + " ", kind: "med", o: m });
  items.sort((a, b) => a.ts < b.ts ? 1 : -1);
  const unit = pet().unit || "kg";
  $("#feed").innerHTML = items.map(it => {
    if (it.kind === "log") {
      const l = it.o;
      const tags = [];
      if (l.weight != null) tags.push(`⚖️ ${l.weight} ${unit}`);
      if (l.temp != null) tags.push(`🌡 ${l.temp}°C`);
      if (l.food) tags.push(`🍖 ${esc(l.food)}`);
      if (l.poop) tags.push(POOP_LABEL[l.poop] || l.poop);
      const ph = photosOf("log", l.id).map(p =>
        `<img src="/photos/${l.pet_id}/${p.id}" onclick="openLightbox(this.src)">`).join("");
      return `<div class="entry"><div class="ehead"><span class="ekind">${KIND_LABEL[l.kind] || l.kind}</span>
        <span class="edate">${esc(l.dt)}</span></div>
        ${tags.length ? `<div class="etext">${tags.map(t => `<span class="tag">${t}</span>`).join("")}</div>` : ""}
        ${l.note ? `<div class="etext">${esc(l.note)}</div>` : ""}
        ${ph ? `<div class="ephotos">${ph}</div>` : ""}
        <div class="efoot"><button data-dellog="${l.id}">刪除</button></div></div>`;
    }
    const m = it.o;
    const ph = photosOf("med", m.id).map(p =>
      `<img src="/photos/${m.pet_id}/${p.id}" onclick="openLightbox(this.src)">`).join("");
    const tags = [];
    if (m.date) tags.push(`📅 ${esc(m.date)}`);
    if (m.next_date) tags.push(`🔁 下次 ${esc(m.next_date)}`);
    if (m.done) tags.push(`<span class="donetag">✅ 已完成</span>`);
    return `<div class="entry med"><div class="ehead"><span class="ekind">${MEDTYPE_LABEL[m.type] || m.type} ${esc(m.title)}</span>
      <span class="edate">${esc(m.created_at || "")}</span></div>
      ${tags.length ? `<div class="etext">${tags.map(t => `<span class="tag">${t}</span>`).join("")}</div>` : ""}
      ${m.note ? `<div class="etext">${esc(m.note)}</div>` : ""}
      ${ph ? `<div class="ephotos">${ph}</div>` : ""}
      <div class="efoot">
        <button data-meddone="${m.id}" data-v="${m.done ? 0 : 1}">${m.done ? "標為未完成" : "標記完成"}</button>
        <button data-delmed="${m.id}">刪除</button></div></div>`;
  }).join("") || '<div class="empty">目前沒有紀錄</div>';

  $$("#feed [data-dellog]").forEach(b => b.onclick = async () => {
    if (!confirm("刪掉這筆紀錄？")) return;
    await api("/api/logs/" + b.dataset.dellog, { method: "DELETE" });
    toast("已刪除", "var(--red)"); loadPetData();
  });
  $$("#feed [data-delmed]").forEach(b => b.onclick = async () => {
    if (!confirm("刪掉這筆醫療紀錄？")) return;
    await api("/api/medical/" + b.dataset.delmed, { method: "DELETE" });
    toast("已刪除", "var(--red)"); loadPetData();
  });
  $$("#feed [data-meddone]").forEach(b => b.onclick = async () => {
    await api("/api/medical/" + b.dataset.meddone, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ done: !+b.dataset.v }) });
    loadPetData();
  });
}
window.openLightbox = (src) => { $("#lightboxImg").src = src; $("#lightbox").hidden = false; };
$("#lightbox").onclick = () => ($("#lightbox").hidden = true);

/* ---------- sheets ---------- */
function openSheet(id) {
  $$(".sheet").forEach(s => (s.hidden = true));
  $("#sheetBack").hidden = false; $(id).hidden = false;
}
function closeSheets() {
  $$(".sheet").forEach(s => (s.hidden = true));
  $("#sheetBack").hidden = true;
}
$("#sheetBack").onclick = closeSheets;
$$(".sheet .cancel").forEach(b => (b.onclick = closeSheets));

function chipGrid(container, list, cur, onPick) {
  container.innerHTML = "";
  for (const it of list) {
    const b = document.createElement("button");
    b.textContent = it.label;
    b.className = it.id === cur ? "on" : "";
    b.onclick = () => { onPick(it.id); chipGrid(container, list, it.id, onPick); };
    container.appendChild(b);
  }
}

/* daily sheet */
function openDaily() {
  state.kind = "daily"; state.poop = ""; state.dailyPhotos = [];
  $("#dWeight").value = ""; $("#dTemp").value = ""; $("#dFood").value = "";
  $("#dNote").value = ""; $("#dPhotos").value = ""; $("#dThumbs").innerHTML = "";
  chipGrid($("#kindGrid"), KINDS, state.kind, k => (state.kind = k));
  chipGrid($("#poopGrid"), POOPS.map(p => ({ id: p.v, label: p.label })), state.poop, p => (state.poop = p));
  openSheet("#sheetDaily");
  setTimeout(() => $("#dWeight").focus(), 100);
}
$("#btnAddDaily").onclick = openDaily;
$("#dPhotos").onchange = () => handlePhotos($("#dPhotos"), $("#dThumbs"), state.dailyPhotos, "d");

function handlePhotos(input, thumbsEl, store, prefix) {
  for (const f of Array.from(input.files || [])) {
    const item = { file: f, id: 0, status: "uploading" };
    store.push(item);
    const ext = (f.name.split(".").pop() || "").toLowerCase();
    fetch("/api/upload?pet=" + state.petId + "&name=" + encodeURIComponent(f.name),
      { method: "PUT", headers: { "Content-Type": f.type || "application/octet-stream" }, body: f })
      .then(r => r.json()).then(o => {
        item.id = o.id || 0; item.status = o.id ? "done" : "fail";
        renderThumbs(thumbsEl, store);
      }).catch(() => { item.status = "fail"; renderThumbs(thumbsEl, store); });
  }
  input.value = "";
  renderThumbs(thumbsEl, store);
}
function renderThumbs(thumbsEl, store) {
  thumbsEl.innerHTML = "";
  store.forEach((item, i) => {
    const div = document.createElement("div");
    div.className = "th";
    const url = URL.createObjectURL(item.file);
    div.innerHTML = `<img src="${url}">${item.status === "uploading" ? '<div class="st">上傳中</div>' : item.status === "fail" ? '<div class="st" style="color:#f87171">失敗</div>' : ""}<button class="x">×</button>`;
    div.querySelector(".x").onclick = () => { store.splice(i, 1); renderThumbs(thumbsEl, store); };
    thumbsEl.appendChild(div);
  });
}
$("#dSave").onclick = async () => {
  const uploading = state.dailyPhotos.some(p => p.status === "uploading");
  if (uploading) { toast("照片還在上傳，稍候", "var(--amber)"); return; }
  try {
    await api("/api/pets/" + state.petId + "/logs", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({
        kind: state.kind, weight: $("#dWeight").value, temp: $("#dTemp").value,
        food: $("#dFood").value, poop: state.poop, note: $("#dNote").value,
        date: today(), time: nowTime(),
        photo_ids: state.dailyPhotos.filter(p => p.id).map(p => p.id).join(","),
      }),
    });
    closeSheets(); toast("已存入 ✅"); loadPetData();
  } catch (e) { toast("存檔失敗：" + e.message, "var(--red)"); }
};

/* medical sheet */
function openMedical() {
  state.medType = "vaccine"; state.medPhotos = [];
  $("#mTitle").value = ""; $("#mDate").value = today(); $("#mNext").value = "";
  $("#mDone").checked = false; $("#mNote").value = ""; $("#mPhotos").value = ""; $("#mThumbs").innerHTML = "";
  chipGrid($("#medTypeGrid"), MEDTYPES, state.medType, t => (state.medType = t));
  openSheet("#sheetMedical");
  setTimeout(() => $("#mTitle").focus(), 100);
}
$("#btnAddMedical").onclick = openMedical;
$("#mPhotos").onchange = () => handlePhotos($("#mPhotos"), $("#mThumbs"), state.medPhotos, "m");
$("#mSave").onclick = async () => {
  if (!$("#mTitle").value.trim()) { toast("請填標題", "var(--amber)"); return; }
  const uploading = state.medPhotos.some(p => p.status === "uploading");
  if (uploading) { toast("照片還在上傳，稍候", "var(--amber)"); return; }
  try {
    await api("/api/pets/" + state.petId + "/medical", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({
        type: state.medType, title: $("#mTitle").value, date: $("#mDate").value,
        next_date: $("#mNext").value, done: $("#mDone").checked ? "1" : "0", note: $("#mNote").value,
        photo_ids: state.medPhotos.filter(p => p.id).map(p => p.id).join(","),
      }),
    });
    closeSheets(); toast("已存入 ✅"); loadPetData();
  } catch (e) { toast("存檔失敗：" + e.message, "var(--red)"); }
};

/* pet sheet */
function openPetSheet(editId) {
  state.editPetId = editId || 0;
  const p = editId ? state.pets.find(x => x.id === editId) : null;
  $("#petSheetTitle").textContent = p ? "編輯 " + p.name : "＋ 新增寵物";
  state.species = p?.species || "dog";
  $("#pName").value = p?.name || "";
  $("#pBirthday").value = p?.birthday || "";
  $("#pUnit").value = p?.unit || "kg";
  $("#pNote").value = p?.note || "";
  $("#pDelete").hidden = !p;
  chipGrid($("#speciesGrid"), SPECIES, state.species, s => (state.species = s));
  openSheet("#sheetPet");
}
$("#btnAddPet").onclick = () => openPetSheet(0);
$("#pDelete").onclick = async () => {
  if (!confirm(`刪除 ${pet().name} 和他所有紀錄？照片也會一起刪，無法復原！`)) return;
  await api("/api/pets/" + state.editPetId, { method: "DELETE" });
  state.petId = 0; closeSheets(); loadPets();
};
$("#pSave").onclick = async () => {
  if (!$("#pName").value.trim()) { toast("請填名字", "var(--amber)"); return; }
  const body = JSON.stringify({
    name: $("#pName").value.trim(), species: state.species,
    birthday: $("#pBirthday").value, unit: $("#pUnit").value, note: $("#pNote").value,
  });
  try {
    if (state.editPetId) {
      await api("/api/pets/" + state.editPetId, { method: "PATCH", headers: { "Content-Type": "application/json" }, body });
    } else {
      await api("/api/pets", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: formBody(JSON.parse(body)) });
    }
    closeSheets(); toast("已存入 ✅"); loadPets();
  } catch (e) { toast("存檔失敗：" + e.message, "var(--red)"); }
};

loadPets();
