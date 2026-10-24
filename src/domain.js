export const KINDS = [
  { id: 'daily', label: '📝 一般' },
  { id: 'weight', label: '⚖️ 體重' },
  { id: 'food', label: '🍖 飲食' },
  { id: 'poop', label: '💩 排便' },
  { id: 'symptom', label: '🤒 症狀' },
  { id: 'activity', label: '🏃 活動' },
];

export const POOPS = [
  { v: 'dry', label: '🟤 硬' },
  { v: 'nice', label: '💩 正常' },
  { v: 'soft', label: '🟡 軟' },
  { v: 'loose', label: '💧 稀' },
  { v: 'none', label: '🚫 沒有' },
];

export const MEDTYPES = [
  { id: 'vaccine', label: '💉 疫苗' },
  { id: 'med', label: '💊 用藥' },
  { id: 'visit', label: '🏥 就診' },
  { id: 'deworm', label: '🪱 驅蟲' },
  { id: 'surgery', label: '🔪 手術' },
  { id: 'other', label: '📌 其他' },
];

export const SPECIES = [
  { id: 'dog', label: '🐶 狗' },
  { id: 'cat', label: '🐱 貓' },
  { id: 'rabbit', label: '🐰 兔' },
  { id: 'bird', label: '🐦 鳥' },
  { id: 'other', label: '🐾 其他' },
];

export const UNITS = ['kg', 'g', 'lb'];

const KIND_LABEL = Object.fromEntries(KINDS.map((k) => [k.id, k.label]));
const POOP_LABEL = Object.fromEntries(POOPS.map((p) => [p.v, p.label]));
const MEDTYPE_LABEL = Object.fromEntries(MEDTYPES.map((t) => [t.id, t.label]));
const SPECIES_EMOJI = { dog: '🐶', cat: '🐱', rabbit: '🐰', bird: '🐦', other: '🐾' };

export function newId() {
  return crypto.randomUUID();
}

export function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function speciesEmoji(species) {
  return SPECIES_EMOJI[species] || SPECIES_EMOJI.other;
}

export function kindLabel(kind) {
  return KIND_LABEL[kind] || kind;
}

export function poopLabel(poop) {
  return POOP_LABEL[poop] || poop;
}

export function medTypeLabel(type) {
  return MEDTYPE_LABEL[type] || type;
}

// null-safe numeric parse
export function toNumber(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function makePet(fields, now = Date.now()) {
  return {
    id: fields.id || newId(),
    type: 'pet',
    name: String(fields.name || '').trim(),
    species: SPECIES.some((s) => s.id === fields.species) ? fields.species : 'other',
    birthday: fields.birthday || '',
    unit: UNITS.includes(fields.unit) ? fields.unit : 'kg',
    note: fields.note || '',
    householdId: fields.householdId ?? null,
    createdAt: fields.createdAt || now,
    updatedAt: now,
    deletedAt: null,
    remoteFileId: fields.remoteFileId ?? null,
    photoId: fields.photoId ?? null,
    photoPath: fields.photoPath ?? null,
  };
}

export function makeLog(fields, now = Date.now()) {
  return {
    id: fields.id || newId(),
    type: 'log',
    petId: fields.petId,
    kind: KINDS.some((k) => k.id === fields.kind) ? fields.kind : 'daily',
    weight: toNumber(fields.weight),
    food: fields.food || '',
    poop: POOPS.some((p) => p.v === fields.poop) ? fields.poop : '',
    temp: toNumber(fields.temp),
    note: fields.note || '',
    dt: fields.dt || new Date().toISOString(),
    householdId: fields.householdId ?? null,
    createdAt: fields.createdAt || now,
    updatedAt: now,
    deletedAt: null,
    remoteFileId: fields.remoteFileId ?? null,
    photoId: fields.photoId ?? null,
    photoPath: fields.photoPath ?? null,
  };
}

export function makeMedical(fields, now = Date.now()) {
  return {
    id: fields.id || newId(),
    type: 'medical',
    petId: fields.petId,
    medType: MEDTYPES.some((t) => t.id === fields.medType) ? fields.medType : 'other',
    title: String(fields.title || '').trim(),
    date: fields.date || '',
    nextDate: fields.nextDate || '',
    done: Boolean(fields.done),
    note: fields.note || '',
    householdId: fields.householdId ?? null,
    createdAt: fields.createdAt || now,
    updatedAt: now,
    deletedAt: null,
    remoteFileId: fields.remoteFileId ?? null,
    photoId: fields.photoId ?? null,
    photoPath: fields.photoPath ?? null,
  };
}

// 'over' | 'soon' | 'okk'; days = signed days until nextDate
export function dueInfo(nextDate, today = todayStr()) {
  if (!nextDate) return null;
  const days = Math.round((Date.parse(nextDate) - Date.parse(today)) / 86400000);
  if (Number.isNaN(days)) return null;
  if (days < 0) return { days, key: 'over' };
  if (days <= 7) return { days, key: 'soon' };
  return { days, key: 'okk' };
}

export function bumpNextDate(nextDate, medType, today = todayStr()) {
  const from = Math.max(Date.parse(nextDate || ''), Date.parse(today));
  if (Number.isNaN(from)) return today;
  const d = new Date(from);
  if (medType === 'vaccine' || medType === 'surgery') d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return todayStr(d);
}

export function ageLabel(birthday, today = todayStr()) {
  if (!birthday) return '';
  const days = Math.floor((Date.parse(today) - Date.parse(birthday)) / 86400000);
  if (!(days >= 0)) return '';
  if (days < 365) return `${days} 天`;
  const years = Math.floor(days / 365);
  const rest = days % 365;
  return rest >= 30 ? `${years} 歲 ${Math.floor(rest / 30)} 個月` : `${years} 歲`;
}

// newest weight plus delta vs previous, from a list of logs (any order)
export function weightSeries(logs, petId) {
  const rows = (logs || [])
    .filter((l) => l.type === 'log' && l.petId === petId && !l.deletedAt && typeof l.weight === 'number')
    .sort((a, b) => String(a.dt).localeCompare(String(b.dt)));
  return rows.map((l) => ({ dt: l.dt, weight: l.weight, id: l.id }));
}

export function daysSince(dateStr, today = todayStr()) {
  if (!dateStr) return null;
  const t = Date.parse(dateStr.slice(0, 10));
  const now = Date.parse(today);
  if (Number.isNaN(t) || Number.isNaN(now)) return null;
  return Math.max(0, Math.floor((now - t) / 86400000));
}
