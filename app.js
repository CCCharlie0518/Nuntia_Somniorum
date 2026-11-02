
'use strict';

/* 全局版本号：显示在设置页最底部；日后发版只需改这一处 */
const APP_VERSION = 'v8.1.0';

/* =========================================================
 * 一、基础工具函数
 * ========================================================= */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const pad2 = n => String(n).padStart(2, '0');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const randInt = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const pickOne = arr => arr[Math.floor(Math.random() * arr.length)];
function pickMany(arr, n) {
  const pool = arr.slice();
  const out = [];
  while (pool.length && out.length < n) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return out;
}
const fmtClock = ts => {
  const d = new Date(ts); return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
};
const isSameDay = (a, b) => {
  const x = new Date(a), y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
};
const fmtMsgTime = ts => {
  const d = new Date(ts), now = new Date();
  if (isSameDay(ts, now)) return fmtClock(ts);
  const yesterday = new Date(now.getTime() - 86400000);
  if (isSameDay(ts, yesterday)) return '昨天 ' + fmtClock(ts);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + fmtClock(ts);
};
const fmtListTime = ts => {
  if (!ts) return '';
  const d = new Date(ts), now = new Date();
  if (isSameDay(ts, now)) return fmtClock(ts);
  const yesterday = new Date(now.getTime() - 86400000);
  if (isSameDay(ts, yesterday)) return '昨天';
  return (d.getMonth() + 1) + '/' + d.getDate();
};
const fmtDuration = sec => {
  sec = Math.max(0, Math.round(sec));
  return pad2(Math.floor(sec / 60)) + ':' + pad2(sec % 60);
};
const todayKey = () => {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
};
const todayLabel = () => {
  const d = new Date();
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
};
const fmtBytes = bytes => {
  if (!bytes || bytes < 1024) return (bytes || 0) + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
};

/* 颜色处理 */
function hexToRgb(hex) {
  let h = String(hex || '#12b7f5').replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const num = parseInt(h, 16) || 0;
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}
function mixHex(hex, target, ratio) {
  const a = hexToRgb(hex), b = hexToRgb(target);
  const c = {
    r: Math.round(a.r + (b.r - a.r) * ratio),
    g: Math.round(a.g + (b.g - a.g) * ratio),
    b: Math.round(a.b + (b.b - a.b) * ratio)
  };
  return '#' + [c.r, c.g, c.b].map(v => pad2(v.toString(16))).join('');
}

/* 在线状态功能已整体移除（状态展示、随机切换、权重与召回均不再存在） */

/* =========================================================
 * 二、存储层（IndexedDB 分表存储，localStorage 仅兜底与首次迁移）
 *
 * 设计目标：把体积最大的数据全部搬进 IndexedDB，彻底摆脱 localStorage 5MB 上限。
 *   kv     : 轻量状态（不含聊天明细 / 字卡 / 书籍正文 / 图片本体）
 *   chats  : 每个梦角一条完整聊天记录（主键 = 梦角 ID），永不截断
 *   books  : 每本书一条：书名 + 正文段落（主键 = 书籍 ID）
 *   cards  : 字卡 / 分组 / 拍一拍字卡
 *   assets : 图片资源（Base64），以内容指纹为 ID；状态里只留 asset://xxx 引用
 * 内存中的 state 仍保持原有结构（图片是 dataURL、聊天是数组），
 * 因此所有渲染与交互代码无需改动，只在落盘/读取时做拆分与还原。
 * ========================================================= */
const DB_NAME = 'dreamcard-db';
const DB_VERSION = 2;
const STORE_KV = 'kv';
const STORE_CHATS = 'chats';
const STORE_BOOKS = 'books';
const STORE_CARDS = 'cards';
const STORE_ASSETS = 'assets';
const DB_STORE = STORE_KV;          /* 兼容旧代码里的常量引用 */
const STATE_KEY = 'dream-state-v3';
const LEGACY_KEY = 'state-v1';
const ASSET_PREFIX = 'asset://';
const ASSET_MIN_LEN = 2048;         /* 只有超过这个长度的 data:image 才当作大资源外置 */

/* ---------------- 轻量 IndexedDB 封装：初始化 / 读 / 写 / 删 / 全表 ---------------- */
const DB = {
  db: null,
  opening: null,

  open() {
    if (this.db) return Promise.resolve(this.db);
    if (this.opening) return this.opening;
    this.opening = new Promise(resolve => {
      if (!window.indexedDB) return resolve(null);
      let settled = false;
      const done = db => { if (!settled) { settled = true; resolve(db); } };
      /* 打开超时兜底：绝不阻塞首屏，超时则整体退回 localStorage */
      const timer = setTimeout(() => done(null), 3000);
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = e => {
          const db = e.target.result;
          /* 旧库只有 kv 表：升级时补齐新表，旧数据原样保留 */
          [STORE_KV, STORE_CHATS, STORE_BOOKS, STORE_CARDS, STORE_ASSETS].forEach(name => {
            if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
          });
        };
        req.onsuccess = e => { clearTimeout(timer); done(e.target.result); };
        req.onerror = () => { clearTimeout(timer); done(null); };
        req.onblocked = () => { clearTimeout(timer); done(null); };
      } catch (err) {
        clearTimeout(timer);
        done(null);
      }
    }).then(db => {
      this.db = db;
      this.opening = null;
      return db;
    });
    return this.opening;
  },

  ready() { return !!(this.db && this.db.objectStoreNames); },

  /* 统一事务执行器：返回结果或 null，任何异常都不向外抛，避免打断 UI */
  _run(store, mode, build) {
    return new Promise(resolve => {
      if (!this.ready()) return resolve(null);
      try {
        const tx = this.db.transaction(store, mode);
        const rq = build(tx.objectStore(store));
        let out = null;
        if (rq) {
          rq.onsuccess = () => { out = rq.result; };
          rq.onerror = () => { out = null; };
        }
        tx.oncomplete = () => resolve(out);
        tx.onerror = () => resolve(null);
        tx.onabort = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  },

  get(store, key) { return this._run(store, 'readonly', os => os.get(key)); },
  all(store) { return this._run(store, 'readonly', os => os.getAll()); },
  keys(store) { return this._run(store, 'readonly', os => os.getAllKeys()); },

  put(store, key, value) {
    return new Promise(resolve => {
      if (!this.ready()) return resolve(false);
      try {
        const tx = this.db.transaction(store, 'readwrite');
        tx.objectStore(store).put(value, key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch (e) { resolve(false); }
    });
  },

  del(store, key) {
    return new Promise(resolve => {
      if (!this.ready()) return resolve(false);
      try {
        const tx = this.db.transaction(store, 'readwrite');
        tx.objectStore(store).delete(key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch (e) { resolve(false); }
    });
  },

  clear(store) {
    return new Promise(resolve => {
      if (!this.ready()) return resolve(false);
      try {
        const tx = this.db.transaction(store, 'readwrite');
        tx.objectStore(store).clear();
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch (e) { resolve(false); }
    });
  }
};

const Storage = {
  mode: 'memory',

  async init() {
    const db = await DB.open();
    if (db) { this.mode = 'idb'; return this.mode; }
    this.mode = this.localOK() ? 'local' : 'memory';
    return this.mode;
  },

  localOK() {
    try {
      localStorage.setItem('__probe__', '1');
      localStorage.removeItem('__probe__');
      return true;
    } catch (e) { return false; }
  },

  async get(key = STATE_KEY) {
    if (this.mode === 'idb') return DB.get(STORE_KV, key);
    if (this.mode === 'local') {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    }
    return null;
  },

  async set(data) {
    if (this.mode === 'idb') return DB.put(STORE_KV, STATE_KEY, data);
    if (this.mode === 'local') {
      try {
        localStorage.setItem(STATE_KEY, JSON.stringify(data));
        return true;
      } catch (e) { return false; }
    }
    return false;
  }
};

/* ---------------- 图片资源外置：落盘写 asset 表，读取时还原成 dataURL ---------------- */
const assetMemo = new Map();      /* dataURL → 资源 ID（字符串按引用命中，重复保存几乎零开销） */
const assetById = new Map();      /* 资源 ID → dataURL，用于指纹碰撞校验 */
const assetWritten = new Set();   /* 已确认写入 assets 表的资源 ID */
let assetUsedThisSave = new Set(); /* 本轮落盘实际引用到的资源 ID（用于清理无主图片） */

function isBigDataURL(v) {
  return typeof v === 'string' && v.length >= ASSET_MIN_LEN && v.slice(0, 11) === 'data:image';
}

/* 指纹 = 长度 + 抽样字符的 FNV-1a：对几十万字符的 Base64 也只需少量运算 */
function assetIdOf(dataURL) {
  const hit = assetMemo.get(dataURL);
  if (hit) return hit;
  let h = 0x811c9dc5;
  for (let i = 0; i < dataURL.length; i += 53) {
    h ^= dataURL.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  h = (h ^ dataURL.length) >>> 0;
  let id = 'a' + h.toString(36) + '_' + dataURL.length.toString(36);
  const old = assetById.get(id);
  if (old && old !== dataURL) id += '_' + (assetById.size % 997).toString(36);
  assetMemo.set(dataURL, id);
  assetById.set(id, dataURL);
  return id;
}

/* 把 dataURL 登记进本次落盘资源池，返回状态里保存的引用字符串 */
function assetRefFor(dataURL, bucket) {
  const id = assetIdOf(dataURL);
  assetUsedThisSave.add(id);
  bucket.push({ id, data: dataURL });
  return ASSET_PREFIX + id;
}

/* 递归把 asset://xxx 引用还原成真实 dataURL（就地替换，不改结构） */
function resolveAssetRefs(root, map) {
  if (!root || typeof root !== 'object' || !map.size) return;
  const walk = (obj, depth) => {
    if (!obj || typeof obj !== 'object' || depth > 8) return;
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        const v = obj[i];
        if (typeof v === 'string') {
          if (v.slice(0, 8) === ASSET_PREFIX) obj[i] = map.get(v.slice(8)) || '';
        } else if (v && typeof v === 'object') walk(v, depth + 1);
      }
      return;
    }
    Object.keys(obj).forEach(k => {
      const v = obj[k];
      if (typeof v === 'string') {
        if (v.slice(0, 8) === ASSET_PREFIX) obj[k] = map.get(v.slice(8)) || '';
      } else if (v && typeof v === 'object') walk(v, depth + 1);
    });
  };
  walk(root, 0);
}

/* 聊天数组落盘：图片外置成引用；只有带图的少量消息会生成浅拷贝，内存数据不受影响 */
function packChatMessages(list, assets) {
  if (!Array.isArray(list)) return [];
  const out = new Array(list.length);
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (!m || typeof m !== 'object') { out[i] = m; continue; }
    let copy = null;
    if (isBigDataURL(m.image)) {
      copy = Object.assign({}, m);
      copy.image = assetRefFor(m.image, assets);
    }
    if (Array.isArray(m.images)) {
      let arr = null;
      for (let j = 0; j < m.images.length; j++) {
        if (isBigDataURL(m.images[j])) {
          arr = arr || m.images.slice();
          arr[j] = assetRefFor(m.images[j], assets);
        }
      }
      if (arr) { copy = copy || Object.assign({}, m); copy.images = arr; }
    }
    out[i] = copy || m;
  }
  return out;
}

/* 轻量状态快照：聊天 / 字卡 / 书籍正文外置；任何一部分写失败就保留在 kv 里兜底 */
function buildLightSnapshot(keep) {
  const assets = [];
  const light = Object.assign({}, state);
  light.chats = keep.chats ? state.chats : {};
  light.cards = keep.cards ? state.cards : [];
  light.cardGroups = keep.cards ? state.cardGroups : [];
  light.userPatCards = keep.cards ? state.userPatCards : [];
  light.taPatCards = keep.cards ? state.taPatCards : [];
  light.readData = Object.assign({}, state.readData, {
    books: state.readData.books.map(b => ({
      id: b.id,
      name: b.name,
      chars: b.chars,
      ts: b.ts,
      /* 正文默认外置；books 表写失败时保留在 kv，宁可占地方也不丢内容 */
      paras: keep.books ? [] : (b.paras || [])
    }))
  });
  /* 图片一律转引用：状态里只剩 asset://xxx，真正的 Base64 写进 assets 表 */
  const json = JSON.stringify(light, (k, v) => (isBigDataURL(v) ? assetRefFor(v, assets) : v));
  return { light: JSON.parse(json), assets };
}

/* 清理 localStorage 里的旧快照（只在 IndexedDB 全部写成功后才清，防止丢数据） */
function dropLocalStorageSnapshot() {
  try {
    localStorage.removeItem(STATE_KEY);
    localStorage.removeItem(LEGACY_KEY);
  } catch (e) { /* 隐私模式可能不可用，忽略 */ }
}

/* ---------------- 落盘主流程 ---------------- */
let heavyHydrateFailed = false;   /* 启动时读分表失败：本轮绝不覆盖分表，改用整包兜底 */

async function saveStateNow() {
  if (!state) return false;

  /* 极端兜底：IndexedDB 不可用时退回旧的整包 localStorage 写法 */
  if (Storage.mode !== 'idb') {
    if (Storage.mode === 'local') {
      try {
        localStorage.setItem(STATE_KEY, JSON.stringify(state));
        return true;
      } catch (e) { return false; }
    }
    return false;
  }

  /* 读分表失败时：绝不用内存里的空数据覆盖旧分表，只整包写 kv 保命 */
  if (heavyHydrateFailed) {
    const light = Object.assign({}, state);
    const ok = await DB.put(STORE_KV, STATE_KEY, light);
    if (!ok) showToast('数据读取异常，本次未覆盖存储，请刷新页面后重试');
    return ok;
  }

  let chatsOk = true;
  let booksOk = true;
  let cardsOk = true;
  const assets = [];
  assetUsedThisSave = new Set();

  /* ① 聊天记录：按梦角 ID 一条一条存，全量保存、绝不截断 */
  const roleIds = Array.from(new Set(state.roles.map(r => r.id).concat(Object.keys(state.chats || {}))));
  for (const rid of roleIds) {
    const list = (state.chats && state.chats[rid]) || [];
    const packed = packChatMessages(list, assets);
    const ok = await DB.put(STORE_CHATS, rid, packed);
    if (!ok) chatsOk = false;
  }

  /* ② 一起读书：正文段落单独存（主键 = 书籍 ID），kv 里只留书名/进度等轻量信息 */
  for (const b of state.readData.books) {
    const ok = await DB.put(STORE_BOOKS, b.id, {
      id: b.id, name: b.name, chars: b.chars, ts: b.ts, paras: b.paras || []
    });
    if (!ok) booksOk = false;
  }

  /* ③ 字卡 / 分组 / 拍一拍字卡 */
  cardsOk = await DB.put(STORE_CARDS, 'main', {
    cards: state.cards,
    cardGroups: state.cardGroups,
    userPatCards: state.userPatCards,
    taPatCards: state.taPatCards
  });

  /* ④ 轻量状态（图片转引用；哪部分外置失败就整段保留在 kv） */
  const snap = buildLightSnapshot({ chats: chatsOk, cards: cardsOk, books: booksOk });

  /* ⑤ 先写图片资源，再写 kv：保证 kv 里的引用一定能被还原 */
  const pool = assets.concat(snap.assets);
  for (const a of pool) {
    if (assetWritten.has(a.id)) continue;
    if (await DB.put(STORE_ASSETS, a.id, a.data)) assetWritten.add(a.id);
  }

  const kvOk = await DB.put(STORE_KV, STATE_KEY, snap.light);

  /* 顺手清理没有被任何数据引用的旧图片（换壁纸、删表情后留下的孤儿资源） */
  if (kvOk) {
    try {
      const keys = await DB.keys(STORE_ASSETS);
      if (keys) {
        for (const k of keys) {
          if (!assetUsedThisSave.has(String(k))) {
            await DB.del(STORE_ASSETS, String(k));
            assetWritten.delete(String(k));
          }
        }
        assetById.forEach((url, id) => {
          if (!assetUsedThisSave.has(id)) { assetById.delete(id); assetMemo.delete(url); }
        });
      }
    } catch (e) { /* 清理失败不影响主流程 */ }
  }

  if (kvOk && chatsOk && booksOk && cardsOk) dropLocalStorageSnapshot();
  return kvOk;
}

/* ---------------- 启动时从分表还原：聊天 / 字卡 / 书籍正文 / 图片 ---------------- */
async function hydrateHeavyData() {
  if (Storage.mode !== 'idb' || !DB.ready()) return;
  heavyHydrateFailed = false;

  /* 图片池：一次性读出，供状态与聊天里的 asset:// 引用还原 */
  const assetMap = new Map();
  try {
    const keys = await DB.keys(STORE_ASSETS);
    if (!keys) heavyHydrateFailed = true;
    if (keys && keys.length) {
      const vals = await DB.all(STORE_ASSETS);
      if (vals) {
        keys.forEach((k, i) => {
          if (typeof vals[i] === 'string') { assetMap.set(String(k), vals[i]); assetWritten.add(String(k)); }
        });
      }
    }
  } catch (e) { /* 资源表读取失败时保持现有内联数据 */ }

  /* 字卡：有分表记录就以分表为准（kv 里的这三个字段只是占位） */
  try {
    const rec = await DB.get(STORE_CARDS, 'main');
    if (rec && Array.isArray(rec.cards)) {
      state.cards = rec.cards;
      if (Array.isArray(rec.cardGroups)) state.cardGroups = rec.cardGroups;
      if (Array.isArray(rec.userPatCards)) state.userPatCards = rec.userPatCards;
      if (Array.isArray(rec.taPatCards)) state.taPatCards = rec.taPatCards;
    }
  } catch (e) { /* 忽略 */ }

  /* 聊天记录：按梦角 ID 精确还原，条数完全保留 */
  try {
    const keys = await DB.keys(STORE_CHATS);
    if (!keys) heavyHydrateFailed = true;
    if (keys && keys.length) {
      const vals = await DB.all(STORE_CHATS);
      const map = new Map();
      keys.forEach((k, i) => map.set(String(k), vals[i]));
      state.roles.forEach(r => {
        if (map.has(r.id) && Array.isArray(map.get(r.id))) state.chats[r.id] = map.get(r.id);
      });
    }
  } catch (e) { /* 忽略 */ }

  /* 书籍正文 */
  try {
    const keys = await DB.keys(STORE_BOOKS);
    if (!keys) heavyHydrateFailed = true;
    if (keys && keys.length) {
      const vals = await DB.all(STORE_BOOKS);
      const map = new Map();
      keys.forEach((k, i) => map.set(String(k), vals[i]));
      state.readData.books.forEach(b => {
        const rec = map.get(b.id);
        if (rec && Array.isArray(rec.paras) && rec.paras.length) b.paras = rec.paras;
      });
    }
  } catch (e) { /* 忽略 */ }

  if (assetMap.size) {
    resolveAssetRefs(state.chats, assetMap);
    resolveAssetRefs(state, assetMap);
  }
}

let saveTimer = null;
let saveChain = Promise.resolve();   /* 串行化落盘：避免两次保存同时清理图片资源导致误删 */

function persist(immediate = false) {
  const write = () => {
    if (!state) return Promise.resolve(false);
    saveChain = saveChain.then(() => saveStateNow()).catch(() => false);
    return saveChain.then(ok => {
      if (!ok && Storage.mode !== 'memory') showToast('本地存储写入失败，请检查浏览器存储空间（建议先导出备份）');
      return ok;
    });
  };
  if (immediate) return write();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(write, 220);
}

/* =========================================================
 * 三、数据模型、旧数据迁移
 * ========================================================= */
function defaultRole(extra) {
  return Object.assign({
    id: uid(),
    name: '梦角',
    avatar: '🌙',
    signature: '在梦与现实的交界处等你。',
    theme: '',
    ts: Date.now()
  }, extra || {});
}

const SEED_CARDS = [
  ['我在呢，慢慢说，我一直听着。', '日常'],
  ['今天也辛苦了，先喝口水再继续吧。', '关心'],
  ['刚刚还在想你，你的消息就来了。', '心动'],
  ['嗯……让我猜猜，你现在是不是在笑？', '日常'],
  ['别怕，天塌下来也有我先顶着。', '安慰'],
  ['想和你一起把今晚的月亮看完。', '心动'],
  ['你再说一句，我就舍不得走了。', '撒娇'],
  ['那我们说好了，忙完就来找我。', '日常']
];

function defaultState() {
  const role = defaultRole();
  /* 种子字卡按第二元素建立初始分组，字卡全局共享、不再归属梦角 */
  const seedGroups = [];
  const seedGidByName = {};
  SEED_CARDS.forEach(([, g]) => {
    if (g && seedGidByName[g] === undefined) {
      const id = uid() + '_g' + seedGroups.length;
      seedGidByName[g] = id;
      seedGroups.push({ id, name: g, ts: Date.now() });
    }
  });
  return {
    version: 3,
    appName: 'Nuntia Somniorum / 梦之信使 · 字卡传讯',
    my: { name: '我', avatar: '🐰' },
    roles: [role],
    activeRoleId: role.id,
    settings: {
      theme: '#007AFF',
      replyChance: 100,
      /* 表情包发送概率：普通回复命中后，本次改为发一张共享表情包的概率 */
      emojiSendChance: 15,
      replyDelayMin: 1,
      replyDelayMax: 3,
      taRecallChance: 10,
      taQuoteChance: 15,
      locationCooldown: 60,
      mergeChance: 50,
      mergeMin: 2,
      mergeMax: 3,
      mergeSeparator: '，',
      burstEnabled: true,
      burstMin: 1,
      burstMax: 2,
      callChance: 60,
      answerChance: 80,
      spaceLikeChance: 50,
      spaceCommentChance: 30,
      redPacketClaimChance: 80,
      taRedPacketChance: 15,
      taGiftChance: 20,
      pomodoroSpeakChance: 30,
      snapshotCount: 5,
      autoSnapshotEnabled: false,
      autoSnapshotChance: 20,
      autoSnapshotInterval: 180,
      /* 主动写信：按间隔自动生成一封 TA 来信（正文用信件专属拼接规则抽字卡） */
      letterAutoEnabled: false,
      letterAutoInterval: 1440,
      /* 信件全局拼接：写信回信与主动来信统一遵循（与聊天全局 mergeXxx 完全独立） */
      letterMergeMin: 2,
      letterMergeMax: 3,
      letterMergeSeparator: '，',
      proactiveEnabled: true,
      proactiveChance: 20,
      proactiveMin: 10,
      proactiveMax: 30,
      keepAliveEnabled: false,
      notifyEnabled: false,
      notifyChat: true,
      notifySpace: true,
      patChance: 80,
      patCooldown: 10,
      /* 一起读书：接受共读概率 / 陪读消息间隔（0 表示关闭）/ TA 主动邀请共读概率 */
      readTogetherAcceptChance: 80,
      readCompanionInterval: 5,
      readInviteChance: 10,
      spaceProactiveEnabled: true,
      spaceProactiveChance: 15,
      spaceProactiveMin: 30,
      spaceProactiveMax: 90
    },
    nextProactiveAt: 0,
    nextSpaceProactiveAt: 0,
    patNextAt: 0,
    userPatCards: [],
    taPatCards: [],
    cardGroups: seedGroups,
    cards: SEED_CARDS.map(([content, group], i) => ({
      id: uid() + i,
      content,
      groupId: seedGidByName[group] || '',
      enabled: true,
      ts: Date.now()
    })),
    stickers: [],
    letters: [],
    moments: [],
    chats: {},
    unread: {},
    imgDrafts: {},
    quizTemplates: [],
    lastReplies: {},
    locations: { [role.id]: defaultLocationData() },
    locationRoleId: role.id,
    linkRoleId: role.id,
    pomodoro: { records: [] },
    /* 一起听：当前显示歌名 / 唱片中心图 / 播放模式 / 歌单元数据（音频 Blob URL 只在内存，刷新后需重新上传） */
    music: { name: '', cover: '', playMode: 'sequence', list: [] },
    /* 桌面照片墙：最多 1 张压缩后的 dataURL，随本地存储与完整备份一起保存 */
    photoWall: { images: [] },
    /* 拾光瓶：星星数 / 累计消息数(每 100 条 +1 星) / 连续聊天天数 / 最近聊天日期 / 断联暗淡标记 */
    jarData: { stars: 0, totalMessages: 0, streakDays: 0, lastChatDate: '', isDimmed: false },
    homeQuote: '今天也要好好照顾自己，慢一点也没关系。',
    /* 桌面「情侣空间」组件：双头像（Emoji 或图片 dataURL/URL）、双名字、相恋天数 */
    couple: { meAvatar: '🧑‍🦰', meName: '我', partnerAvatar: '🧑‍🦱', partnerName: 'TA', days: 100 },
    /* 桌面宠物：开关 / 图片 Base64 / 相对桌面左上角的坐标（null 表示默认右下角）/ 缩放比例 */
    pet: { enabled: false, image: '', left: null, top: null, scale: 1 },
    redPackets: [],
    wallet: {
      balance: 1000,
      transactions: []
    },
    ledger: [],
    todos: [],
    anniversaries: [],
    snapshots: [],
    coinHistory: [],
    linkBank: [],
    linkTests: [],
    /* 提醒应用：双轨数据 —— periods（经期区间）+ dailyReminders（日常提醒） */
    periods: [],
    dailyReminders: [],
    remindersLastCheckAt: 0, /* 经期预警去重：同一天只弹一次 */
    gifts: [
      { id: uid(), name: '热奶茶', emoji: '🧋', price: 20, ts: Date.now() },
      { id: uid(), name: '一束花', emoji: '💐', price: 88, ts: Date.now() },
      { id: uid(), name: '抱抱', emoji: '🤗', price: 0, ts: Date.now() }
    ],
    giftHistory: [],
    beautify: {
      deskWall: '',
      chatWallGlobal: '',
      chatWallByRole: {},
      spaceWall: '',
      iconTheme: 'blue',
      /* 组件外观：磨砂玻璃开关（默认关闭）+ 卡片背景白的不透明度（默认 80%） */
      glassOn: false,
      glassOpacity: 80,
      /* 样式自定义：字体 / 气泡两类，各自保存「已应用到全局」的最终 CSS；presets 为用户保存的预设 */
      customStyle: {
        tab: 'font',
        applied: { font: '', bubble: '' },
        presets: []
      }
    },
    homePages: splitIntoPages(HOME_APPS.map(a => a.route), homePageCountFor(HOME_APPS.length)),
    /* 一起读书：书籍、当前书与阅读进度、按日期统计的阅读时长、悬浮窗聊天记录、悬浮窗坐标 */
    readData: {
      roleId: '',
      isReading: false,
      books: [],
      bookId: '',
      readPos: 0,
      chapter: 0,
      stats: {},
      chat: [],
      fcPos: null
    },
    nextTaReadInviteAt: 0,
    nextAutoSnapshotAt: 0,
    nextAutoLetterAt: 0,
    nextTaGiftAt: 0,
    nextTaRedPacketAt: 0,
    /* 上次离开页面的时间戳（毫秒）：离线消息横幅据此结算这段时间内的新消息与超时待办 */
    lastSeenAt: 0
  };
}

let state = null;

/* 旧版（单梦角、无 dreamRoleId）迁移 */
function migrateV1(saved) {
  const s = saved.settings || {};
  const roleId = uid();
  const role = {
    id: roleId,
    name: s.dreamName || s.name || '梦角',
    avatar: s.dreamAvatar || s.avatar || '🌙',
    signature: '从旧版本迁移而来的对话记录。',
    theme: s.theme === '#12b7f5' || !s.theme ? '#007AFF' : s.theme,
    ts: Date.now()
  };
  const cards = (Array.isArray(saved.cards) ? saved.cards : []).map(c => ({
    id: c.id || uid(),
    content: c.content || '',
    category: c.category || '',
    enabled: c.enabled !== false,
    ts: c.ts || Date.now()
  }));
  const messages = (Array.isArray(saved.messages) ? saved.messages : []).map(m => ({
    id: m.id || uid(),
    role: m.role === 'user' ? 'user' : 'dream',
    type: m.type === 'sticker' ? 'sticker' : 'text',
    content: m.content || '',
    image: m.image || '',
    ts: m.ts || Date.now(),
    read: true
  }));
  const letters = (Array.isArray(saved.letters) ? saved.letters : []).map(l => Object.assign({}, l, {
    roleId: l.roleId || roleId
  }));
  const unread = { [roleId]: (saved.chat && saved.chat.unread) || 0 };
  return {
    version: 3,
    appName: 'Nuntia Somniorum / 梦之信使 · 字卡传讯',
    my: { name: s.userName || '我', avatar: s.userAvatar || '🐰' },
    roles: [role],
    activeRoleId: roleId,
    settings: { theme: s.theme === '#12b7f5' || !s.theme ? '#007AFF' : s.theme },
    cardGroups: [],
    cards,
    stickers: Array.isArray(saved.stickers) ? saved.stickers : [],
    letters,
    moments: Array.isArray(saved.moments) ? saved.moments : [],
    chats: { [roleId]: messages },
    unread,
    quizTemplates: Array.isArray(saved.quizTemplates) ? saved.quizTemplates : [],
    lastReplies: saved.lastCardId ? {} : {},
    location: saved.location || {},
    pomodoro: saved.pomodoro || { records: [] }
  };
}

function mergeState(saved) {
  const d = defaultState();
  if (!saved || typeof saved !== 'object') return d;
  let src = saved;
  if (!Array.isArray(src.roles)) {
    src = migrateV1(src);
  }
  const out = Object.assign({}, d, src);
  out.settings = Object.assign({}, d.settings, src.settings || {});
  out.my = Object.assign({}, d.my, src.my || {});
  out.location = Object.assign({}, d.location, src.location || {});
  out.pomodoro = Object.assign({}, d.pomodoro, src.pomodoro || {});
  /* 美化：旧数据没有 customStyle 字段时补齐结构，避免样式自定义读取 undefined */
  out.beautify = Object.assign({}, d.beautify, src.beautify || {});
  {
    const csSrc = (out.beautify.customStyle && typeof out.beautify.customStyle === 'object') ? out.beautify.customStyle : {};
    const appliedSrc = (csSrc.applied && typeof csSrc.applied === 'object') ? csSrc.applied : {};
    out.beautify.customStyle = {
      tab: csSrc.tab === 'bubble' ? 'bubble' : 'font',
      applied: {
        font: typeof appliedSrc.font === 'string' ? appliedSrc.font : '',
        bubble: typeof appliedSrc.bubble === 'string' ? appliedSrc.bubble : ''
      },
      presets: Array.isArray(csSrc.presets) ? csSrc.presets.filter(p => p && typeof p === 'object').map(p => ({
        id: String(p.id || uid()),
        name: String(p.name || '未命名预设').slice(0, 20),
        mode: p.mode === 'bubble' ? 'bubble' : 'font',
        code: String(p.code || ''),
        css: String(p.css || ''),
        font: String(p.font || ''),
        ts: Number(p.ts) || Date.now()
      })) : []
    };
  }
  /* localStorage 兜底：IndexedDB 不可用（例如以 file:// 打开）或状态里还没写入时，
     从镜像恢复「已应用到全局」的自定义样式，保证刷新后依然生效 */
  try {
    const mirror = JSON.parse(localStorage.getItem('dc-custom-css-v1') || 'null');
    if (mirror && typeof mirror === 'object') {
      const ap = out.beautify.customStyle.applied;
      if (!ap.font && typeof mirror.font === 'string') ap.font = mirror.font;
      if (!ap.bubble && typeof mirror.bubble === 'string') ap.bubble = mirror.bubble;
    }
  } catch (e) { /* localStorage 不可用时忽略，不影响启动 */ }
  ['roles', 'cards', 'cardGroups', 'stickers', 'letters', 'moments', 'quizTemplates', 'userPatCards', 'taPatCards', 'periods', 'dailyReminders'].forEach(k => {
    if (!Array.isArray(out[k])) out[k] = [];
  });
  /* 拾光瓶：旧数据缺字段时补默认值，数值字段归一为非负整数 */
  const jdSrc = (out.jarData && typeof out.jarData === 'object') ? out.jarData : {};
  out.jarData = {
    stars: Math.max(0, Math.floor(Number(jdSrc.stars) || 0)),
    totalMessages: Math.max(0, Math.floor(Number(jdSrc.totalMessages) || 0)),
    streakDays: Math.max(0, Math.floor(Number(jdSrc.streakDays) || 0)),
    lastChatDate: typeof jdSrc.lastChatDate === 'string' ? jdSrc.lastChatDate : '',
    isDimmed: jdSrc.isDimmed === true
  };
  /* 旧版日常提醒没有长期字段：补默认值（isLongTerm=false，startDate/endDate=date），保证区间判断统一 */
  out.dailyReminders = out.dailyReminders.map(r => {
    if (!r || typeof r !== 'object') return r;
    if (r.isLongTerm === undefined) {
      return Object.assign({}, r, {
        isLongTerm: false,
        startDate: r.startDate || r.date || '',
        endDate: r.endDate !== undefined ? r.endDate : (r.date || '')
      });
    }
    return r;
  });
  /* 旧数据没有 cardGroups 字段时从空开始（不继承种子分组），由下方字卡迁移按旧 category 按需创建 */
  if (!Array.isArray(src.cardGroups)) out.cardGroups = [];
  /* 旧版拍一拍字卡库（若存在）整体迁移到「我的拍一拍字卡库」，不丢失 */
  if (Array.isArray(src.patCards) && src.patCards.length && !out.userPatCards.length) {
    out.userPatCards = src.patCards.map(c => ({
      id: (c && c.id) || uid(),
      content: String((c && (c.content || c.text)) || '').trim(),
      enabled: !c || c.enabled !== false,
      ts: (c && c.ts) || Date.now()
    })).filter(c => c.content);
  }
  /* 拍一拍节奏与 TA 主动发空间的判定时间戳 */
  out.patNextAt = Number(out.patNextAt) || 0;
  out.nextSpaceProactiveAt = Number(out.nextSpaceProactiveAt) || 0;
  /* 一起读书：概率参数与陪读间隔校正（间隔 0 表示关闭，范围 0~60 分钟） */
  ['readTogetherAcceptChance', 'readInviteChance'].forEach(k => {
    const v = Number(out.settings[k]);
    out.settings[k] = Number.isFinite(v) ? clamp(v, 0, 100) : d.settings[k];
  });
  const rdIv = Number(out.settings.readCompanionInterval);
  out.settings.readCompanionInterval = Number.isFinite(rdIv)
    ? clamp(Math.round(rdIv), 0, 60) : d.settings.readCompanionInterval;
  /* 一起读书数据：书籍 / 当前书 / 阅读进度 / 时长统计 / 悬浮窗聊天记录，旧数据缺失时自动补全 */
  const rdSrc = (out.readData && typeof out.readData === 'object') ? out.readData : {};
  out.readData = {
    roleId: typeof rdSrc.roleId === 'string' ? rdSrc.roleId : '',
    isReading: rdSrc.isReading === true,
    /* 书籍正文已外置到 IndexedDB 的 books 表：这里允许只有书名/进度、没有 paras 的轻量记录 */
    books: Array.isArray(rdSrc.books) ? rdSrc.books.filter(b => b && b.id).map(b => ({
      id: String(b.id),
      name: String(b.name || '未命名').slice(0, 60),
      paras: Array.isArray(b.paras) ? b.paras.map(p => String(p == null ? '' : p)).filter(p => p.trim()) : [],
      chars: Number(b.chars) || 0,
      ts: Number(b.ts) || Date.now()
    })) : [],
    bookId: typeof rdSrc.bookId === 'string' ? rdSrc.bookId : '',
    readPos: Number(rdSrc.readPos) > 0 ? Math.round(Number(rdSrc.readPos)) : 0,
    chapter: Number.isFinite(Number(rdSrc.chapter)) ? Math.max(0, Math.floor(Number(rdSrc.chapter))) : 0,
    stats: {},
    chat: Array.isArray(rdSrc.chat) ? rdSrc.chat.filter(x => x && x.sender).map(x => ({
      id: String(x.id || uid()),
      roleId: String(x.roleId || ''),
      /* 阅读聊天消息标记所属书籍：删除书籍时可精确清理它的专属记录 */
      bookId: typeof x.bookId === 'string' ? x.bookId : '',
      sender: x.sender === 'user' ? 'user' : 'ta',
      type: x.type === 'quote' ? 'quote' : '',
      quoteText: x.type === 'quote' ? String(x.quoteText == null ? '' : x.quoteText).slice(0, 400) : '',
      emotion: x.type === 'quote' ? String(x.emotion == null ? '' : x.emotion).slice(0, 60) : '',
      content: String(x.content == null ? '' : x.content),
      quote: (x.quote && x.quote.text) ? { text: String(x.quote.text), who: String(x.quote.who || '') } : null,
      ts: Number(x.ts) || Date.now()
    })) : [],
    fcPos: (rdSrc.fcPos && Number.isFinite(Number(rdSrc.fcPos.left))
      && Number.isFinite(Number(rdSrc.fcPos.top)) && Number(rdSrc.fcPos.w) > 0)
      ? { left: Number(rdSrc.fcPos.left), top: Number(rdSrc.fcPos.top), w: Number(rdSrc.fcPos.w) }
      : null
  };
  /* 阅读时长统计：只保留合法的 YYYY-MM-DD 键与 {together, alone} 秒数 */
  const rdStatsSrc = (rdSrc.stats && typeof rdSrc.stats === 'object' && !Array.isArray(rdSrc.stats)) ? rdSrc.stats : {};
  Object.keys(rdStatsSrc).forEach(k => {
    const v = rdStatsSrc[k];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !v || typeof v !== 'object') return;
    out.readData.stats[k] = {
      together: Math.max(0, Math.round(Number(v.together) || 0)),
      alone: Math.max(0, Math.round(Number(v.alone) || 0))
    };
  });
  if (!out.readData.books.some(b => b.id === out.readData.bookId)) {
    out.readData.bookId = out.readData.books[0] ? out.readData.books[0].id : '';
  }
  out.nextTaReadInviteAt = Number(out.nextTaReadInviteAt) || 0;
  /* 一起听：只持久化歌名 / 唱片图 / 播放模式 / 歌单元数据；
     音频本身以 Blob URL 存在运行时，绝不写入 localStorage（刷新后由用户重新上传） */
  const musicSrc = (src.music && typeof src.music === 'object') ? src.music : {};
  const rawPlayMode = musicSrc.playMode;
  out.music = {
    name: typeof musicSrc.name === 'string' ? musicSrc.name.slice(0, 60) : '',
    cover: typeof musicSrc.cover === 'string' ? musicSrc.cover : '',
    playMode: ['sequence', 'loop', 'random'].includes(rawPlayMode) ? rawPlayMode : 'sequence',
    list: Array.isArray(musicSrc.list) ? musicSrc.list.filter(t => t && typeof t === 'object' && t.name).map(t => ({
      id: String(t.id || uid()),
      name: String(t.name).slice(0, 120),
      displayName: String(t.displayName || '').slice(0, 60),
      /* LRC 歌词原文：体积很小，可持久化；音频 Blob 仍然绝不写入存储 */
      lrc: typeof t.lrc === 'string' ? t.lrc.slice(0, 12000) : '',
      /* 每首歌自己的唱片中心图（压缩后的 dataURL），没有则回落到全局 cover */
      cover: typeof t.cover === 'string' ? t.cover.slice(0, 200000) : ''
    })).slice(0, 200) : []
  };
  /* 桌面照片墙：最多 1 张 dataURL（随完整备份导出） */
  const pwSrc = (src.photoWall && typeof src.photoWall === 'object') ? src.photoWall : {};
  out.photoWall = {
    images: Array.isArray(pwSrc.images) ? pwSrc.images.filter(s => typeof s === 'string' && s).slice(0, 1) : []
  };
  /* 已读不回字卡库已移除：清理旧数据/旧备份中的残留字段 */
  delete out.silentCards;
  if (!Array.isArray(out.pomodoro.records)) out.pomodoro.records = [];

  /* 概率参数校正，兼容旧版 / 手工编辑过的备份 */
  ['replyChance', 'emojiSendChance', 'callChance', 'answerChance', 'spaceLikeChance', 'spaceCommentChance', 'redPacketClaimChance', 'taRedPacketChance', 'taGiftChance', 'autoSnapshotChance', 'pomodoroSpeakChance', 'taRecallChance', 'taQuoteChance'].forEach(k => {
    const v = Number(out.settings[k]);
    out.settings[k] = Number.isFinite(v) ? clamp(v, 0, 100) : d.settings[k];
  });
  const snapN = Number(out.settings.snapshotCount);
  out.settings.snapshotCount = Number.isFinite(snapN) ? clamp(Math.round(snapN), 3, 20) : d.settings.snapshotCount;
  const snapI = Number(out.settings.autoSnapshotInterval);
  out.settings.autoSnapshotInterval = Number.isFinite(snapI) ? clamp(Math.round(snapI), 30, 720) : d.settings.autoSnapshotInterval;
  /* 回复延迟（秒）：范围 0~300，默认 1~3 秒，最长不小于最短 */
  ['replyDelayMin', 'replyDelayMax'].forEach(k => {
    const v = Number(out.settings[k]);
    out.settings[k] = Number.isFinite(v) ? clamp(Math.round(v), 0, 300) : d.settings[k];
  });
  if (out.settings.replyDelayMax < out.settings.replyDelayMin) out.settings.replyDelayMax = out.settings.replyDelayMin;
  /* 定位刷新冷却（秒）：0 表示不限制，范围 0~3600，默认 60 */
  const lc = Number(out.settings.locationCooldown);
  out.settings.locationCooldown = Number.isFinite(lc) ? clamp(Math.round(lc), 0, 3600) : 60;
  /* 主题统一为 iMessage 蓝：旧默认色迁移，用户自定义色保留 */
  if (out.settings.theme === '#12b7f5') out.settings.theme = '#007AFF';
  /* 拼字卡张数：最少 2 张，范围 2~6，且 max ≥ min（旧数据 mergeMin=1 自动升为 2） */
  ['mergeMin', 'mergeMax'].forEach(k => {
    const v = Number(out.settings[k]);
    out.settings[k] = Number.isFinite(v) ? clamp(Math.round(v), 2, 6) : d.settings[k];
  });
  if (out.settings.mergeMax < out.settings.mergeMin) out.settings.mergeMax = out.settings.mergeMin;
  /* 连发字卡：开关默认开启，条数 1~6，最大不得小于最小 */
  out.settings.burstEnabled = out.settings.burstEnabled !== false;
  ['burstMin', 'burstMax'].forEach(k => {
    const v = Number(out.settings[k]);
    out.settings[k] = Number.isFinite(v) ? clamp(Math.round(v), 1, 6) : d.settings[k];
  });
  if (out.settings.burstMax < out.settings.burstMin) out.settings.burstMax = out.settings.burstMin;
  /* 「已读不回方式」设置项已移除：固定为显示已读小字，旧数据/旧备份里的字段直接丢弃 */
  delete out.settings.readNoReplyMode;
  /* 「TA答题正确率」已移除：链接测试改为完全随机，旧字段直接丢弃 */
  delete out.settings.linkCorrectChance;
  /* 来电频率、默认回信间隔设置项已移除：旧数据/旧备份中的残留字段直接丢弃 */
  delete out.settings.callFrequency;
  delete out.settings.defaultReplyDelay;
  if (!['，', '、', ' ', '\n'].includes(out.settings.mergeSeparator)) out.settings.mergeSeparator = '，';
  /* 拼字卡概率 mergeChance（0~100，默认 50）替代旧开关 mergeEnabled：
     旧存档 mergeEnabled=false → 0%（永远单张）；mergeEnabled=true 或缺省 → 50% */
  const mcRaw = Number(out.settings.mergeChance);
  if (Number.isFinite(mcRaw)) {
    out.settings.mergeChance = clamp(Math.round(mcRaw), 0, 100);
  } else {
    out.settings.mergeChance = out.settings.mergeEnabled === false ? 0 : 50;
  }
  delete out.settings.mergeEnabled;
  /* 在线状态相关设置已整体移除：旧数据 / 旧备份里的字段直接丢弃 */
  ['statusAffectsCall', 'randomStatusEnabled', 'statusSwitchMin', 'statusSwitchMax', 'recallCooldown'].forEach(k => delete out.settings[k]);
  out.settings.autoSnapshotEnabled = out.settings.autoSnapshotEnabled === true;
  /* 主动写信：开关默认关闭；间隔 1~10080 分钟，默认 1440（一天） */
  out.settings.letterAutoEnabled = out.settings.letterAutoEnabled === true;
  const lai = Number(out.settings.letterAutoInterval);
  out.settings.letterAutoInterval = Number.isFinite(lai) ? clamp(Math.round(lai), 1, 10080) : 1440;
  /* 信件全局拼接：张数 1~6，最少不得大于最多；分隔符只接受预设值 */
  let lmin = clamp(Math.round(Number(out.settings.letterMergeMin) || 2), 1, 6);
  let lmax = clamp(Math.round(Number(out.settings.letterMergeMax) || 3), 1, 6);
  if (lmin > lmax) { const t = lmin; lmin = lmax; lmax = t; }
  out.settings.letterMergeMin = lmin;
  out.settings.letterMergeMax = lmax;
  const lsep = String(out.settings.letterMergeSeparator == null ? '，' : out.settings.letterMergeSeparator);
  out.settings.letterMergeSeparator = ['，', '、', ' ', '\n', ''].indexOf(lsep) >= 0 ? lsep : '，';
  const nla = Number(out.nextAutoLetterAt);
  out.nextAutoLetterAt = Number.isFinite(nla) ? nla : 0;
  out.settings.proactiveEnabled = out.settings.proactiveEnabled !== false;
  const pc = Number(out.settings.proactiveChance);
  out.settings.proactiveChance = Number.isFinite(pc) ? clamp(Math.round(pc), 0, 100) : 20;
  const pMin = Number(out.settings.proactiveMin);
  out.settings.proactiveMin = Number.isFinite(pMin) ? clamp(Math.round(pMin), 1, 240) : 10;
  const pMax = Number(out.settings.proactiveMax);
  out.settings.proactiveMax = Number.isFinite(pMax) ? clamp(Math.round(pMax), 1, 240) : 30;
  if (out.settings.proactiveMax < out.settings.proactiveMin) out.settings.proactiveMax = out.settings.proactiveMin;
  /* 拍一拍：概率 0~100 默认 80；冷却 0~120 秒默认 10 */
  const patCh = Number(out.settings.patChance);
  out.settings.patChance = Number.isFinite(patCh) ? clamp(Math.round(patCh), 0, 100) : 80;
  const patCd = Number(out.settings.patCooldown);
  out.settings.patCooldown = Number.isFinite(patCd) ? clamp(Math.round(patCd), 0, 120) : 10;
  /* TA主动发空间：开关默认开启；概率 0~100 默认 15；间隔 1~480 分钟默认 30~90 */
  out.settings.spaceProactiveEnabled = out.settings.spaceProactiveEnabled !== false;
  const spCh = Number(out.settings.spaceProactiveChance);
  out.settings.spaceProactiveChance = Number.isFinite(spCh) ? clamp(Math.round(spCh), 0, 100) : 15;
  ['spaceProactiveMin', 'spaceProactiveMax'].forEach(k => {
    const v = Number(out.settings[k]);
    out.settings[k] = Number.isFinite(v) ? clamp(Math.round(v), 1, 480) : d.settings[k];
  });
  if (out.settings.spaceProactiveMax < out.settings.spaceProactiveMin) out.settings.spaceProactiveMax = out.settings.spaceProactiveMin;
  const npa = Number(out.nextProactiveAt);
  out.nextProactiveAt = Number.isFinite(npa) ? npa : 0;
  const nas = Number(out.nextAutoSnapshotAt);
  out.nextAutoSnapshotAt = Number.isFinite(nas) ? nas : 0;
  const ntgf = Number(out.nextTaGiftAt);
  out.nextTaGiftAt = Number.isFinite(ntgf) ? ntgf : 0;
  const ntrp = Number(out.nextTaRedPacketAt);
  out.nextTaRedPacketAt = Number.isFinite(ntrp) ? ntrp : 0;
  /* 离线补发提示：上次离开页面的时间戳，只接受合法正数，0 表示还没有记录 */
  const lsa = Number(out.lastSeenAt);
  out.lastSeenAt = Number.isFinite(lsa) && lsa > 0 ? lsa : 0;
  /* 后台保活 / 后台通知：旧数据补默认值（保活默认关闭、通知默认关闭，子开关默认开启） */
  out.settings.keepAliveEnabled = out.settings.keepAliveEnabled === true;
  out.settings.notifyEnabled = out.settings.notifyEnabled === true;
  out.settings.notifyChat = out.settings.notifyChat !== false;
  out.settings.notifySpace = out.settings.notifySpace !== false;
  /* 旧版的【待办事项通知】子开关已废弃（改为默认开启、仅受总开关控制），旧数据/旧备份中的残留字段直接丢弃 */
  delete out.settings.notifyTodo;

  if (!Array.isArray(out.roles) || !out.roles.length) out.roles = [defaultRole()];
  if (!out.chats || typeof out.chats !== 'object') out.chats = {};
  /* 转账/送礼卡片方向迁移：补齐 sender，并按发送方/接收方纠正左右；
   * 接收方补充卡片（receivedCard）固定由接收方发出，避免两张卡挤在同一侧 */
  Object.keys(out.chats).forEach(rid => {
    const list = out.chats[rid];
    if (!Array.isArray(list)) { out.chats[rid] = []; return; }
    list.forEach(m => {
      if (!m || (m.type !== 'redpacket' && m.type !== 'gift')) return;
      let sender = (m.sender === 'user' || m.sender === 'ta')
        ? m.sender
        : (m.role === 'user' ? 'user' : 'ta');
      if (m.receivedCard === true) {
        const rec = m.type === 'redpacket'
          ? (out.redPackets || []).find(r => r.id === m.redPacketId)
          : (out.giftHistory || []).find(g => g.id === m.giftRecordId);
        if (rec) sender = rec.direction === 'out' ? 'ta' : 'user';
      }
      m.sender = sender;
      m.role = sender === 'user' ? 'user' : 'dream';
    });
  });
  if (!out.unread || typeof out.unread !== 'object') out.unread = {};
  if (!out.lastReplies || typeof out.lastReplies !== 'object') out.lastReplies = {};
  /* 在线状态已移除：旧数据里的状态字段与召回记录直接丢弃 */
  delete out.recallUntil;
  ['redPackets', 'ledger', 'todos', 'anniversaries', 'snapshots', 'coinHistory', 'linkBank', 'linkTests', 'gifts', 'giftHistory'].forEach(k => {
    if (!Array.isArray(out[k])) out[k] = [];
  });
  /* 待办事项：旧数据/旧备份逐条规范化（date=YYYY-MM-DD、time=HH:MM 可空、remindTime=毫秒时间戳） */
  out.todos = out.todos.filter(t => t && typeof t === 'object').map(t => ({
    id: String(t.id || uid()),
    content: String(t.content || '').slice(0, 200),
    date: /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : (Number(t.remindTime) > 0 ? todoDateKeyOf(Number(t.remindTime)) : todayKey()),
    time: /^\d{1,2}:\d{2}$/.test(t.time || '') ? t.time : '',
    remindTime: Number(t.remindTime) || 0,
    isCompleted: t.isCompleted === true,
    isNotified: t.isNotified === true
  }));
  if (typeof out.homeQuote !== 'string' || !out.homeQuote.trim()) out.homeQuote = d.homeQuote;
  /* 情侣空间组件：旧数据/旧备份补默认值；字段逐个校验，天数钳制为 0~99999 的整数 */
  out.couple = Object.assign({}, d.couple, (src.couple && typeof src.couple === 'object') ? src.couple : {});
  ['meAvatar', 'meName', 'partnerAvatar', 'partnerName'].forEach(k => {
    if (typeof out.couple[k] !== 'string' || !out.couple[k].trim()) out.couple[k] = d.couple[k];
  });
  const cpDays = Number(out.couple.days);
  out.couple.days = Number.isFinite(cpDays) ? clamp(Math.round(cpDays), 0, 99999) : d.couple.days;
  /* 桌面宠物：旧数据 / 旧备份补默认值；坐标允许为 null（表示右下角默认位置），缩放钳制在 0.5~2.5 */
  const srcPet = (src.pet && typeof src.pet === 'object') ? src.pet : {};
  const petNum = (v, fallback) => {
    const n = (typeof v === 'number') ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
    return Number.isFinite(n) ? n : fallback;
  };
  out.pet = {
    enabled: srcPet.enabled === true,
    image: typeof srcPet.image === 'string' ? srcPet.image : '',
    left: petNum(srcPet.left, null),
    top: petNum(srcPet.top, null),
    scale: clamp(petNum(srcPet.scale, 1), 0.5, 2.5)
  };
  if (!Array.isArray(src.gifts)) {
    out.gifts = [
      { id: uid(), name: '热奶茶', emoji: '🧋', price: 20, ts: Date.now() },
      { id: uid(), name: '一束花', emoji: '💐', price: 88, ts: Date.now() },
      { id: uid(), name: '抱抱', emoji: '🤗', price: 0, ts: Date.now() }
    ];
  }
  /* 礼物双向化：去掉旧「心意值」字段；送礼记录补方向（旧记录一律视为我送TA） */
  out.gifts = out.gifts.map(g => {
    const gift = (g && typeof g === 'object') ? g : {};
    const price = Number(gift.price);
    return {
      id: gift.id || uid(),
      name: String(gift.name || '礼物'),
      emoji: String(gift.emoji || '🎁'),
      price: Number.isFinite(price) && price >= 0 ? Math.round(price * 100) / 100 : 20,
      ts: gift.ts || Date.now()
    };
  }).filter(g => g.name);
  out.giftHistory = out.giftHistory.map(h => {
    const rec = (h && typeof h === 'object') ? h : {};
    /* 旧送礼记录没有接收状态时，按已收下处理（浅色卡片） */
    const claimed = typeof rec.claimed === 'boolean' ? rec.claimed : true;
    /* 状态三值：pending 待收下 / claimed 已收下 / returned 已退回（24h 未领取自动退回） */
    const status = rec.status === 'returned' ? 'returned' : (claimed ? 'claimed' : 'pending');
    return {
      id: rec.id || uid(),
      roleId: rec.roleId || '',
      roleName: String(rec.roleName || ''),
      giftName: String(rec.giftName || '礼物'),
      emoji: String(rec.emoji || '🎁'),
      price: Math.max(0, Math.round((Number(rec.price) || 0) * 100) / 100),
      note: String(rec.note || ''),
      direction: rec.direction === 'in' ? 'in' : 'out',
      status,
      claimed,
      claimedAt: Number(rec.claimedAt) || 0,
      createTime: Number(rec.createTime) || rec.ts || Date.now(),  /* 24h 退回计时起点；旧数据用 ts 兜底 */
      ts: rec.ts || Date.now()
    };
  });
  out.redPackets = out.redPackets.map(r => {
    const rec = (r && typeof r === 'object') ? r : {};
    /* 旧转账记录按原状态还原；完全没有状态字段时默认已接收（浅色卡片）；
       状态三值：pending 待收款 / claimed 已收款 / returned 已退回（24h 未领取自动退回） */
    const hasState = ['pending', 'claimed', 'returned'].includes(rec.status) || typeof rec.claimed === 'boolean';
    const status = hasState
      ? (rec.status === 'returned' ? 'returned' : ((rec.status === 'claimed' || rec.claimed === true) ? 'claimed' : 'pending'))
      : 'claimed';
    return {
      id: rec.id || uid(),
      roleId: rec.roleId || '',
      roleName: String(rec.roleName || ''),
      amount: Number(rec.amount) || 0,
      blessing: String(rec.blessing || ''),
      count: Math.max(1, Number(rec.count) || 1),
      direction: rec.direction === 'in' ? 'in' : 'out',
      status,
      claimed: status === 'claimed',
      claimedAt: Number(rec.claimedAt) || 0,
      createTime: Number(rec.createTime) || rec.ts || Date.now(),  /* 24h 退回计时起点；旧数据用 ts 兜底 */
      ts: rec.ts || Date.now()
    };
  });
  /* 钱包：旧数据无钱包字段时按默认 1000 初始化，交易记录保持为空（不追溯旧记录） */
  const srcWallet = (src.wallet && typeof src.wallet === 'object') ? src.wallet : {};
  const bal = Number(srcWallet.balance);
  out.wallet = {
    balance: Number.isFinite(bal) ? Math.max(0, Math.round(bal * 100) / 100) : 1000,
    transactions: Array.isArray(srcWallet.transactions) ? srcWallet.transactions.map(t => {
      const rec = (t && typeof t === 'object') ? t : {};
      return {
        id: rec.id || uid(),
        type: rec.type === 'in' ? 'in' : 'out',
        amount: Math.max(0, Number(rec.amount) || 0),
        title: String(rec.title || ''),
        note: String(rec.note || ''),
        roleId: rec.roleId || '',
        roleName: String(rec.roleName || ''),
        ts: rec.ts || Date.now()
      };
    }) : []
  };
  out.snapshots = out.snapshots.map(s => {
    const rec = (s && typeof s === 'object') ? s : {};
    return Object.assign({}, rec, {
      id: rec.id || uid(),
      by: rec.by === '我' ? '我' : 'TA',
      ts: rec.ts || Date.now(),
      items: Array.isArray(rec.items) ? rec.items : []
    });
  });
  /* 美化与桌面图标顺序 */
  out.beautify = Object.assign({}, d.beautify, (src.beautify && typeof src.beautify === 'object') ? src.beautify : {});
  if (!['blue', 'light', 'dark'].includes(out.beautify.iconTheme)) out.beautify.iconTheme = 'blue';
  if (!out.beautify.chatWallByRole || typeof out.beautify.chatWallByRole !== 'object') out.beautify.chatWallByRole = {};
  ['deskWall', 'chatWallGlobal', 'spaceWall'].forEach(k => {
    if (typeof out.beautify[k] !== 'string') out.beautify[k] = '';
  });
  /* 组件外观：磨砂开关与透明度（0~100，默认 80） */
  out.beautify.glassOn = out.beautify.glassOn === true;
  const glassOp = Number(out.beautify.glassOpacity);
  out.beautify.glassOpacity = Number.isFinite(glassOp) ? clamp(Math.round(glassOp), 0, 100) : 80;
  /* 桌面分页归属与顺序：旧 homeAppOrder（一维数组）按默认分页映射迁移；新入口归入默认页 */
  out.homePages = migrateHomePages(src);
  delete out.homeAppOrder;

  out.roles = out.roles.map(r => {
    const role = (r && typeof r === 'object') ? r : {};
    role.id = role.id || uid();
    role.name = String(role.name || '梦角');
    role.avatar = role.avatar || '🌙';
    role.signature = String(role.signature || '');
    /* 留空表示继承全局主题色，仅当用户为梦角单独选色时才保存具体颜色 */
    role.theme = (typeof role.theme === 'string' && role.theme && role.theme !== '#007AFF') ? role.theme : '';
    role.ts = role.ts || Date.now();
    delete role.status;
    delete role.statusText;
    delete role.statusUpdatedAt;
    delete role.statusNextAt;
    if (!Array.isArray(out.chats[role.id])) out.chats[role.id] = [];
    if (typeof out.unread[role.id] !== 'number') out.unread[role.id] = 0;
    return role;
  });

  /* 梦角定位：按梦角独立；旧全局定位归到第一个梦角，其余梦角生成默认数据 */
  out.locations = {};
  const legacyLoc = (src.location && typeof src.location === 'object') ? src.location : null;
  out.roles.forEach((r, i) => {
    const cur = (src.locations && typeof src.locations === 'object') ? src.locations[r.id] : null;
    out.locations[r.id] = normalizeLocation(cur || (i === 0 ? legacyLoc : null) || randomLocationData());
  });
  delete out.location;
  if (!out.roles.some(r => r.id === out.locationRoleId)) out.locationRoleId = out.roles[0].id;
  if (!out.roles.some(r => r.id === out.linkRoleId)) out.linkRoleId = out.roles[0].id;

  /* 链接测试题库：旧格式 {q,a} 迁移为 {q,options,correct}；测试记录补 dreamRoleId 归属 */
  out.linkBank = out.linkBank.map(q => {
    const item = (q && typeof q === 'object') ? q : {};
    let options = Array.isArray(item.options) ? item.options.map(o => String(o)).filter(o => o.trim()) : [];
    if (!options.length && item.a) options = [String(item.a)];
    const correct = clamp(parseInt(item.correct, 10) || 0, 0, Math.max(0, options.length - 1));
    return { id: item.id || uid(), q: String(item.q || ''), options, correct, ts: item.ts || Date.now() };
  }).filter(q => q.q && q.options.length);
  out.linkTests = out.linkTests.map(t => {
    const rec = (t && typeof t === 'object') ? t : {};
    const roleId = (rec.roleId && out.roles.some(r => r.id === rec.roleId)) ? rec.roleId : out.roles[0].id;
    const role = out.roles.find(r => r.id === roleId);
    return Object.assign({}, rec, {
      id: rec.id || uid(),
      roleId,
      roleName: String(rec.roleName || (role ? role.name : 'TA')),
      total: Number(rec.total) || 0,
      correct: Number(rec.correct) || 0,
      level: String(rec.level || '连接微弱'),
      details: Array.isArray(rec.details) ? rec.details : [],
      ts: rec.ts || Date.now()
    });
  });

  /* 字卡分组校正：名称去重、空名剔除，建立 名称→id 索引 */
  const cardGroups = [];
  const gidByName = {};
  out.cardGroups.forEach(g => {
    const name = String(typeof g === 'string' ? g : (g && g.name) || '').trim();
    if (!name || gidByName[name]) return;
    const id = (g && typeof g === 'object' && g.id) || uid();
    gidByName[name] = id;
    cardGroups.push({ id, name, ts: (g && g.ts) || Date.now() });
  });
  out.cardGroups = cardGroups;
  /* 按组名确保分组存在（导入 JSON 的 group 字段、旧版 category 都走这里） */
  const ensureCardGroup = name => {
    const n = String(name || '').trim();
    if (!n) return '';
    if (!gidByName[n]) {
      const id = uid();
      gidByName[n] = id;
      out.cardGroups.push({ id, name: n, ts: Date.now() });
    }
    return gidByName[n];
  };

  /* 字卡迁移：不再区分梦角归属，dreamRoleId 字段直接丢弃；
   * 旧 category / group 字段转为分组（无则未分组），一张字卡都不丢 */
  out.cards = out.cards.map(c => {
    const card = (c && typeof c === 'object') ? c : { content: c };
    let groupId = '';
    if (card.groupId && out.cardGroups.some(g => g.id === card.groupId)) {
      groupId = card.groupId;
    } else {
      groupId = ensureCardGroup(card.group || card.category || '');
    }
    return {
      id: card.id || uid(),
      content: String(card.content || ''),
      groupId,
      enabled: card.enabled !== false,
      ts: card.ts || Date.now()
    };
  }).filter(c => c.content.trim());

  out.stickers = out.stickers.map(s => {
    const st = typeof s === 'string' ? { data: s } : (s && typeof s === 'object' ? s : {});
    return {
      id: st.id || uid(),
      name: String(st.name || '表情'),
      data: st.data || st.url || st.src || '',
      ts: st.ts || Date.now()
    };
  }).filter(s => s.data);

  out.letters = out.letters.map(l => {
    const letter = (l && typeof l === 'object') ? l : {};
    /* 来信方：ta = TA 主动写来，user = 我写的（持久化 sender 字段，兼容旧的 fromTa） */
    const sender = (letter.sender === 'ta' || letter.fromTa === true) ? 'ta' : 'user';
    let status = ['draft', 'pendingReply', 'replied', 'inbox', 'userReplied'].includes(letter.status) ? letter.status : 'draft';
    if (sender === 'ta') {
      /* 旧版把主动来信错写成 replied；有用户回复内容才算「已回复」，否则回到「待查看」 */
      status = (letter.userReplyContent || letter.status === 'userReplied') ? 'userReplied' : 'inbox';
    } else if (status === 'inbox' || status === 'userReplied') {
      status = 'draft';
    }
    return {
      id: letter.id || uid(),
      title: String(letter.title || '未命名信件'),
      body: String(letter.body || letter.content || ''),
      date: String(letter.date || ''),
      roleId: letter.roleId || letter.dreamRoleId || out.roles[0].id,
      read: letter.read === true || letter.isRead === true,
      ts: letter.ts || letter.createdAt || Date.now(),
      sender,
      status,
      sentAt: Number(letter.sentAt) || 0,
      replyDueAt: Number(letter.replyDueAt) || 0,
      taReplyContent: String(letter.taReplyContent || ''),
      taReplyAt: Number(letter.taReplyAt) || 0,
      /* 我回复 TA 主动来信的内容 */
      userReplyContent: String(letter.userReplyContent || ''),
      userReplyAt: Number(letter.userReplyAt) || 0,
      /* TA 主动写来的信：保留来源标记，刷新后仍显示「来自 TA」 */
      fromTa: sender === 'ta',
      /* 来信系统通知去重标记：旧数据缺省视为未通知 */
      isNotified: letter.isNotified === true
    };
  });

  out.moments = out.moments.map(m => {
    const hasInteract = Number(m.interactAt) > 0;
    /* 多图支持：旧动态只有单图字段时迁移为 images 数组中的一张 */
    const imgs = Array.isArray(m.images)
      ? m.images.filter(x => typeof x === 'string' && x).slice(0, 9)
      : [];
    if (!imgs.length) {
      const single = m.image || m.img || '';
      if (single) imgs.push(String(single));
    }
    return {
      id: m.id || uid(),
      text: String(m.text || m.content || ''),
      images: imgs,
      /* 旧字段保留首图，兼容旧版导出/导入与旧读取路径 */
      image: imgs[0] || '',
      likes: Array.isArray(m.likes) ? m.likes : [],
      comments: (Array.isArray(m.comments) ? m.comments : []).map(c => {
        if (typeof c === 'string') {
          return { id: uid(), who: 'me', sender: 'user', name: out.my.name, text: c, replyTo: '', ts: m.ts || Date.now() };
        }
        const isMe = c.who === 'me' || c.sender === 'user';
        return {
          id: c.id || uid(),
          who: c.who || (isMe ? 'me' : 'ta'),
          sender: c.sender || (isMe ? 'user' : 'ta'),    /* 统一 sender：'user' 我 / 'ta' 梦角 */
          name: String(c.name || (isMe ? out.my.name : 'TA')),
          text: String(c.text || ''),
          replyTo: c.replyTo || '',                       /* 回复对象：'user' / 'ta' / '' */
          ts: c.ts || Date.now()
        };
      }),
      ts: m.ts || Date.now(),
      /* TA 主动发布的动态：保留发布者归属，刷新后仍显示为该梦角 */
      fromTa: m.fromTa === true,
      fromRoleId: m.fromRoleId || '',
      /* 空间 TA 互动：旧动态没有 interactAt，视为已判定，不再追溯触发 */
      interactAt: hasInteract ? Number(m.interactAt) : 0,
      interactRoleId: m.interactRoleId || '',
      interacted: hasInteract ? m.interacted === true : true
    };
  });

  out.quizTemplates = out.quizTemplates.map(t => ({
    id: t.id || uid(),
    title: String(t.title || '问卷'),
    questions: (Array.isArray(t.questions) ? t.questions : []).map(q => quizQuestionNormalize(q)).filter(q => q.text && q.options.length),
    ts: t.ts || Date.now()
  })).filter(t => t.questions.length);

  out.pomodoro.records = out.pomodoro.records.map(r => ({
    id: r.id || uid(),
    task: String(r.task || '陪伴专注'),
    minutes: Number(r.minutes) || 25,
    ts: r.ts || Date.now()
  }));

  Object.keys(out.chats).forEach(rid => {
    if (!Array.isArray(out.chats[rid])) { out.chats[rid] = []; return; }
    out.chats[rid] = out.chats[rid].map(m => {
      if (!m || typeof m !== 'object') return null;
      const msg = m;
      msg.id = msg.id || uid();
      msg.role = msg.role === 'user' ? 'user' : (msg.role === 'system' ? 'system' : 'dream');
      msg.ts = msg.ts || Date.now();
      msg.type = msg.type || 'text';
      if (msg.type === 'call' && !msg.call) msg.type = 'text';
      if (msg.type === 'quiz' && !msg.quiz) msg.type = 'text';
      if (msg.type === 'sticker' && !msg.image) msg.type = 'text';
      /* 图片消息兼容：旧记录无 images 视为无图；类型不对的脏数据直接丢弃 */
      if (msg.images !== undefined && !Array.isArray(msg.images)) delete msg.images;
      if (Array.isArray(msg.images)) msg.images = msg.images.filter(x => typeof x === 'string' && x).slice(0, 9);
      if (typeof msg.read !== 'boolean') msg.read = msg.role === 'user';
      return msg;
    }).filter(Boolean);
  });

  /* 待发送图片预览（per-chat）：旧数据 / 旧备份缺省为空，结构不对的键丢弃 */
  if (!out.imgDrafts || typeof out.imgDrafts !== 'object' || Array.isArray(out.imgDrafts)) out.imgDrafts = {};
  Object.keys(out.imgDrafts).forEach(k => {
    if (!Array.isArray(out.imgDrafts[k])) delete out.imgDrafts[k];
    else out.imgDrafts[k] = out.imgDrafts[k].filter(x => typeof x === 'string' && x).slice(0, 9);
  });

  if (!out.activeRoleId || !out.roles.some(r => r.id === out.activeRoleId)) {
    out.activeRoleId = out.roles[0].id;
  }
  out.version = 3;
  out.migrated = true;
  return out;
}

/* =========================================================
 * 四、主题、头像、弹窗等通用 UI
 * ========================================================= */
/* 主题色变量映射：html 根节点与聊天页共用同一套写入逻辑，
 * 所有色值（主色 / 深色 / 浅色 / 卡片深浅两档）都由同一个主题色推导，避免各页面各写一套 */
function applyThemeVars(el, color) {
  if (!el) return;
  /* 色值校验兜底：任何来源传进来的非 #RRGGBB（含拖动取色盘时的中间态）都退回安全默认色 */
  const safe = /^#[0-9a-fA-F]{6}$/.test(String(color || '')) ? String(color) : '#12b7f5';
  color = safe;
  const rgb = hexToRgb(color) || { r: 0, g: 122, b: 255 };
  const s = el.style;
  s.setProperty('--primary', color);
  s.setProperty('--primary-color', color);          // 命名别名，语义上等同于全局主题色
  s.setProperty('--primary-2', mixHex(color, '#ffffff', 0.34));
  s.setProperty('--primary-dark', mixHex(color, '#000000', 0.16));
  s.setProperty('--primary-soft', `rgba(${rgb.r},${rgb.g},${rgb.b},.12)`);
  s.setProperty('--primary-rgb', `${rgb.r},${rgb.g},${rgb.b}`);
  s.setProperty('--primary-weak', `rgba(${rgb.r},${rgb.g},${rgb.b},.30)`);
  /* 图标/线条用的「墨色」：主题色过浅（白、浅黄等）时自动压深，避免桌面图标看不见 */
  s.setProperty('--primary-ink', (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255 > 0.78 ? mixHex(color, '#000000', 0.45) : color);
  s.setProperty('--quiz-shade', quizShadeFor(color));
  /* 转账/送礼卡片：深色=主题色本体；浅色=主题色约 30% 与白色混合；文字=主题色压深 42% */
  s.setProperty('--theme-card-dark', color);
  s.setProperty('--theme-card-light', mixHex(color, '#ffffff', 0.70));
  s.setProperty('--theme-card-text', mixHex(color, '#000000', 0.42));
  s.setProperty('--theme-card-shade', quizShadeFor(color));
}

function applyTheme() {
  const color = state.settings.theme || '#12b7f5';
  /* 关键：变量写在 html 根节点（documentElement）上，聊天页无论挂在 #app、#viewport 还是 body
   * 下，都能沿 DOM 继承到；同时写一份到 body，做双保险 */
  applyThemeVars(document.documentElement, color);
  applyThemeVars(document.body, color);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', color);
  document.title = state.appName || '梦之信使';
  /* 聊天页是早先渲染好的旧 DOM：同步刷页面级变量并强制重绘，避免沿用缓存颜色 */
  applyRoleTheme();
}

/* 梦角标识色（只用于头像配色）：未单独设置（空或旧的默认蓝 #007AFF）时跟随全局主题色 */
function roleColor(role) {
  const t = role && role.theme;
  return (t && t !== '#007AFF') ? t : (state.settings.theme || '#007AFF');
}

/* 聊天页主题同步：一律取全局主题色，不再读取 role.theme——
 * 否则梦角残留的旧主题色会让整页在全局换色后「保持原样」 */
let lastChatThemeApplied = null;
function applyRoleTheme() {
  const page = $('#page-chat');
  if (!page) return;
  const color = state.settings.theme || '#12b7f5';
  applyThemeVars(page, color);
  /* 同一个颜色重复调用时不再重放动画：进入聊天页 / 每次发消息渲染都不该触发一次
     160ms 动画 + 强制 reflow，只有真正换色时才需要 */
  if (lastChatThemeApplied === color) return;
  lastChatThemeApplied = color;
  /* 强制重绘：先移除再添加动画类，并读取一次 offsetWidth 触发 reflow，丢弃旧样式的渲染缓存 */
  page.classList.remove('theme-repaint');
  void page.offsetWidth;
  page.classList.add('theme-repaint');
}

/* ===== 自定义主题颜色：确认后生效 ===== */
/* 关闭取色面板：移除遮罩、解锁页面滚动 */
function closeThemeColorPicker() {
  const el = document.getElementById('themePickerMask');
  if (el) el.remove();
  document.documentElement.classList.remove('tp-lock');
  document.removeEventListener('keydown', onThemePickerKey);
}

function onThemePickerKey(e) {
  if (e.key === 'Escape') closeThemeColorPicker();
}

/* 唯一应用主题色的入口：点【确认】或点预设色块时才会调用 */
function setGlobalThemeColor(hex) {
  if (!/^#[0-9a-fA-F]{6}$/.test(String(hex || ''))) return;
  state.settings.theme = String(hex);
  applyTheme();                    /* 写入 html 根节点变量，聊天页/图标/卡片统一变色 */
  persist();                       /* 落盘 */
  const r = (typeof currentRoute !== 'undefined' && currentRoute) || {};
  if (r.page === 'sub' && r.name === 'beautify') renderBeautifyPage();   /* 回显高亮 */
}

/* 打开取色面板：面板内拖动只改小预览，绝不触碰全局变量 */
function openThemeColorPicker() {
  closeThemeColorPicker();
  const cur = /^#[0-9a-fA-F]{6}$/.test(String(state.settings.theme || '')) ? String(state.settings.theme) : '#007AFF';
  const mask = document.createElement('div');
  mask.className = 'theme-picker-mask';
  mask.id = 'themePickerMask';
  mask.innerHTML = `
    <div class="theme-picker-box" role="dialog" aria-modal="true" aria-label="自定义主题颜色">
      <div class="tp-head">自定义主题颜色</div>
      <div class="tp-preview" id="tpPreview" style="background:${cur}"><span id="tpHex">${cur.toUpperCase()}</span></div>
      <input class="tp-color" type="color" id="tpInput" value="${cur}" aria-label="选择颜色">
      <div class="tp-tip">选色只在本面板预览，点【确认】才会应用到全局主题</div>
      <div class="tp-actions">
        <button class="tp-btn tp-cancel" id="tpCancel" type="button">取消</button>
        <button class="tp-btn tp-ok" id="tpOk" type="button">确认</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  document.documentElement.classList.add('tp-lock');   /* 锁定底层滚动，防止穿透 */

  const input = mask.querySelector('#tpInput');
  const preview = mask.querySelector('#tpPreview');
  const hexLabel = mask.querySelector('#tpHex');
  /* 高频 input 只更新面板内的小色块与色值文字：不改全局变量、不保存、不重渲染 */
  input.addEventListener('input', e => {
    const v = /^#[0-9a-fA-F]{6}$/.test(String(e.target.value || '')) ? String(e.target.value) : cur;
    preview.style.background = v;
    hexLabel.textContent = v.toUpperCase();
  });
  mask.querySelector('#tpOk').addEventListener('click', () => {
    const v = /^#[0-9a-fA-F]{6}$/.test(String(input.value || '')) ? String(input.value) : cur;
    closeThemeColorPicker();
    setGlobalThemeColor(v);
  });
  mask.querySelector('#tpCancel').addEventListener('click', closeThemeColorPicker);
  /* 点击面板外的黑色遮罩关闭，不应用任何颜色 */
  mask.addEventListener('click', e => { if (e.target === mask) closeThemeColorPicker(); });
  mask.addEventListener('touchmove', e => { if (e.target === mask) e.preventDefault(); }, { passive: false });
  document.addEventListener('keydown', onThemePickerKey);
}

/* 根据主题色亮度返回问卷卡片的黑色遮罩强度（越浅遮罩越重） */
function quizShadeFor(color) {
  const rgb = hexToRgb(color);
  if (!rgb) return 'rgba(0,0,0,.10)';
  const lum = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  const a = lum > 0.82 ? 0.50 : lum > 0.62 ? 0.34 : 0.10;
  return `rgba(0,0,0,${a})`;
}

function avatarHTML(src, size = 42, extraClass = '', color = '') {
  const value = src || '🙂';
  const isImg = /^(data:image|https?:|blob:)/.test(value);
  const style = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.48)}px` +
    (color ? `;background:linear-gradient(135deg,${color},${mixHex(color, '#ffffff', .35)})` : '');
  if (isImg) {
    return `<div class="avatar ${extraClass}" style="${style};background:#f2f4f7"><img src="${esc(value)}" alt=""></div>`;
  }
  return `<div class="avatar ${extraClass}" style="${style}">${esc(value)}</div>`;
}
function roleAvatarHTML(role, size = 42) {
  return avatarHTML(role.avatar, size, '', roleColor(role));
}

/* 梦角横向选择条：定位页 / 链接测试页等共用。
 * 每项带 data-rspick="roleId"，由页面自行绑定点击切换。 */
function roleStripHTML(selectedId) {
  return `<div class="role-strip">${state.roles.map(r => `
    <button class="rs-item ${r.id === selectedId ? 'active' : ''}" data-rspick="${r.id}">
      ${roleAvatarHTML(r, 40)}
      <span class="rs-nm">${esc(r.name)}</span>
    </button>`).join('')}</div>`;
}

let toastTimer = null;
function showToast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1900);
}

function showModal(opt) {
  const { title = '', body = '', actions = [], wide = false, onMount = null } = opt || {};
  const root = $('#modalRoot');
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal${wide ? ' wide' : ''}">
      ${title ? `<div class="modal-title">${esc(title)}</div>` : ''}
      <div class="modal-body">${body}</div>
      ${actions.length ? `<div class="modal-actions">${actions.map((a, i) =>
        `<button class="mbtn ${a.kind || ''}" data-mi="${i}">${esc(a.label)}</button>`).join('')}</div>` : ''}
    </div>`;
  root.appendChild(overlay);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    overlay.classList.add('closing');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => overlay.remove(), 180);
  };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  $$('.mbtn', overlay).forEach(btn => {
    btn.addEventListener('click', () => {
      const action = actions[Number(btn.dataset.mi)];
      if (action && typeof action.onClick === 'function') {
        const ret = action.onClick(overlay, close);
        if (ret && typeof ret.then === 'function') {
          ret.then(value => { if (value !== false) close(); });
        } else if (ret !== false) close();
      } else close();
    });
  });
  if (typeof onMount === 'function') onMount(overlay, close);
  requestAnimationFrame(() => overlay.classList.add('show'));
  return { el: overlay, close };
}

function confirmDialog(title, message, okLabel = '确定', danger = false) {
  return new Promise(resolve => {
    showModal({
      title,
      body: `<p class="modal-text">${esc(message)}</p>`,
      actions: [
        { label: '取消', onClick: () => resolve(false) },
        { label: okLabel, kind: danger ? 'danger' : 'primary', onClick: () => resolve(true) }
      ]
    });
  });
}

function showActionSheet(title, items) {
  const body = `
    <div class="actionsheet">
      ${title ? `<div class="modal-title" style="font-size:13px;color:#8b909a;padding-bottom:10px">${esc(title)}</div>` : ''}
      <div class="sheet-group">
        ${items.map((it, i) => `<button class="sheet-item" data-ai="${i}">${esc(it.label)}</button>`).join('')}
      </div>
    </div>`;
  const modal = showModal({ body });
  $$('.sheet-item', modal.el).forEach(btn => {
    btn.addEventListener('click', () => {
      const item = items[Number(btn.dataset.ai)];
      modal.close();
      if (item && typeof item.onClick === 'function') setTimeout(item.onClick, 60);
    });
  });
}

/* 图片加载失败时的占位图（内联 SVG，不依赖网络） */
const IMG_FALLBACK = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180"><rect width="100%" height="100%" fill="#e9edf3"/><text x="50%" y="50%" font-size="14" fill="#98a2b3" text-anchor="middle" dominant-baseline="middle">图片加载失败</text></svg>'
);

function imgFallback(el) {
  if (!el) return;
  el.onerror = null;
  el.src = IMG_FALLBACK;
  el.classList.add('img-broken');
}

/* 大图预览：传入数组时支持左右切换（空间多图动态使用） */
function showLightbox(src, list, index) {
  const arr = (Array.isArray(list) && list.length ? list : [src]).filter(Boolean);
  if (!arr.length) return;
  let i = clamp(Number(index) || 0, 0, arr.length - 1);
  const box = document.createElement('div');
  box.className = 'lightbox';
  box.innerHTML = `
    <button class="lb-close" aria-label="关闭">✕</button>
    ${arr.length > 1 ? '<button class="lb-nav lb-prev" aria-label="上一张">‹</button><button class="lb-nav lb-next" aria-label="下一张">›</button>' : ''}
    <img src="${esc(arr[i])}" alt="">
    <div class="lb-count"></div>`;
  document.body.appendChild(box);
  const img = $('img', box);
  const count = $('.lb-count', box);
  const paint = () => {
    img.src = arr[i];
    if (count) count.textContent = arr.length > 1 ? `${i + 1} / ${arr.length}` : '';
    img.onerror = () => imgFallback(img);
  };
  const close = () => { box.remove(); document.removeEventListener('keydown', onKey); };
  const go = d => {
    if (arr.length < 2) return;
    i = (i + d + arr.length) % arr.length;
    paint();
  };
  const onKey = e => {
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowLeft') go(-1);
    if (e.key === 'ArrowRight') go(1);
  };
  paint();
  document.addEventListener('keydown', onKey);
  $('.lb-close', box).addEventListener('click', e => { e.stopPropagation(); close(); });
  const prev = $('.lb-prev', box), next = $('.lb-next', box);
  if (prev) prev.addEventListener('click', e => { e.stopPropagation(); go(-1); });
  if (next) next.addEventListener('click', e => { e.stopPropagation(); go(1); });
  box.addEventListener('click', e => {
    if (e.target === box || e.target === img) close();
  });
}

/* =========================================================
 * 五、图片读取与压缩
 * ========================================================= */
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* 统一图片压缩：最大边 800px、JPEG 质量 0.7
   所有上传入口都走这里，避免大图把 IndexedDB 也撑爆；maxDim 超过 800 会被强制压到 800 */
function compressDataURL(dataURL, maxDim = 800, quality = .7) {
  return new Promise(resolve => {
    const cap = clamp(Number(maxDim) || 800, 64, 800);
    const q = clamp(Number(quality) || .7, .3, .7);
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      const scale = Math.min(1, cap / Math.max(width, height));
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      /* JPEG 不支持透明，先铺白底，避免透明区域变成黑块 */
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', q));
    };
    img.onerror = () => resolve(dataURL);
    img.src = dataURL;
  });
}

/** 选择本地图片并压缩，返回 dataURL 或 null */
function pickImage(maxDim = 800, quality = .7) {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) return resolve(null);
      if (!/^image\//.test(file.type)) { showToast('请选择图片文件'); return resolve(null); }
      try {
        const raw = await readFileAsDataURL(file);
        resolve(await compressDataURL(raw, maxDim, quality));
      } catch (e) { resolve(null); }
    });
    input.click();
  });
}

/** 多选本地图片并逐张压缩；单张失败只提示，不影响其他图片 */
function pickImages(maxDim = 800, quality = .7) {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', async () => {
      const files = Array.from(input.files || []);
      input.remove();
      if (!files.length) return resolve([]);
      const out = [];
      for (const file of files) {
        if (!/^image\//.test(file.type)) { showToast('已跳过非图片文件'); continue; }
        try {
          const raw = await readFileAsDataURL(file);
          out.push(await compressDataURL(raw, maxDim, quality));
        } catch (e) {
          showToast('有一张图片读取失败，已跳过');
        }
      }
      resolve(out);
    });
    input.click();
  });
}

/* =========================================================
 * 六、路由与页面切换
 * ========================================================= */
let currentRoute = { page: 'home' };
let routeStack = [];
let currentTab = 'home';
let convSearch = '';

function navigate(route, replace = false) {
  if (!replace && currentRoute) routeStack.push(currentRoute);
  currentRoute = route;
  applyRoute();
}

function goBack() {
  const prev = routeStack.pop();
  currentRoute = prev || { page: currentTab || 'messages' };
  applyRoute();
}

/* ====== 消息列表页返回按钮：全局函数 + 内联 onclick，
   不依赖 addEventListener（innerHTML 重渲染后可能丢失绑定）
   不依赖事件委托、不依赖 .icon-btn 样式覆盖
   内联 onclick 会立刻命中，绝对不会丢 */
function __msgBackHome() {
  if (routeStack.length === 0) {
    /* routeStack 空（比如直接 navigate({page:'messages'}) 进入的，不是从 home push 过来的）→ 直接切 home */
    currentRoute = { page: 'home' };
    currentTab = 'home';
  } else {
    /* 正常返回 */
    currentRoute = routeStack.pop();
  }
  applyRoute();
}
window.__msgBackHome = __msgBackHome;   /* 显式挂到 window，内联 onclick 才能找到 */

function switchTab(tab) {
  routeStack = [];
  currentTab = tab;
  convSearch = '';
  currentRoute = { page: tab };
  applyRoute();
}

function applyRoute() {
  const page = currentRoute.page;
  /* 一起读书：离开阅读界面时先卸载悬浮窗并停止陪读定时器（只清理本模块 DOM，不影响其它页面） */
  if (readingRoomMounted && !(currentRoute.page === 'sub' && currentRoute.name === 'readingroom')) {
    rdUnmountRoom();
  }
  /* 离开「一起做 / 一起读书」模块时结束共读会话；聊天页视为接受邀请后的过渡页，保持会话 */
  if (state && state.readData && state.readData.isReading) {
    const keepSession = (currentRoute.page === 'sub'
      && ['readtogether', 'reading', 'readingroom'].indexOf(currentRoute.name) >= 0)
      || currentRoute.page === 'chat';
    if (!keepSession) rdEndSession();
  }
  const map = {
    home: 'page-home',
    messages: 'page-messages',
    contacts: 'page-contacts',
    space: 'page-space',
    publish: 'page-space-publish',
    sub: 'page-sub',
    chat: 'page-chat'
  };
  /* 聊天页已经回到 #viewport / #app 内部，#app 必须一直可见（高度同步的关键）。
     聊天页打开时：隐藏其它 .page（桌面、消息列表等），让 absolute 聊天页盖住它们；
     关闭时：恢复 .page.active。聊天页自己的 active 类独立控制。
     绝对不能给 #app 写 display:none —— 它是聊天页的定位包含块，一隐藏聊天页就跟着没了。 */
  const isChat = page === 'chat';
  const chatPage = document.getElementById('page-chat');
  if (chatPage) chatPage.classList.toggle('active', isChat);
  /* 隐藏所有非聊天 .page，用 inline style 避免影响 .page.active 的 display:flex 语义 */
  $$('.page').forEach(el => {
    if (isChat) el.style.display = (el.id === 'page-chat') ? '' : 'none';
    else el.style.removeProperty('display');
  });
  /* tabbar 在聊天时也隐藏（它在 #app 里，z-index 低于聊天页，但视觉上应该整个应用就只剩聊天页） */
  const tabbar = document.getElementById('tabbar');
  if (tabbar) tabbar.style.display = isChat ? 'none' : '';
  /* 打开聊天页锁死 body 底层滚动，关闭聊天页恢复（配合 body.chat-open CSS，切断底层页面跟随滚动的可能） */
  document.body.classList.toggle('chat-open', isChat);

  /* 路由切换时强制收起键盘：上一页残留的输入焦点（例如问卷编辑器里的输入框）
     会让系统键盘保持弹起、并把新页输入区顶成悬浮/撑开状态。
     统一失焦，保证新页布局从干净状态开始。 */
  try {
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) ae.blur();
  } catch (e) {}

  /* 关键：先清掉所有 .page 的 active，再加给当前目标，否则旧页面会叠在上面 */
  $$('.page').forEach(el => el.classList.remove('active'));
  const target = document.getElementById(map[page] || 'page-home');
  if (target && target !== chatPage) target.classList.add('active');
  /* 底部导航已移除：桌面是唯一入口，其余页面均带返回 */
  currentTab = 'home';
  if (page === 'home' || page === 'messages' || page === 'contacts' || page === 'space') {
    currentTab = page === 'contacts' ? 'home' : page;
  }
  closeStickerSheet();
  closeChatPlus();
  applyBeautify();
  if (page === 'home') renderHomePage();
  else if (page === 'messages') renderMessagesPage();
  else if (page === 'contacts') renderContactsPage();
  else if (page === 'space') renderSpacePage();
  else if (page === 'publish') renderPublishPage();
  else if (page === 'sub') renderSub(currentRoute.name);
  else if (page === 'chat') renderChatPage(currentRoute.roleId);
  /* 打开聊天页时强制滚动归零一次（唯一的 scrollTo 调用点），
     防止 iOS 键盘残留的可视窗口偏移带进新页 */
  if (isChat) forceScrollZero();
  /* 桌宠只在桌面首页显示：路由变化后统一同步显隐（离开桌面自动隐藏，回到桌面再显示） */
  syncPetVisibility();
}

/* 滚动归零双重保险：window.scrollTo(0,0) + documentElement/body 的 scrollTop 一旦发现非 0 立刻置 0。
   只在打开聊天页时调用一次，不做任何持续监听。 */
function forceScrollZero() {
  window.scrollTo(0, 0);
  if (document.documentElement.scrollTop) document.documentElement.scrollTop = 0;
  if (document.body && document.body.scrollTop) document.body.scrollTop = 0;
}

/* =========================================================
 * 七、通用数据访问
 * ========================================================= */
function roleById(id) {
  return state.roles.find(r => r.id === id) || null;
}
function chatOf(roleId) {
  if (!state.chats[roleId]) state.chats[roleId] = [];
  return state.chats[roleId];
}
function lastMessageOf(roleId) {
  const list = state.chats[roleId] || [];
  return list.length ? list[list.length - 1] : null;
}
function unreadTotal() {
  return state.roles.reduce((n, r) => n + (state.unread[r.id] || 0), 0);
}
/* 梦角显示名（界面代称）：优先取该梦角设置的名字，为空时兜底「TA」，避免空白/undefined。
 * 不传 roleId 时取当前会话梦角（多梦角场景文案跟随当前梦角）。 */
function taName(roleId) {
  const r = roleById(roleId || (state && state.activeRoleId)) || (state && state.roles && state.roles[0]);
  return (r && r.name && String(r.name).trim()) || 'TA';
}
function callSummary(call) {
  if (!call) return '通话';
  const nm = taName(call.roleId);
  const who = call.direction === 'in' ? nm + ' 打来' : '我打给 ' + nm;
  const st = call.status === 'answered' ? '已接听' : call.status === 'cancelled' ? '已取消' : '未接听';
  return `${who} · ${st}` + (call.status === 'answered' ? ' · ' + fmtDuration(call.duration || 0) : '');
}
function previewOf(m, role) {
  if (!m) return '还没有聊天记录，先打个招呼吧';
  const dn = (role && role.name && String(role.name).trim()) || 'TA';
  if (m.recalled) return (m.sender ? m.sender === 'user' : m.role === 'user') ? '你撤回了一条消息' : dn + '撤回了一条消息';
  if (m.type === 'pat') return '[拍一拍]';
  if (m.type === 'sticker') return '[表情]';
  if (m.type === 'quiz') return '[问卷] ' + ((m.quiz && m.quiz.title) || '');
  if (m.type === 'quizAnswer') return '[问卷回答] ' + ((m.quiz && m.quiz.title) || '');
  if (m.type === 'call') return '[通话] ' + callSummary(m.call);
  if (m.type === 'redpacket') return '[转账] ¥' + Number(m.amount || 0).toFixed(2) + ' ' + (m.blessing || '');
  if (m.type === 'gift') return '[礼物] ' + (m.giftName || '');
  if (m.type === 'readInvite') return '[一起读书] ' + ((m.status || 'pending') === 'accepted' ? '共读邀请已接受' : (m.status === 'rejected' ? '共读邀请已拒绝' : '共读邀请'));
  /* 系统提示等旧存文本中的「TA」按当前梦角名字动态替换显示 */
  if (m.role === 'system') return String(m.content || '').replace(/TA/g, dn);
  if (Array.isArray(m.images) && m.images.length) return '[图片]' + (m.content ? ' ' + m.content : '');
  return m.content || '';
}

/* =========================================================
 * 八、消息页
 * ========================================================= */
function renderMessagesPage() {
  const my = state.my;
  $('#page-messages').innerHTML = `
    <div class="topbar">
      <div class="topbar-row">
        <button class="msg-back" id="msgBackHome" onclick="__msgBackHome()" title="回到桌面" aria-label="回到桌面">‹</button>
        <div class="avatar-wrap">${avatarHTML(my.avatar, 40)}</div>
        <div class="me-name">${esc(my.name)}</div>
        <button class="icon-btn" id="btnMsgPlus" title="新建" aria-label="新建">＋</button>
      </div>
      <div class="search-row">
        <div class="search-box">
          <span>🔍</span>
          <input id="convSearch" placeholder="搜索梦角或消息" value="${esc(convSearch)}">
        </div>
      </div>
    </div>
    <div class="conv-list" id="convList"></div>`;

  $('#convSearch').addEventListener('input', e => {
    convSearch = e.target.value;
    renderConversations();
  });
  /* 返回按钮用内联 onclick + 全局 __msgBackHome（已在上方定义），
     innerHTML 重渲染后立即生效，不丢失绑定 */
  $('#btnMsgPlus').addEventListener('click', () => {
    showActionSheet('快捷操作', [
      { label: '＋ 添加梦角', onClick: () => openRoleEditor(null) },
      { label: '📇 前往字卡库', onClick: () => navigate({ page: 'sub', name: 'cards' }) },
      { label: '✅ 全部标记为已读', onClick: () => { state.roles.forEach(r => state.unread[r.id] = 0); persist(); renderConversations(); } }
    ]);
  });
  renderConversations();
}

function renderConversations() {
  const box = $('#convList');
  if (!box) return;
  const q = convSearch.trim().toLowerCase();
  const rows = state.roles.map(role => {
    const last = lastMessageOf(role.id);
    const typing = typingMap.get(role.id);
    return {
      role,
      last,
      ts: last ? last.ts : (role.ts || 0),
      preview: typing ? '正在输入…' : previewOf(last, role),
      unread: state.unread[role.id] || 0
    };
  }).filter(row => {
    if (!q) return true;
    return row.role.name.toLowerCase().includes(q) ||
      row.role.signature.toLowerCase().includes(q) ||
      row.preview.toLowerCase().includes(q);
  }).sort((a, b) => b.ts - a.ts);

  if (!rows.length) {
    box.innerHTML = `<div class="list-tip">${state.roles.length ? '没有找到匹配的会话' : '还没有梦角，去桌面添加一个吧'}</div>`;
    return;
  }
  box.innerHTML = rows.map(({ role, last, unread, preview }) => {
    return `
      <div class="conv-item" data-role="${role.id}">
        <div class="avatar-wrap">
          ${roleAvatarHTML(role, 50)}
        </div>
        <div class="conv-main">
          <div class="conv-top">
            <div class="conv-name">${esc(role.name)}</div>
            <div class="conv-time">${last ? fmtListTime(last.ts) : ''}</div>
          </div>
          <div class="conv-bottom">
            <div class="conv-preview">${esc(preview)}</div>
            ${unread ? `<span class="badge">${unread > 99 ? '99+' : unread}</span>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');
  $$('.conv-item', box).forEach(item => {
    item.addEventListener('click', () => openChat(item.dataset.role));
  });
}

function refreshMessagesPage() {
  if (currentRoute.page === 'messages') renderConversations();
  if (currentRoute.page === 'contacts') renderContactsPage();
}

function openChat(roleId) {
  if (!roleById(roleId)) return;
  state.unread[roleId] = 0;
  state.activeRoleId = roleId;
  persist();
  chatSelectMode = false;
  chatSelectedIds = new Set();
  routeStack = [];
  currentRoute = { page: 'chat', roleId };
  applyRoute();
}

/* =========================================================
 * 九、联系人页
 * ========================================================= */
const MANAGE_ENTRIES = [
  { icon: '📇', name: '字卡库管理', desc: '新增、导入、分组与启用字卡', route: 'cards' },
  { icon: '🖼️', name: '表情包管理', desc: '本地图片或图片链接', route: 'stickers' },
  { icon: '✉️', name: '信件管理', desc: '写给TA的信，收件人可选', route: 'letters' },
  { icon: '📋', name: '问卷模板管理', desc: '保存、查看、再次发送问卷', route: 'quizzes' },
  { icon: '⏳', name: '一起专注', desc: '专注计时与今日完成记录', route: 'pomodoro' },
  { icon: '🧭', name: '梦角定位', desc: '方位、距离与正在做什么', route: 'location' },
  { icon: '💾', name: '存储感知', desc: '占用估算、备份与清空', route: 'storage' },
  { icon: '🎚️', name: '概率与行为', desc: '回复、拼接、来电与接听概率', route: 'probability' },
  { icon: '⚙️', name: '设置', desc: '我的资料、名称与主题色', route: 'settings' }
];

function renderContactsPage() {
  const roleRows = state.roles.map(role => {
    return `
      <div class="contact-item" data-role="${role.id}">
        <div class="avatar-wrap">${roleAvatarHTML(role, 46)}</div>
        <div class="contact-info">
          <div class="contact-name">${esc(role.name)}</div>
          <div class="contact-sig">${esc(role.signature || '还没有签名')}</div>
        </div>
        <div class="contact-btns">
          <button data-call="${role.id}" title="语音通话">📞</button>
          <button data-edit="${role.id}" title="编辑资料">✏️</button>
        </div>
      </div>`;
  }).join('');

  $('#page-contacts').innerHTML = `
    <div class="topbar">
      <div class="topbar-row">
        <div class="me-name">联系人</div>
        <button class="icon-btn" id="btnContactPlus">＋</button>
      </div>
    </div>
    <div class="contacts-scroll">
      <div class="group-title">梦角</div>
      <div class="group-card">
        <button class="add-role" id="btnAddRole">＋ 添加梦角</button>
        ${roleRows || '<div class="empty">还没有梦角，点上方按钮添加</div>'}
      </div>
      <div class="group-title">功能与管理</div>
      <div class="group-card">
        ${MANAGE_ENTRIES.map(en => {
          const badge = en.route === 'letters'
            ? state.letters.filter(l => !l.read).length : 0;
          return `
          <div class="entry" data-entry="${en.route}">
            <div class="entry-icon">${en.icon}</div>
            <div class="entry-text">
              <div class="entry-name">${esc(en.name)}</div>
              <div class="entry-desc">${esc(en.desc.replace(/TA/g, taName()))}</div>
            </div>
            ${badge ? `<span class="entry-badge">${badge > 99 ? '99+' : badge}</span>` : ''}
            <div class="chev">›</div>
          </div>`;
        }).join('')}
      </div>
      <div class="list-tip">本地持久化 + 导出备份 · 不上传云端</div>
    </div>`;

  const addRole = () => openRoleEditor(null);
  $('#btnContactPlus').addEventListener('click', addRole);
  $('#btnAddRole').addEventListener('click', addRole);

  $$('.contact-item', $('#page-contacts')).forEach(item => {
    item.addEventListener('click', e => {
      if (e.target.closest('[data-call]') || e.target.closest('[data-edit]')) return;
      openChat(item.dataset.role);
    });
  });
  $$('[data-edit]', $('#page-contacts')).forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); openRoleEditor(btn.dataset.edit); });
  });
  $$('[data-call]', $('#page-contacts')).forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); startOutgoingCall(btn.dataset.call); });
  });
  $$('[data-entry]', $('#page-contacts')).forEach(el => {
    el.addEventListener('click', () => navigate({ page: 'sub', name: el.dataset.entry }));
  });
}

/* =========================================================
 * 十、空间页
 * ========================================================= */
let spaceDraftText = '';
/* 空间动态草稿图：支持一次发布多张（最多 9 张），顺序即展示顺序 */
let spaceDraftImages = [];
const MAX_MOMENT_IMAGES = 9;

function renderSpacePage() {
  const my = state.my;
  $('#page-space').innerHTML = `
    <!-- 区块 1：顶部导航栏（含发布入口「+」） -->
    <div class="space-header">
      <button class="back-btn" id="spaceBackHome" title="回到桌面">‹</button>
      <div class="space-title">空间</div>
      <button class="space-pub-btn" id="spacePlusBtn" title="发布动态" aria-label="发布动态">+</button>
    </div>
    <!-- 区块 2：封面壁纸区 -->
    <div class="space-banner"></div>
    <!-- 区块 3：个人信息栏（Banner 下方，靠右显示头像 + 名字） -->
    <div class="space-meta">
      <div class="nm">${esc(my.name)}</div>
      ${avatarHTML(my.avatar, 46)}
    </div>
    <!-- 区块 4：动态列表区（朋友圈纯列表，独立滚动） -->
    <div class="space-feed">
      <div id="momentList"></div>
    </div>`;

  $('#spaceBackHome').addEventListener('click', () => switchTab('home'));
  /* 点击「+」进入发布页（push 到 routeStack，取消发布时可直接 goBack()） */
  $('#spacePlusBtn').addEventListener('click', () => navigate({ page: 'publish' }));

  renderMoments();
  applyBeautify();
}

/* ====== 发布动态页（独立全屏页） ====== */
function renderPublishPage() {
  const my = state.my;
  /* 用全局草稿状态，保证在 space 与 publish 两页间切换时草稿不丢失 */
  $('#page-space-publish').innerHTML = `
    <div class="pub-header">
      <button class="pub-cancel" id="pubCancel">取消</button>
      <div class="pub-title">发布动态</div>
      <button class="pub-save" id="pubSave"${(!spaceDraftText.trim() && !spaceDraftImages.length) ? ' disabled' : ''}>发布</button>
    </div>
    <div class="pub-body">
      <textarea class="pub-textarea" id="pubText" placeholder="这一刻的想法…">${esc(spaceDraftText)}</textarea>
      <div class="pub-grids" id="pubGrids">
        ${spaceDraftImages.map((src, i) => `
          <div class="pub-grid-item">
            <img src="${esc(src)}" alt="" data-preview="${i}">
            <button class="pub-grid-del" data-pub-del="${i}" title="删除">✕</button>
          </div>`).join('')}
        ${spaceDraftImages.length < MAX_MOMENT_IMAGES ? `<div class="pub-add" id="pubAddImg">+</div>` : ''}
      </div>
    </div>`;

  /* 文本输入 → 实时同步全局草稿 + 动态启用/禁用发布按钮 */
  const ta = $('#pubText');
  const refreshSaveEnabled = () => {
    const saveBtn = $('#pubSave');
    if (!saveBtn) return;
    saveBtn.disabled = (!spaceDraftText.trim() && !spaceDraftImages.length);
  };
  ta.addEventListener('input', () => { spaceDraftText = ta.value; refreshSaveEnabled(); });

  /* 取消：直接返回（routeStack 中 publish 是从 space push 过来的，goBack() 自动回到 space） */
  $('#pubCancel').addEventListener('click', () => {
    /* 取消时保留草稿——用户可能中途放弃、下次还想接着写；
       如果要彻底清空草稿，把下面这两行取消注释即可： */
    // spaceDraftText = '';
    // spaceDraftImages = [];
    goBack();
  });

  /* 发布：复用 publishMoment 已有逻辑，它内部会清空草稿并 showToast */
  $('#pubSave').addEventListener('click', () => {
    publishMoment();
    /* publishMoment 里调用了 renderSpacePage() 但不会自动切回 space 路由，
       这里手动 goBack() 让用户看到刷新后的动态列表 */
    goBack();
  });

  /* 添加图片（复用 pickImages） */
  $('#pubAddImg').addEventListener('click', async () => {
    const remain = MAX_MOMENT_IMAGES - spaceDraftImages.length;
    if (remain <= 0) { showToast('最多上传 9 张'); return; }
    const list = await pickImages(800, .7);
    if (!list.length) return;
    const room = MAX_MOMENT_IMAGES - spaceDraftImages.length;
    spaceDraftImages = spaceDraftImages.concat(list.slice(0, room));
    if (list.length > room) showToast('最多上传 9 张');
    renderPublishPage();
  });

  /* 单张图片删除 */
  $$('[data-pub-del]').forEach(btn => btn.addEventListener('click', () => {
    spaceDraftImages.splice(Number(btn.dataset.pubDel), 1);
    renderPublishPage();
  }));

  /* 发布页的草稿缩略图点击不做大图预览（避免引入未实现的 zoom 依赖）；
     如需预览，可在动态发布后在空间 feed 中点击完整大图 */
  $$('.pub-grid-item img').forEach(img => {
    img.onerror = () => imgFallback(img);
  });
}

function renderMoments() {
  const box = $('#momentList');
  if (!box) return;
  const my = state.my;
  const list = state.moments.slice().sort((a, b) => b.ts - a.ts);

  if (!list.length) {
    box.innerHTML = '<div class="empty">空间还是空的<br>发布第一条动态，让' + esc(taName()) + '看见你</div>';
    return;
  }

  box.innerHTML = list.map(m => {
    const liked = m.likes.includes('me');
    const comments = m.comments || [];
    const imgs = Array.isArray(m.images) && m.images.length
      ? m.images.slice(0, MAX_MOMENT_IMAGES)
      : (m.image ? [m.image] : []);
    const gridCls = imgs.length === 1 ? 'one' : (imgs.length >= 5 ? 'nine' : 'multi');
    /* TA 主动发布的动态归属随机梦角：显示该梦角的头像与名字 */
    const author = m.fromTa ? (roleById(m.fromRoleId) || null) : null;
    const headAvatar = author ? author.avatar : my.avatar;
    const headName = author ? author.name : my.name;
    return `
      <div class="moment" data-moment="${m.id}">
        <div class="moment-head">
          ${avatarHTML(headAvatar, 38)}
          <div class="moment-name">${esc(headName)}</div>
          <div class="moment-time">${fmtMsgTime(m.ts)}</div>
        </div>
        ${m.text ? `<div class="moment-text">${esc(m.text)}</div>` : ''}
        ${imgs.length ? `<div class="moment-images ${gridCls}">
          ${imgs.map((src, i) => `<div class="moment-img"><img src="${esc(src)}" alt="" data-zoom="${m.id}" data-idx="${i}"></div>`).join('')}
        </div>` : ''}
        <div class="moment-ops">
          <button data-like="${m.id}" class="${liked ? 'liked' : ''}">${liked ? '❤️' : '🤍'} ${m.likes.length}</button>
          <button data-comment-focus="${m.id}">💬 ${comments.length}</button>
          <button data-del-moment="${m.id}" style="margin-left:auto">删除</button>
        </div>
        ${comments.length ? `<div class="moment-comments">
          ${comments.map(c => {
            const isTa = c.sender === 'ta';
            /* 回复前缀：replyTo='user' → @我；replyTo='ta' → @该动态下 TA 的名字 */
            let replyPrefix = '';
            if (c.replyTo === 'user') replyPrefix = `<span class="reply-prefix">回复 @${esc(state.my.name)}：</span>`;
            else if (c.replyTo === 'ta') {
              const taName = (m.fromTa ? headName : (comments.find(x => x.sender === 'ta' && x.name) || {}).name) || taName();
              replyPrefix = `<span class="reply-prefix">回复 @${esc(taName)}：</span>`;
            }
            return `<div class="comment"><b class="comment-${isTa ? 'ta' : 'user'}-name">${esc(c.name)}</b>${replyPrefix}${esc(c.text)}</div>`;
          }).join('')}
        </div>` : ''}
        <div class="comment-input-row">
          <input data-comment-input="${m.id}" placeholder="说点什么…" maxlength="120">
          <button data-comment-send="${m.id}">发送</button>
        </div>
      </div>`;
  }).join('');

  $$('[data-like]', box).forEach(btn => {
    btn.addEventListener('click', () => {
      const m = state.moments.find(x => x.id === btn.dataset.like);
      if (!m) return;
      if (m.likes.includes('me')) m.likes = m.likes.filter(x => x !== 'me');
      else m.likes.push('me');
      persist();
      renderMoments();
    });
  });

  $$('[data-comment-focus]', box).forEach(btn => {
    btn.addEventListener('click', () => {
      const input = $(`[data-comment-input="${btn.dataset.commentFocus}"]`, box);
      if (input) input.focus({ preventScroll: true });
    });
  });

  $$('[data-comment-send]', box).forEach(btn => {
    btn.addEventListener('click', () => sendComment(btn.dataset.commentSend));
  });
  $$('[data-comment-input]', box).forEach(input => {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); sendComment(input.dataset.commentInput); }
    });
  });

  $$('[data-del-moment]', box).forEach(btn => {
    btn.addEventListener('click', async () => {
      const m = state.moments.find(x => x.id === btn.dataset.delMoment);
      if (!m) return;
      const ok = await confirmDialog('删除动态', '删除后无法恢复，确定要删除这条动态吗？', '删除', true);
      if (!ok) return;
      state.moments = state.moments.filter(x => x.id !== m.id);
      persist();
      renderMoments();
    });
  });

  $$('[data-zoom]', box).forEach(img => {
    img.addEventListener('click', () => {
      const m = state.moments.find(x => x.id === img.dataset.zoom);
      if (!m) return;
      const arr = Array.isArray(m.images) && m.images.length ? m.images : (m.image ? [m.image] : []);
      if (!arr.length) return;
      const idx = clamp(Number(img.dataset.idx) || 0, 0, arr.length - 1);
      showLightbox(arr[idx], arr, idx);
    });
  });
  $$('.moment-images img', box).forEach(img => { img.onerror = () => imgFallback(img); });
}

function sendComment(momentId) {
  const input = $(`[data-comment-input="${momentId}"]`);
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  const m = state.moments.find(x => x.id === momentId);
  if (!m) return;
  /* 如果该动态里已有 TA 的评论，则本条视为「回复 TA」；否则为顶级评论 */
  const taCommentExists = (m.comments || []).some(c => c.sender === 'ta');
  const replyTo = taCommentExists ? 'ta' : '';
  m.comments.push({
    id: uid(), who: 'me', sender: 'user', name: state.my.name,
    text, replyTo, ts: Date.now()
  });
  persist();
  renderMoments();

  /* ===== TA 追评互动 =====
     触发条件：在 TA 的动态下评论，或本条是在回复 TA 之前的评论
     固定 60% 概率；1.5~3 秒延迟；复用主聊天字卡抽取逻辑（受全局拼字卡概率控制） */
  const shouldTrigger = m.fromTa === true || taCommentExists;
  if (shouldTrigger && Math.random() < 0.6) {
    const delay = randInt(1500, 3000);
    setTimeout(() => {
      const cur = state.moments.find(x => x.id === momentId);
      if (!cur) return;
      const role = roleById(cur.interactRoleId) || (state.roles.length ? pickOne(state.roles) : null);
      if (!role) return;
      const replyText = composeCardText(role.id);
      if (!replyText) return;    /* 字卡库为空则不追评，保持原有全功能统一策略 */
      cur.comments.push({
        id: uid(), who: role.id, sender: 'ta', name: role.name,
        text: replyText, replyTo: 'user', ts: Date.now()
      });
      persist();
      if (currentRoute.page === 'space') renderMoments();
    }, delay);
  }
}

function publishMoment() {
  /* 统一使用全局草稿：spaceDraftText / spaceDraftImages
     （发布页 pubText 的 input 事件已实时同步 spaceDraftText） */
  const text = String(spaceDraftText || '').trim();
  const images = (Array.isArray(spaceDraftImages) ? spaceDraftImages.slice() : []).slice(0, MAX_MOMENT_IMAGES);
  if (!text && !images.length) { showToast('写点什么或选一张图片吧'); return; }
  const moment = {
    id: uid(),
    text,
    images,
    /* 兼容旧字段：首图仍写入 image */
    image: images[0] || '',
    likes: [],
    comments: [],
    ts: Date.now()
  };
  /* 安排一次 TA 互动判定：随机梦角 + 5 秒~2 分钟后的时间戳，刷新不丢失 */
  if (state.roles.length) {
    moment.interactRoleId = pickOne(state.roles).id;
    moment.interactAt = Date.now() + randInt(5, 120) * 1000;
    moment.interacted = false;
  } else {
    moment.interactRoleId = '';
    moment.interactAt = 0;
    moment.interacted = true;
  }
  state.moments.push(moment);
  spaceDraftText = '';
  spaceDraftImages = [];
  persist();
  showToast('已发布');
}

/* 到点执行 TA 互动判定：点赞/评论独立按概率判定，每条动态只判一次；
 * 点赞与评论同样按「回复时间」延迟落地，与聊天消息保持一致。 */
function checkMomentInteractions() {
  if (!state || !Array.isArray(state.moments)) return;
  const now = Date.now();
  let changed = false;
  state.moments.forEach(m => {
    if (m.interacted || !m.interactAt || m.interactAt > now) return;
    m.interacted = true;
    changed = true;
    const role = roleById(m.interactRoleId) || (state.roles.length ? pickOne(state.roles) : null);
    if (!role) return;
    const apply = () => {
      if (!roleById(role.id)) return;
      let liked = false;
      let commentText = '';
      if (Math.random() * 100 < Number(state.settings.spaceLikeChance ?? 50)) {
        if (!m.likes.includes(role.id)) { m.likes.push(role.id); liked = true; }
      }
      if (Math.random() * 100 < Number(state.settings.spaceCommentChance ?? 30)) {
        const text = composeCardText(role.id);
        if (text) {
          m.comments.push({ id: uid(), who: role.id, sender: 'ta', name: role.name, text, replyTo: '', ts: Date.now() });
          commentText = text;
        }
      }
      /* 同一条动态只发一条空间通知：有评论就报评论，否则报点赞，避免重复打扰 */
      if (commentText) notifySpaceInteraction(role, 'comment', commentText);
      else if (liked) notifySpaceInteraction(role, 'like');
      persist();
      if (currentRoute.page === 'space') renderMoments();
    };
    const delay = replyDelayMs();
    if (delay > 0) setTimeout(apply, delay); else apply();
  });
  if (changed) {
    persist();
    if (currentRoute.page === 'space') renderMoments();
  }
}

/* =========================================================
 * 字卡主动回复：不需要用户先发消息，TA 到点主动抽字卡发消息。
 * 时间戳驱动（state.nextProactiveAt），周期检查里调用，刷新不丢节奏；
 * 与用户发消息后的回复判定完全独立；通话/来电中不弹界面、正常入聊天；
 * 字卡为空时直接跳过（不发空消息），全功能统一此策略。
 * ========================================================= */
function nextProactiveDelay() {
  const st = state ? state.settings : {};
  const min = clamp(Number(st.proactiveMin) || 10, 1, 240);
  const max = clamp(Number(st.proactiveMax) || 30, min, 240);
  return randInt(min, max) * 60 * 1000;
}

function checkProactiveMessages() {
  if (!state) return;
  const now = Date.now();
  if (!state.nextProactiveAt) {
    /* 首次初始化：只安排节奏，不立即补发 */
    state.nextProactiveAt = now + nextProactiveDelay();
    persist();
    return;
  }
  if (now < state.nextProactiveAt) return;
  /* 到点：先重排下一次判定（开关关闭也照排，避免重开时立即补发） */
  state.nextProactiveAt = now + nextProactiveDelay();
  persist();
  if (state.settings.proactiveEnabled === false) return;
  const chance = Number(state.settings.proactiveChance ?? 20);
  if (chance <= 0) return;
  state.roles.forEach(role => {
    if (!role || !role.id) return;
    if (Math.random() * 100 >= chance) return;
    /* 字卡库为空时主动回复直接不发，避免空消息；有字卡则按连发规则发送 */
    const hasCards = state.cards.some(c => c.enabled !== false && c.content && c.content.trim());
    if (!hasCards) return;
    sendTaBurst(role.id, { makeText: prev => composeUniqueReply(role.id, prev) });
  });
  refreshMessagesPage();
}

/* =========================================================
 * 十一、聊天页与字卡回复
 * ========================================================= */
const typingMap = new Map();       // roleId -> 是否正在输入
const replyQueue = new Map();      // roleId -> 待回复条数
const replyBusy = new Map();       // roleId -> 是否正在处理回复
const chatGenMap = new Map();      // roleId -> 会话代次（清空后丢弃旧回调）
/* 当前引用中的消息（仅本页内存态，发送后清空）：{id, roleId, text, who, mine} */
let chatQuote = null;
/* 长按菜单刚弹出的时间戳：用于吞掉长按结束后的 click，避免误触表情大图 */
let bubbleMenuAt = 0;

/* 引用预览条：有引用时显示在输入框上方 */
function renderQuoteBar() {
  const bar = $('#chatQuoteBar');
  if (!bar) return;
  if (!chatQuote) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  $('#cqWho').textContent = chatQuote.who || '';
  $('#cqText').textContent = chatQuote.text || '';
}

/* 消息可引用时的预览文本：不同消息类型给不同占位 */
function quoteTextOf(m) {
  if (!m) return '';
  if (m.recalled) return '已撤回的消息';
  if (m.type === 'sticker') return '[表情]';
  if (m.type === 'redpacket') return '[转账] ¥' + Number(m.amount || 0).toFixed(2);
  if (m.type === 'gift') return '[礼物] ' + (m.giftName || '');
  if (m.type === 'call') return '[通话]';
  if (m.type === 'quiz') return '[问卷]';
  if (m.type === 'quizAnswer') return '[问卷回答]';
  if (m.type === 'pat') return '[拍一拍]';
  if (Array.isArray(m.images) && m.images.length) return '[图片]' + (m.content ? ' ' + String(m.content).slice(0, 50) : '');
  return String(m.content || '').slice(0, 60);
}

/* 复制消息到剪贴板的完整文本（与 quoteTextOf 区分：直接取完整 content，不做长度截断） */
function copyTextOf(m) {
  if (!m) return '';
  if (m.recalled) return '已撤回的消息';
  /* 图片 / 表情 / 红包 / 礼物 / 通话 / 问卷 / 问卷回答 / 拍一拍 —— 这些类型没有可复制的文本 body，
     只复制它们附带的 content（图片消息里可能有配文），不凭空造 "[表情]" 这类伪文本 */
  if (m.type === 'sticker' || m.type === 'image' || Array.isArray(m.images)) {
    return String(m.content || '').trim();  /* 空字符串 → 复制失败提示"无法复制图片" */
  }
  if (m.type === 'redpacket') return '[转账] ¥' + Number(m.amount || 0).toFixed(2);
  if (m.type === 'gift') return '[礼物] ' + (m.giftName || '');
  if (m.type === 'call') return '[通话]';
  if (m.type === 'quiz') return (m.quiz && m.quiz.title) ? ('[问卷] ' + m.quiz.title) : '[问卷]';
  if (m.type === 'quizAnswer') return (m.quiz && m.quiz.title) ? ('[问卷回答] ' + m.quiz.title) : '[问卷回答]';
  if (m.type === 'pat') return '[拍一拍]';
  /* 普通 text / 带引用块的 text：只复制用户真正发送的那段 content，不包含引用块（quote 是独立字段） */
  return String(m.content || '');
}

/* 写入剪贴板：优先现代 Clipboard API（安全上下文 + 用户手势内调用），
   失败再走 execCommand('copy') 兜底；两者都失败时返回 false，由上层提示手动复制 */
async function copyToClipboard(text) {
  if (!text) return false;
  /* 现代 Clipboard API：必须 secure context（HTTPS / localhost）且在用户手势链内调用
     iOS Safari 在非 HTTPS 下 navigator.clipboard 可能直接 undefined */
  const hasClipboard = typeof navigator !== 'undefined'
    && navigator.clipboard
    && typeof navigator.clipboard.writeText === 'function';
  if (hasClipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) { /* 某些浏览器（旧版 iOS）即使 API 存在也会 reject：权限/安全上下文问题 → 走兜底 */ }
  }
  /* 传统兜底：动态 textarea + select + execCommand('copy')
     已废弃但在 iOS / 旧版 Android / 非 HTTPS 环境仍可用 */
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return !!ok;
  } catch (_) {
    return false;
  }
}

function bumpChatGen(roleId) {
  chatGenMap.set(roleId, (chatGenMap.get(roleId) || 0) + 1);
}

function renderChatPage(roleId) {
  const role = roleById(roleId);
  if (!role) { currentRoute = { page: 'messages' }; applyRoute(); return; }
  /* 每次进入聊天页都从「最近 50 条」重新开始：上次展开过的更早消息不延续，
     避免第二次进入又把几百条历史一次性建出来 */
  chatRenderRole = null;
  chatRenderLimit = CHAT_PAGE_SIZE;
  applyRoleTheme(role);
  /* 当前梦角显示名：名字为空时兜底「TA」 */
  const dn = String(role.name || '').trim() || 'TA';

  $('#page-chat').innerHTML = `
    <div class="chat-nav">
      <button class="back-btn" data-back>‹</button>
      <div class="avatar-wrap" id="chatTopAvatar">${roleAvatarHTML(role, 36)}</div>
      <div class="name-wrap">
        <div class="name">${esc(dn)}</div>
        <div class="typing-hint" id="chatTypingHint">正在输入…</div>
      </div>
      <button class="nav-ico" id="btnCallNav" title="语音通话" aria-label="语音通话">${APP_ICONS.phone}</button>
      <button class="nav-ico" id="btnChatMenu" title="快捷菜单" aria-label="快捷菜单">${APP_ICONS.kebab}</button>
    </div>
    <div class="chat-kebab" id="chatKebabMenu">
      <button data-kebab="cards">${APP_ICONS.cards}<span>字卡库</span></button>
      <button data-kebab="pat">${APP_ICONS.pat}<span>拍一拍设置</span></button>
      <button data-kebab="probability">${APP_ICONS.probability}<span>概率与行为</span></button>
      <button data-kebab="stickers">${APP_ICONS.stickers}<span>表情包管理</span></button>
      <button data-kebab="wordcloud">${APP_ICONS.wordcloud}<span>互动词云</span></button>
    </div>
    <div class="chat-scroll" id="chatScroll"><div class="chat-list" id="chatList"></div></div>
    <div class="img-draft-bar" id="imgDraftBar"><div class="img-draft-list" id="imgDraftList"></div></div>
    <div class="chat-plus-panel" id="chatPlusPanel">
      <div class="plus-grid">
        <button class="plus-cell" data-plus="redpacket"><span>${APP_ICONS.redpackets}</span>转账</button>
        <button class="plus-cell" data-plus="gift"><span>${APP_ICONS.gifts}</span>送礼物</button>
        <button class="plus-cell" data-plus="quiz"><span>${APP_ICONS.quizzes}</span>问卷</button>
        <button class="plus-cell" data-plus="ledger"><span>${APP_ICONS.ledger}</span>记账</button>
        <button class="plus-cell" data-plus="snapshot"><span>${APP_ICONS.snapshots}</span>留影</button>
        <button class="plus-cell" data-plus="read"><span>${APP_ICONS.readtogether}</span>邀请一起读</button>
      </div>
    </div>
    <div class="chat-quote-bar hidden" id="chatQuoteBar">
      <div class="cq-body">
        <div class="cq-who" id="cqWho"></div>
        <div class="cq-text" id="cqText"></div>
      </div>
      <button class="cq-close" id="cqClose">×</button>
    </div>
    <div class="chat-input" id="chatInputRow">
      <button class="ci-btn" id="btnPlus" title="更多">＋</button>
      <textarea id="chatText" rows="1" placeholder="发消息给 ${esc(dn)}…"></textarea>
      <button class="ci-ico" id="btnSticker" title="表情包" aria-label="表情包">${APP_ICONS.smile}</button>
      <button class="ci-ico" id="btnImage" title="发图片" aria-label="发图片">${APP_ICONS.image}</button>
      <button class="send-btn" id="btnSend">发送</button>
    </div>
    <div class="chat-selectbar hidden" id="chatSelBar">
      <button id="selCancel">取消</button>
      <button id="selRandom">随机选 ${clamp(Number(state.settings.snapshotCount) || 5, 3, 20)}</button>
      <button class="primary" id="selConfirm">确认留影</button>
    </div>`;

  /* 返回按钮必须限定在聊天页内查找：子页面在 DOM 中位于聊天页之前，
     若用全局选择器会命中子页面的返回键，导致聊天页返回键无监听、点了没反应 */
  const chatBackBtn = $('#page-chat .chat-nav [data-back]');
  if (chatBackBtn) chatBackBtn.addEventListener('click', () => {
    setChatSelectMode(false);
    closeChatPlus();
    closeStickerSheet();
    goBack();
  });
  /* 聊天页顶部 TA 头像：单击看「心声胶囊」，双击拍一拍（250ms 定时器分离，互不干扰） */
  const chatAvatar = $('#page-chat .chat-nav .avatar-wrap');
  if (chatAvatar) {
    chatAvatar.style.cursor = 'pointer';
    let avatarTapTimer = null;
    chatAvatar.addEventListener('click', e => {
      e.stopPropagation();
      if (avatarTapTimer) {
        /* 250ms 内第二次点击 → 双击：清掉单击定时器，执行原有的拍一拍 */
        clearTimeout(avatarTapTimer);
        avatarTapTimer = null;
        userPatRole(roleId);
        return;
      }
      /* 第一次点击：先挂起定时器，250ms 内没有第二次点击才按单击处理 */
      avatarTapTimer = setTimeout(() => {
        avatarTapTimer = null;
        /* 顶部头像：取聊天记录中最后一条 TA 消息的心声，没有则兜底随机 */
        showTaStatusCard(roleId, heartTagsOfMessage(lastTaMessage(roleId)));
      }, 250);
    });
  }
  $('#btnPlus').addEventListener('click', e => {
    e.stopPropagation();
    toggleChatPlus();
  });
  /* 右上角竖三点快捷菜单：字卡库 / 拍一拍设置 / 概率与行为 / 表情包管理 */
  const kebab = $('#chatKebabMenu');
  $('#btnChatMenu').addEventListener('click', e => {
    e.stopPropagation();
    closeChatPlus();
    closeStickerSheet();
    kebab.classList.toggle('open');
  });
  $$('[data-kebab]', kebab).forEach(btn => btn.addEventListener('click', () => {
    kebab.classList.remove('open');
    navigate({ page: 'sub', name: btn.dataset.kebab });
  }));
  /* 右上角电话图标：发起原有「我打给TA」拨号流程 */
  $('#btnCallNav').addEventListener('click', () => startOutgoingCall(roleId));
  /* 输入框右侧内侧：表情包（弹原有表情面板）与发图片（选择方式） */
  $('#btnSticker').addEventListener('click', e => {
    e.stopPropagation();
    kebab.classList.remove('open');
    toggleStickerSheet(roleId);
  });
  $('#btnImage').addEventListener('click', e => {
    e.stopPropagation();
    kebab.classList.remove('open');
    closeChatPlus();
    closeStickerSheet();
    showActionSheet('发图片', [
      { label: '拍照', onClick: () => pickChatImages(roleId, true) },
      { label: '从相册选择', onClick: () => pickChatImages(roleId, false) }
    ]);
  });
  $$('[data-plus]', $('#chatPlusPanel')).forEach(btn => btn.addEventListener('click', () => {
    const kind = btn.dataset.plus;
    closeChatPlus();
    if (kind === 'redpacket') openRedPacketComposer(roleId);
    else if (kind === 'gift') openGiftComposer(roleId);
    else if (kind === 'ledger') enterLedgerMode(roleId);
    else if (kind === 'snapshot') setChatSelectMode(true);
    else if (kind === 'read') inviteReadTogether(roleId, 'chat');
    else if (kind === 'quiz') { pendingQuizRoleId = roleId; navigate({ page: 'sub', name: 'quiz-new' }); }
  }));
  $('#selCancel').addEventListener('click', () => setChatSelectMode(false));
  $('#selRandom').addEventListener('click', () => randomSelectChat(roleId));
  $('#selConfirm').addEventListener('click', () => confirmChatSnapshot(roleId));

  const ta = $('#chatText');
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(88, ta.scrollHeight) + 'px';
  });
  ta.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    /* 中文输入法选词中按 Enter 只是选词，绝不能触发发送 */
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    sendChatText(roleId);
  });
  /* 发送按钮只绑 click，不绑 touchstart/touchend，避免双触发与延迟；也不做防抖 */
  $('#btnSend').addEventListener('click', () => sendChatText(roleId));
  $('#cqClose').addEventListener('click', () => { chatQuote = null; renderQuoteBar(); });
  if (chatQuote && chatQuote.roleId !== roleId) chatQuote = null;
  renderQuoteBar();

  /* 进入聊天页时恢复输入态，并同步选择模式/加号面板/图片预览/typing小字 */
  const bar = $('#chatSelBar');
  const inputRow = $('#chatInputRow');
  if (bar) bar.classList.toggle('hidden', !chatSelectMode);
  if (inputRow) inputRow.classList.toggle('hidden', chatSelectMode);
  renderImgDraftBar(roleId);
  const hint0 = $('#chatTypingHint');
  if (hint0) hint0.classList.toggle('show', !!typingMap.get(roleId) && !chatSelectMode);

  applyBeautify();
  /* 先让页面结构（导航 / 消息区 / 输入框）切过去，再在下一帧渲染消息：
     避免「一次性建 DOM」和页面切换抢同一帧，导致点进来先卡住、后显示 */
  requestAnimationFrame(() => {
    if (currentRoute.page === 'chat' && currentRoute.roleId === roleId) renderChatMessages();
  });
}

/* 聊天页“+”面板 / 留影选择模式 */
let chatPlusOpen = false;
let chatSelectMode = false;
let chatSelectedIds = new Set();

function toggleChatPlus() {
  chatPlusOpen = !chatPlusOpen;
  const panel = $('#chatPlusPanel');
  if (panel) panel.classList.toggle('open', chatPlusOpen);
  if (chatPlusOpen) { closeStickerSheet(); const kb = $('#chatKebabMenu'); if (kb) kb.classList.remove('open'); }
}

function closeChatPlus() {
  chatPlusOpen = false;
  const panel = $('#chatPlusPanel');
  if (panel) panel.classList.remove('open');
}

function setChatSelectMode(on) {
  chatSelectMode = !!on;
  chatSelectedIds = new Set();
  closeChatPlus();
  closeStickerSheet();
  const bar = $('#chatSelBar');
  const inputRow = $('#chatInputRow');
  if (bar) bar.classList.toggle('hidden', !chatSelectMode);
  if (inputRow) inputRow.classList.toggle('hidden', chatSelectMode);
  renderChatMessages();
}

function chatSelectableMessages(roleId) {
  /* 已撤回的消息不可勾选留影 */
  return chatOf(roleId).filter(m => !m.recalled && m.role !== 'system');
}

function randomSelectChat(roleId) {
  const pool = chatSelectableMessages(roleId).slice(-40);
  if (!pool.length) { showToast('聊天记录太少，暂时无法留影'); return; }
  const n = clamp(Number(state.settings.snapshotCount) || 5, 3, 20);
  chatSelectedIds = new Set(pickMany(pool, Math.min(n, pool.length)).map(m => m.id));
  renderChatMessages();
}

function confirmChatSnapshot(roleId) {
  const msgs = chatOf(roleId).filter(m => chatSelectedIds.has(m.id));
  if (!msgs.length) { showToast('请先勾选要留影的消息'); return; }
  msgs.sort((a, b) => a.ts - b.ts);
  saveSnapshot(roleId, snapshotItemsFrom(msgs), '我');
  setChatSelectMode(false);
  showToast('已留影这一刻');
}

/* =========================================================
 * 聊天消息分页 + 事件委托
 * 默认只渲染最近 CHAT_PAGE_SIZE 条，更早的由顶部按钮追加渲染，
 * 避免一次进入聊天页就把全部历史消息建成 DOM 卡住主线程
 * ========================================================= */
const CHAT_PAGE_SIZE = 50;
let chatRenderRole = null;
let chatRenderLimit = CHAT_PAGE_SIZE;
/* 气泡旁 TA 头像的单击/双击定时器（250ms 内无第二次点击算单击） */
let msgAvatarTapTimer = null;

function loadOlderMessages() {
  const sc = $('#chatScroll');
  const prevTop = sc ? sc.scrollTop : 0;
  const prevHeight = sc ? sc.scrollHeight : 0;
  chatRenderLimit += CHAT_PAGE_SIZE;
  renderChatMessages();
  /* 追加的是上方内容：按新增高度补偿滚动位置，视线停在原处 */
  if (sc) sc.scrollTop = prevTop + (sc.scrollHeight - prevHeight);
}

/* 消息列表事件委托：图片看大图 / 领取红包与礼物 / 头像拍一拍 / 多选勾选 / 查看更早消息。
   只在 #chatList 上绑定一次，不管渲染多少条消息都只有一个监听 */
function ensureChatDelegation(list) {
  if (!list || list.dataset.delegated === '1') return;
  list.dataset.delegated = '1';
  list.addEventListener('click', e => {
    const t = e.target;
    const roleId = currentRoute.roleId;
    if (t.closest('#chatMoreBtn')) { loadOlderMessages(); return; }
    const rp = t.closest('[data-rpclaim]');
    if (rp) { e.stopPropagation(); claimRedPacket(roleId, rp.dataset.rpclaim); return; }
    const gift = t.closest('[data-giftclaim]');
    if (gift) { e.stopPropagation(); claimGift(roleId, gift.dataset.giftclaim); return; }
    /* 共读邀请卡片：接受 / 拒绝 */
    const rdAccept = t.closest('[data-readaccept]');
    if (rdAccept) { e.stopPropagation(); acceptReadInvite(roleId, rdAccept.dataset.readaccept); return; }
    const rdReject = t.closest('[data-readreject]');
    if (rdReject) { e.stopPropagation(); rejectReadInvite(roleId, rdReject.dataset.readreject); return; }
    const ava = t.closest('[data-avapat]');
    if (ava) {
      e.stopPropagation();
      /* 气泡旁 TA 头像：与顶部头像同一套 250ms 判定，单击看心声、双击拍一拍 */
      if (msgAvatarTapTimer) {
        clearTimeout(msgAvatarTapTimer);
        msgAvatarTapTimer = null;
        userPatRole(roleId);
        return;
      }
      msgAvatarTapTimer = setTimeout(() => {
        msgAvatarTapTimer = null;
        /* 气泡头像：直接读这条消息里存的心声（同一轮连发的多条完全一致），
           旧数据没有该字段时兜底生成并写回这条消息 */
        const msg = chatOf(roleId).find(x => x.id === ava.dataset.avapat);
        showTaStatusCard(roleId, heartTagsOfMessage(msg));
      }, 250);
      return;
    }
    const sticker = t.closest('[data-sticker-img]');
    if (sticker) {
      if (Date.now() - bubbleMenuAt < 700) return;
      showLightbox(sticker.src);
      return;
    }
    const img = t.closest('[data-chatimg]');
    if (img) {
      if (Date.now() - bubbleMenuAt < 700) return;
      const msg = chatOf(roleId).find(x => x.id === img.dataset.chatimg);
      const arr = msg && Array.isArray(msg.images) && msg.images.length ? msg.images : [img.src];
      showLightbox(img.src, arr, Number(img.dataset.imgidx) || 0);
      return;
    }
    if (chatSelectMode) {
      const el = t.closest('.msg[data-mid]');
      if (!el) return;
      const id = el.dataset.mid;
      if (chatSelectedIds.has(id)) chatSelectedIds.delete(id); else chatSelectedIds.add(id);
      renderChatMessages();
    }
  });
}

function renderChatIf(roleId) {
  if (currentRoute.page === 'chat' && currentRoute.roleId === roleId) renderChatMessages();
}

function renderChatMessages() {
  const list = $('#chatList');
  if (!list) return;
  const roleId = currentRoute.roleId;
  const role = roleById(roleId);
  if (!role) return;
  /* 当前梦角显示名：动态渲染，切换梦角/改名后立即生效 */
  const dn = String(role.name || '').trim() || 'TA';
  const msgs = chatOf(roleId);
  /* 只渲染最近 50 条：几百上千条一次性建 DOM 是进入聊天页卡顿的主因 */
  if (chatRenderRole !== roleId) { chatRenderRole = roleId; chatRenderLimit = CHAT_PAGE_SIZE; }
  const startIdx = Math.max(0, msgs.length - chatRenderLimit);
  const visible = startIdx > 0 ? msgs.slice(startIdx) : msgs;
  let html = '';
  /* 窗口首条的时间分隔用「窗口前一条」的时间做基准，展开时不会多出/漏掉分隔 */
  let lastTs = startIdx > 0 ? msgs[startIdx - 1].ts : 0;
  const lastUserIndex = (() => {
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') return i;
    return -1;
  })();

  if (startIdx > 0) {
    html += `<div class="chat-more"><button id="chatMoreBtn" type="button">查看更早的消息（还有 ${startIdx} 条）</button></div>`;
  }

  visible.forEach((m, vi) => {
    const i = startIdx + vi;
    if (!lastTs || m.ts - lastTs > 5 * 60 * 1000) {
      html += `<div class="time-sep">${fmtMsgTime(m.ts)}</div>`;
    }
    lastTs = m.ts;

    if (m.type === 'pat') {
      /* 拍一拍：居中的浅色系统行，谁拍谁、可带单张字卡后缀 */
      html += `<div class="msg pat-msg-row" data-mid="${m.id}">
        <div class="msg-body" style="align-items:center;max-width:88%">
          <div class="pat-msg">${esc(patTextOf(m, dn))}</div>
          <div style="font-size:10px;opacity:.6;margin-top:2px">${fmtMsgTime(m.ts)}</div>
        </div>
      </div>`;
      return;
    }

    if (m.role === 'system') {
      const isCall = m.type === 'call' && m.call;
      /* 旧存的系统提示文本若含「TA」，按当前梦角名字动态替换显示 */
      const sysText = isCall ? callSummary(m.call) : String(m.content || '').replace(/TA/g, dn);
      html += `<div class="msg" data-mid="${m.id}" style="justify-content:center;width:100%">
        <div class="msg-body" style="align-items:center;max-width:88%">
          <div class="bubble ${isCall ? 'call-bubble' : ''}" style="background:var(--primary-soft);color:var(--primary-dark);border-radius:12px;font-size:13px;text-align:center">
            <div class="${isCall ? 'cl-t' : ''}">${isCall ? '📞 ' : ''}${esc(sysText)}</div>
            <div class="${isCall ? 'cl-s' : ''}" style="${isCall ? '' : 'font-size:10px;opacity:.65;margin-top:2px'}">${fmtMsgTime(m.ts)}</div>
          </div>
        </div>
      </div>`;
      return;
    }

    const mine = m.sender ? m.sender === 'user' : m.role === 'user';
    /* 被引用的原文：显示在气泡内部上方 */
    const q = m.quote;
    const quoteHTML = q
      ? `<div class="quote-block"><span class="quote-who">${esc(q.who || '')}</span><span class="quote-text">${esc(q.text || '')}</span></div>`
      : '';
    let inner = '';
    /* 已撤回：气泡内容整块替换为灰色提示 */
    if (m.recalled) {
      inner = `<div class="recall-tip">${mine ? '你' : esc(dn)}撤回了一条消息</div>`;
    } else if (m.type === 'sticker' && m.image) {
      inner = `<div class="bubble sticker-bubble">${quoteHTML}<img src="${esc(m.image)}" alt="" data-sticker-img></div>`;
    } else if (m.type === 'quiz' && m.quiz) {
      const unanswered = m.isAnswered !== true;
      inner = `${quizCardHTML(m.quiz, null, unanswered ? `已发送给 ${esc(role.name)}，等待回答…` : '已回答', unanswered ? 'unanswered' : '')}`;
    } else if (m.type === 'quizAnswer' && m.quiz) {
      inner = `${quizCardHTML(m.quiz, m.answers || [], '')}`;
    } else if (m.type === 'call' && m.call) {
      inner = `<div class="bubble call-bubble">
        ${quoteHTML}
        <div class="cl-t">📞 ${esc(m.call.direction === 'in' ? dn + ' 打来' : '我打给 ' + dn)}</div>
        <div class="cl-s">${m.call.status === 'answered' ? '已接听 · ' + fmtDuration(m.call.duration || 0) : m.call.status === 'cancelled' ? '已取消' : '未接听'}</div>
      </div>`;
    } else if (m.type === 'redpacket') {
      const incoming = m.direction === 'in';
      const returned = m.returned === true;   /* 24h 未领取已退回：灰白卡片，不可再收款 */
      const claimed = m.claimed === true;
      const extra = m.count > 1 ? ` · ${m.count} 个` : '';
      const status = returned ? '已退回' : (m.receivedCard ? '已收款' : (claimed ? (incoming ? '已收款' : dn + '已收款') : '待收款'));
      const amtNum = Math.round((Number(m.amount) || 0) * 100) / 100;
      const amtTxt = Number.isInteger(amtNum) ? String(amtNum) : amtNum.toFixed(2);
      const amtLen = amtTxt.replace('-', '').length;
      const amtCls = amtLen >= 7 ? ' xlong' : (amtLen >= 5 ? ' long' : '');
      inner = `<div class="bubble redpacket-bubble ${returned ? 'card-returned' : (claimed ? 'rp-received' : 'rp-pending')}">
        ${quoteHTML}
        <div class="rp-title">转账</div>
        <div class="rp-amount${amtCls}">¥ ${esc(amtTxt)}</div>
        <div class="rp-note">${esc(m.blessing || '转账')}</div>
        ${incoming && !claimed && !returned
          ? `<button class="rp-claim" data-rpclaim="${m.id}">收款</button>`
          : `<div class="rp-state">${esc(status)}${extra}</div>`}
      </div>`;
    } else if (m.type === 'gift') {
      const incoming = m.direction === 'in';
      const returned = m.returned === true;   /* 24h 未领取已退回：灰白卡片，不可再收下 */
      const claimed = m.claimed === true;
      const price = Math.max(0, Math.round((Number(m.price) || 0) * 100) / 100);
      const noteTxt = String(m.note || '').trim() || (price > 0 ? money(price) : '心意');
      const status = returned ? '已退回' : (m.receivedCard ? '已收下' : (claimed ? (incoming ? '已收下' : dn + '已收下') : '待收下'));
      inner = `<div class="bubble redpacket-bubble gift-bubble ${returned ? 'card-returned' : (claimed ? 'rp-received' : 'rp-pending')}">
        ${quoteHTML}
        <div class="rp-title">送礼物</div>
        <div class="rp-amount gift-name">${esc(m.emoji || '🎁')} ${esc(m.giftName || '礼物')}</div>
        <div class="rp-note">${esc(noteTxt)}</div>
        ${incoming && !claimed && !returned
          ? `<button class="rp-claim" data-giftclaim="${m.id}">收下</button>`
          : `<div class="rp-state">${esc(status)}</div>`}
      </div>`;
    } else if (m.type === 'readInvite') {
      /* 一起读书邀请卡片：与转账卡片同尺寸（竖长窄卡）；深色=待处理，浅色=已处理 */
      const incoming = m.direction === 'in';
      const status = m.status || 'pending';
      const accepted = status === 'accepted';
      const rejected = status === 'rejected';
      const subTxt = incoming ? 'TA 邀请你一起读书'
        : accepted ? 'TA 已接受你的邀请'
        : rejected ? 'TA 婉拒了这次邀请'
        : '等待 TA 接受...';
      let lastRow = '';
      if (incoming && !accepted && !rejected) {
        lastRow = `<div class="ri-actions">
              <button class="ri-btn reject" data-readreject="${m.id}">拒绝</button>
              <button class="ri-btn accept" data-readaccept="${m.id}">接受</button>
            </div>`;
      } else if (accepted) {
        lastRow = `<div class="ri-state">已接受</div>`;
      } else if (rejected) {
        lastRow = `<div class="ri-state">已婉拒</div>`;
      }
      inner = `<div class="bubble redpacket-bubble read-invite-bubble ${(accepted || rejected) ? 'rp-received' : 'rp-pending'}">
        ${quoteHTML}
        <div class="ri-title">📖 共读邀请</div>
        <div class="ri-sub">${esc(subTxt)}</div>
        ${lastRow}
      </div>`;
    } else {
      /* 普通文字 / 图文混合消息：images 数组非空时图片在上、文字在下 */
      const imgs = Array.isArray(m.images) ? m.images.filter(x => typeof x === 'string' && x) : [];
      if (imgs.length) {
        const cls = 'n' + Math.min(imgs.length, 9);
        const grid = `<div class="chat-imgs ${cls}">${imgs.map((src, ii) =>
          `<div class="ci-img"><img src="${esc(src)}" alt="" data-chatimg="${m.id}" data-imgidx="${ii}" onerror="this.parentNode.classList.add('img-broken');this.remove()"></div>`).join('')}</div>`;
        const bubble = (quoteHTML || String(m.content || ''))
          ? `<div class="bubble" style="margin-top:6px">${quoteHTML}${esc(m.content || '')}</div>`
          : '';
        inner = grid + bubble;
      } else {
        inner = `<div class="bubble">${quoteHTML}${esc(m.content || '')}</div>`;
      }
    }

    const readMark = (mine && i === lastUserIndex && m.read)
      ? `<span class="read-mark">已读${m.readNote ? ' · ' + esc(m.readNote) : ''}</span>` : '';
    const checked = chatSelectMode && chatSelectedIds.has(m.id);
    html += `
      <div class="msg ${mine ? 'mine' : 'theirs'}${checked ? ' selected' : ''}" data-mid="${m.id}">
        ${chatSelectMode ? `<div class="sel-check">${checked ? '✓' : ''}</div>` : ''}
        ${mine ? avatarHTML(state.my.avatar, 34) : `<span class="ava-pat msg-ta-avatar" data-avapat="${m.id}">${roleAvatarHTML(role, 34)}</span>`}
        <div class="msg-body">
          ${inner}
          <div class="msg-time">${fmtClock(m.ts)}${readMark}</div>
        </div>
      </div>`;
  });

  if (!msgs.length && !typingMap.get(roleId)) {
    html += `<div class="chat-empty">还没有聊天记录<br>说点什么，${esc(dn)}会用字卡回应你</div>`;
  }

  /* 聊天框内的「气泡 + 省略号」占位动画：与顶部「正在输入…」小字同时存在，
     连发全程保持显示直到最后一条发出后移除；临时 UI，不写入聊天记录 */
  if (typingMap.get(roleId) && !chatSelectMode) {
    html += `
      <div class="msg theirs typing-placeholder">
        <span class="ava-pat">${roleAvatarHTML(role, 34)}</span>
        <div class="msg-body">
          <div class="bubble typing-bubble"><i></i><i></i><i></i></div>
        </div>
      </div>`;
  }

  list.innerHTML = html;
  list.classList.toggle('selecting', chatSelectMode);
  /* 「正在输入…」小字：只挂在聊天页顶部名字下方，不再占用消息区 */
  const typingHint = $('#chatTypingHint');
  if (typingHint) typingHint.classList.toggle('show', !!typingMap.get(roleId) && !chatSelectMode);
  /* 所有点击类交互统一事件委托：整个消息容器只挂一次监听，
     不再按消息 / 按图片逐个 addEventListener */
  ensureChatDelegation(list);
  /* 长按（或右键）气泡弹出操作菜单：删除 / 撤回（仅自己）/ 引用；同样只绑定一次 */
  bindBubbleLongPress(list);
  const sc = $('#chatScroll');
  if (sc) {
    sc.scrollTop = sc.scrollHeight;
    /* 图片 / 字体晚加载会撑高消息区：原本贴着底部时补一次贴底，
       避免进入聊天页停在「最新消息上方」；用户已上滑时不动 */
    setTimeout(() => {
      if (currentRoute.page !== 'chat' || currentRoute.roleId !== roleId) return;
      if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 120) sc.scrollTop = sc.scrollHeight;
    }, 80);
  }
}

function bindBubbleLongPress(list) {
  /* 只绑定一次：roleId 通过 currentRoute 动态获取，切换会话无需重新绑定 */
  if (!list || list.dataset.lpBound === '1') return;
  list.dataset.lpBound = '1';
  let timer = null, pressEl = null, sx = 0, sy = 0;

  const clear = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (pressEl) { pressEl.classList.remove('bubble-press'); pressEl = null; }
  };
  const start = (el, x, y) => {
    pressEl = el;
    sx = x; sy = y;
    pressEl.classList.add('bubble-press');
    timer = setTimeout(() => {
      timer = null;
      const id = el.dataset.mid;
      if (pressEl) pressEl.classList.remove('bubble-press');
      pressEl = null;
      if (id) openMessageActions(currentRoute.roleId, id);
    }, 480);
  };

  /* 用 addEventListener + {passive:false} 才能保证 preventDefault 生效，
     彻底阻断 iOS 长按弹系统「复制/全选/删除」菜单；自定义菜单照常触发 */
  list.addEventListener('pointerdown', e => {
    const el = e.target.closest('.msg[data-mid]');
    if (!el || e.target.closest('.rp-claim')) return;
    e.preventDefault();
    clear();
    start(el, e.clientX, e.clientY);
  }, { passive: false });
  list.addEventListener('pointermove', e => {
    if (!pressEl) return;
    if (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10) clear();
  }, { passive: true });
  list.addEventListener('pointerup', clear);
  list.addEventListener('pointercancel', clear);
  list.addEventListener('pointerleave', clear);
  /* 桌面右键同样唤起菜单，并屏蔽浏览器默认菜单 */
  list.addEventListener('contextmenu', e => {
    const el = e.target.closest('.msg[data-mid]');
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    /* 触屏长按已由 pointer 定时器唤起菜单，这里避免短时间内重复弹一次 */
    if (Date.now() - bubbleMenuAt < 400) return;
    const id = el.dataset.mid;
    if (id) openMessageActions(currentRoute.roleId, id);
  });
}

/* 消息操作菜单：引用对双方消息都可用；撤回只对自己发出的消息；删除一律可用 */
function openMessageActions(roleId, msgId) {
  const role = roleById(roleId);
  const msgs = chatOf(roleId);
  const msg = msgs.find(m => m.id === msgId);
  if (!role || !msg) return;
  bubbleMenuAt = Date.now();
  const mine = msg.sender ? msg.sender === 'user' : msg.role === 'user';
  const who = msg.role === 'system' ? '系统消息' : (mine ? '你' : role.name);
  const items = [];

  /* 复制：对图片/表情等没有可复制文本的消息，copyTextOf 返回空字符串，
     copyToClipboard 会直接返回 false → 下方 fallback 提示"无法复制图片/表情包" */
  items.push({
    label: '复制', onClick: async () => {
      const text = copyTextOf(msg);
      if (!text) { showToast('无法复制图片/表情包'); return; }
      const ok = await copyToClipboard(text);
      if (ok) showToast('已复制');
      else showToast('复制失败，可长按文本手动选择');
    }
  });

  items.push({
    label: '引用', onClick: () => {
      chatQuote = {
        id: msg.id,
        roleId,
        who,
        text: quoteTextOf(msg),
        mine
      };
      renderQuoteBar();
      const ta = $('#chatText');
      /* preventScroll：禁止浏览器为聚焦而滚动窗口，避免整个聊天页被顶飞 */
      if (ta) ta.focus({ preventScroll: true });
    }
  });

  if (mine && !msg.recalled) {
    items.push({
      label: '撤回', onClick: () => {
        msg.recalled = true;
        msg.recalledAt = Date.now();
        persist();
        renderChatIf(roleId);
        refreshMessagesPage();
        showToast('已撤回');
      }
    });
  }

  items.push({
    label: '删除', onClick: () => {
      const idx = msgs.indexOf(msg);
      if (idx < 0) return;
      msgs.splice(idx, 1);
      if (chatQuote && chatQuote.id === msg.id) { chatQuote = null; renderQuoteBar(); }
      persist();
      renderChatIf(roleId);
      refreshMessagesPage();
      showToast('已删除');
    }
  });

  showActionSheet(mine ? '我的消息' : (role.name + ' 的消息'), items);
}

/* =========================================================
 * 发图片：待发送预览（per-chat 持久化）+ 选图压缩 + 发送
 * - 选图后不立即发送，缩略图暂存在输入框上方，可单删、可多次添加，最多 9 张；
 * - 点发送才真正发出：有文字图文一条（图片在上文字在下），无文字只发图；
 * - 未发送就离开聊天页时预览保留在当前聊天，刷新/切换不丢失、不误发。
 * ========================================================= */
const IMG_DRAFT_MAX = 9;

function imgDraftsOf(roleId) {
  return (state.imgDrafts && state.imgDrafts[roleId]) || [];
}

function setImgDrafts(roleId, arr) {
  if (!state.imgDrafts) state.imgDrafts = {};
  if (arr && arr.length) state.imgDrafts[roleId] = arr;
  else delete state.imgDrafts[roleId];
  persist();
}

function renderImgDraftBar(roleId) {
  const bar = $('#imgDraftBar'), listEl = $('#imgDraftList');
  if (!bar || !listEl) return;
  const drafts = imgDraftsOf(roleId);
  bar.classList.toggle('show', drafts.length > 0);
  listEl.innerHTML = drafts.map((src, i) => `
    <div class="img-draft-item">
      <img src="${esc(src)}" alt="">
      <button class="img-draft-del" data-imgdel="${i}" aria-label="移除">×</button>
    </div>`).join('');
  $$('[data-imgdel]', listEl).forEach(btn => btn.addEventListener('click', () => {
    const arr = imgDraftsOf(roleId).slice();
    arr.splice(Number(btn.dataset.imgdel), 1);
    setImgDrafts(roleId, arr);
    renderImgDraftBar(roleId);
  }));
}

function addImgDrafts(roleId, dataUrls) {
  if (!dataUrls || !dataUrls.length) return;
  const cur = imgDraftsOf(roleId);
  const room = IMG_DRAFT_MAX - cur.length;
  if (room <= 0) { showToast('最多 9 张'); return; }
  if (dataUrls.length > room) showToast('最多 9 张，本次已保留前 ' + room + ' 张');
  setImgDrafts(roleId, cur.concat(dataUrls.slice(0, room)));
  renderImgDraftBar(roleId);
}

/* 选择方式：拍照（capture 触发相机）/ 从相册选择；逐张压缩，单张失败不影响其他 */
function pickChatImages(roleId, capture) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  if (capture) input.setAttribute('capture', 'environment');
  input.multiple = true;
  input.style.display = 'none';
  document.body.appendChild(input);
  input.addEventListener('change', async () => {
    const files = Array.from(input.files || []);
    input.remove();
    if (!files.length) return;
    const out = [];
    for (const file of files) {
      if (!/^image\//.test(file.type)) { showToast('已跳过非图片文件'); continue; }
      try {
        out.push(await compressDataURL(await readFileAsDataURL(file), 800, .7));
      } catch (e) {
        showToast('有一张图片读取失败，已跳过');
      }
    }
    addImgDrafts(roleId, out);
  });
  input.click();
}

function sendChatText(roleId) {
  const ta = $('#chatText');
  if (!ta) return;
  const text = ta.value.trim();
  const drafts = imgDraftsOf(roleId);
  if (!text && !drafts.length) return;
  ta.value = '';
  ta.style.height = 'auto';
  /* 发送后立刻清空并保持焦点，键盘不收起，操作感「瞬间完成」 */
  try { ta.focus({ preventScroll: true }); } catch (e) { ta.focus(); }
  closeChatPlus();
  closeStickerSheet();
  if (drafts.length) {
    setImgDrafts(roleId, []);
    renderImgDraftBar(roleId);
    sendUserMessage(roleId, { type: 'text', content: text, images: drafts.slice() });
  } else {
    sendUserMessage(roleId, { type: 'text', content: text });
  }
}

function sendUserMessage(roleId, payload) {
  const msg = Object.assign({
    id: uid(),
    role: 'user',
    ts: Date.now(),
    read: false
  }, payload);
  /* 发送时带上引用：只取当前聊天页选中的那条 */
  if (!msg.quote && chatQuote && chatQuote.roleId === roleId) {
    msg.quote = { id: chatQuote.id, who: chatQuote.who, text: chatQuote.text, mine: chatQuote.mine !== false };
  }
  chatOf(roleId).push(msg);
  if (chatQuote && chatQuote.roleId === roleId) { chatQuote = null; renderQuoteBar(); }
  state.unread[roleId] = 0;
  jarOnChatActivity();  /* 拾光瓶：发送消息参与每日集星 / 断联复活 */

  /* 先上屏：只在列表末尾追加这一条消息的 DOM 节点，不重绘整个列表。
     仅在「当前聊天页 + 普通文字/图文消息」时走增量路径，其余情况退回整体渲染。 */
  const active = currentRoute.page === 'chat' && currentRoute.roleId === roleId;
  const simple = !msg.type || msg.type === 'text';
  if (active && simple && !chatSelectMode) {
    if (!appendChatMessageNode(roleId, msg)) renderChatIf(roleId);
  } else {
    renderChatIf(roleId);
  }

  /* 本地存储与 TA 的延迟回复放到下一轮事件循环，避免阻塞 UI 上屏 */
  setTimeout(() => { persist(); }, 0);
  setTimeout(() => { scheduleReply(roleId); refreshMessagesPage(); }, 0);
}

/* 只构建「我方」单条消息（文字 / 图文）的 DOM，供发送时增量追加 */
function userMsgHTML(m) {
  const q = m.quote;
  const quoteHTML = q
    ? `<div class="quote-block"><span class="quote-who">${esc(q.who || '')}</span><span class="quote-text">${esc(q.text || '')}</span></div>`
    : '';
  const imgs = Array.isArray(m.images) ? m.images.filter(x => typeof x === 'string' && x) : [];
  let inner;
  if (imgs.length) {
    const cls = 'n' + Math.min(imgs.length, 9);
    const grid = `<div class="chat-imgs ${cls}">${imgs.map((src, ii) =>
      `<div class="ci-img"><img src="${esc(src)}" alt="" data-chatimg="${m.id}" data-imgidx="${ii}" onerror="this.parentNode.classList.add('img-broken');this.remove()"></div>`).join('')}</div>`;
    const bubble = (quoteHTML || String(m.content || ''))
      ? `<div class="bubble" style="margin-top:6px">${quoteHTML}${esc(m.content || '')}</div>`
      : '';
    inner = grid + bubble;
  } else {
    inner = `<div class="bubble">${quoteHTML}${esc(m.content || '')}</div>`;
  }
  return `<div class="msg mine" data-mid="${m.id}">
    ${avatarHTML(state.my.avatar, 34)}
    <div class="msg-body">${inner}<div class="msg-time">${fmtClock(m.ts)}</div></div>
  </div>`;
}

/* 把刚发送的消息追加到聊天列表末尾（插在 typing 占位之前），只处理文字/图文 */
function appendChatMessageNode(roleId, msg) {
  const list = $('#chatList');
  if (!list) return false;
  if (!roleById(roleId)) return false;
  const msgs = chatOf(roleId);
  const prev = msgs[msgs.length - 2];
  const ph = list.querySelector('.typing-placeholder');
  const empty = list.querySelector('.chat-empty');
  if (empty) empty.remove();
  const insertAt = (ph && ph.parentNode === list) ? ph : null;
  /* 与上一条间隔超过 5 分钟时补一条时间分隔，与整体渲染的规则保持一致 */
  if (!prev || msg.ts - prev.ts > 5 * 60 * 1000) {
    const sep = document.createElement('div');
    sep.className = 'time-sep';
    sep.textContent = fmtMsgTime(msg.ts);
    if (insertAt) list.insertBefore(sep, insertAt); else list.appendChild(sep);
  }
  const holder = document.createElement('div');
  holder.innerHTML = userMsgHTML(msg);
  const node = holder.firstElementChild;
  if (!node) return false;
  if (insertAt) list.insertBefore(node, insertAt); else list.appendChild(node);
  /* 新插入的图片消息：绑大图浏览（长按菜单是 list 级事件委托，无需单独绑定） */
  $$('[data-chatimg]', node).forEach(img => {
    img.addEventListener('click', () => {
      if (Date.now() - bubbleMenuAt < 700) return;
      const arr = Array.isArray(msg.images) && msg.images.length ? msg.images : [img.src];
      showLightbox(img.src, arr, Number(img.dataset.imgidx) || 0);
    });
  });
  /* 新的我方消息出现后，旧的「已读」标记不再指向最后一条 */
  $$('.read-mark', list).forEach(el => el.remove());
  const sc = $('#chatScroll');
  if (sc) sc.scrollTop = sc.scrollHeight;
  return true;
}

function markUserRead(roleId, note) {
  if (!roleById(roleId)) return;
  const msgs = chatOf(roleId);
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') {
      msgs[i].read = true;
      msgs[i].readNote = note || '';
      break;
    }
  }
  persist();
}

/* 共用字卡拼接：聊天回复、信件回信、空间评论都走这里，保证行为一致。
 * 字卡全局共享（不再区分梦角/公共），从全部启用字卡中抽取；
 * roleId 仅用于 lastReplies 防连续重复的键。
 * opt 传入 { mergeMin, mergeMax, mergeSeparator, key } 时按传入规则拼接（信件专属设置），
 * 否则回落到聊天全局的 mergeChance（拼字卡概率）/ mergeMin / mergeMax / mergeSeparator。
 * 字卡不足 2 张时强制单张；mergeChance 命中才拼接，否则单张。
 * 返回拼接文本；可用字卡为空时返回空串，由调用方决定兜底文案。 */
function composeCardText(roleId, opt) {
  const st = state.settings;
  const pool = state.cards.filter(c =>
    c.enabled !== false && c.content && c.content.trim()
  );
  if (!pool.length) return '';

  const o = opt || null;
  let lo = 1, hi = 1, sepRaw = '';
  if (o && Number.isFinite(Number(o.mergeMin)) && Number.isFinite(Number(o.mergeMax))) {
    /* 信件专属拼接：不看全局 mergeChance，按这封信自己的最少/最多张数规则拼接 */
    lo = clamp(Math.round(Number(o.mergeMin)), 1, 6);
    hi = clamp(Math.round(Number(o.mergeMax)), lo, 6);
    sepRaw = o.mergeSeparator == null ? '，' : String(o.mergeSeparator);
  } else {
    /* 全局：字卡不足 2 张时强制单张，防报错；否则按 mergeChance 概率决定单张 / 拼接 */
    if (pool.length < 2) {
      lo = 1; hi = 1;
    } else if (Math.random() * 100 < Number(st.mergeChance ?? 50)) {
      lo = clamp(Math.round(Number(st.mergeMin) || 2), 2, 6);
      hi = clamp(Math.round(Number(st.mergeMax) || lo), lo, 6);
      sepRaw = String(st.mergeSeparator == null ? '，' : st.mergeSeparator);
    } else {
      lo = 1; hi = 1;   /* 未命中概率：单张回复 */
    }
  }

  const n = clamp(randInt(lo, hi), 1, Math.min(6, pool.length));
  const sep = sepRaw === ' ' ? ' ' : sepRaw === '\n' ? '\n' : sepRaw;
  const lastKey = (o && o.key) || roleId;
  const last = state.lastReplies[lastKey] || '';
  let text = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const picked = pickMany(pool, n);
    text = picked.map(c => c.content.trim()).join(sep);
    if (text !== last) break;
  }
  state.lastReplies[lastKey] = text;
  return text;
}

function composeReply(roleId) {
  return composeCardText(roleId) || '字卡库还是空的，先去添加一些字卡吧';
}

/* TA 回复等待时间：由「最短/最长回复时间」设置决定，单位秒，0 表示不等待 */
function replyDelayMs() {
  const st = state.settings;
  const lo = clamp(Math.round(Number(st.replyDelayMin ?? 1)), 0, 300);
  const hi = clamp(Math.round(Number(st.replyDelayMax ?? 3)), lo, 300);
  if (hi <= 0) return 0;
  return randInt(lo, hi) * 1000;
}

/* TA 引用：概率命中时从你最近的发言里挑一条作为引用原文 */
function maybeTaQuote(roleId) {
  const p = Number(state.settings.taQuoteChance ?? 0);
  if (!(p > 0) || !(Math.random() * 100 < p)) return null;
  const pool = chatOf(roleId).filter(m => m.role === 'user' && !m.recalled);
  if (!pool.length) return null;
  const pick = pickOne(pool.slice(-30));
  if (!pick) return null;
  return { id: pick.id, who: '你', text: quoteTextOf(pick), mine: true };
}

/* 字卡库为空时的兜底文案（连发与单发保持一致，只发一条，不空发） */
const EMPTY_CARD_TEXT = '字卡库还是空的，先去添加一些字卡吧';

function burstConfig() {
  const st = state.settings;
  const lo = clamp(Math.round(Number(st.burstMin ?? 1)), 1, 6);
  const hi = clamp(Math.round(Number(st.burstMax ?? 2)), lo, 6);
  return { enabled: st.burstEnabled !== false, lo, hi };
}

function burstCount() {
  const c = burstConfig();
  return c.enabled ? randInt(c.lo, c.hi) : 1;
}

/* 生成一条回复，并尽量避开与上一条完全相同 */
function composeUniqueReply(roleId, prev) {
  let text = composeCardText(roleId);
  let tries = 0;
  while (text && text === prev && tries++ < 6) text = composeCardText(roleId);
  return text;
}

/* =========================================================
 * 拍一拍：双字卡库 + 双击头像拍 TA + TA 按概率/冷却主动拍我
 * - 拍一拍消息 type:'pat'，作为独立消息进聊天记录并持久化；
 * - 字卡内容固定单张原样拼接在名称后（无括号），不参与字卡拼接（不受 mergeEnabled/mergeMin/mergeMax 影响），
 *   也不参与连发条数，一次触发只生成一条拍一拍消息；
 * - 通话中 TA 不主动拍；字卡库为空时使用默认文案（无后缀）。
 * ========================================================= */
function patLib(side) { return side === 'ta' ? state.taPatCards : state.userPatCards; }
function patTextOf(m, dn) {
  /* 规格格式：有字卡内容时直接拼接「我+内容 / 名字+内容」（如「我揉了揉你的头发」）；
     字卡库为空时退化为「我拍了拍 名字 / 名字 拍了拍我」。
     名字动态传入（当前会话梦角），为空兜底「TA」 */
  const name = (dn && String(dn).trim()) || 'TA';
  const mine = m.sender ? m.sender === 'user' : m.role === 'user';
  const who = mine ? '我' : name;
  const target = mine ? name : '我';
  const suffix = String(m.patText || '').trim();
  return suffix ? `${who}${suffix}` : `${who}拍了拍${target}`;
}
function composePatText(side) {
  const pool = (patLib(side) || []).filter(c => c.enabled !== false && c.content && c.content.trim());
  if (!pool.length) return '';
  /* 拍一拍不参与拼接：固定随机单张字卡，原样显示 */
  return pickOne(pool).content.trim();
}

/* 我拍 TA：双击聊天页顶部头像或 TA 消息气泡旁的头像触发（两个入口共用冷却） */
let userPatLastAt = 0;
function userPatRole(roleId) {
  const role = roleById(roleId);
  if (!role) return;
  const now = Date.now();
  if (now - userPatLastAt < 1200) return;  /* 顶部头像 / 气泡头像双击入口共用同一冷却 */
  userPatLastAt = now;
  const patText = composePatText('user');
  chatOf(roleId).push({
    id: uid(), role: 'user', sender: 'user', type: 'pat',
    patText, ts: Date.now(), read: true
  });
  persist();
  renderChatIf(roleId);
  refreshMessagesPage();
  showToast(`已拍了拍 ${taName(roleId)}`);
}

/* TA 主动拍我：按拍一拍冷却节奏判定，命中概率后随机选一个梦角 */
function checkTaPat() {
  if (!state) return;
  const now = Date.now();
  const cd = clamp(Math.round(Number(state.settings.patCooldown ?? 10)), 0, 120);
  if (!state.patNextAt) { state.patNextAt = now + Math.max(cd, 5) * 1000; persist(); return; }
  if (now < state.patNextAt) return;
  state.patNextAt = now + Math.max(cd, 5) * 1000;
  persist();
  const chance = Number(state.settings.patChance ?? 80);
  if (chance <= 0) return;
  if (callState.status !== 'idle') return;  /* 通话中不拍 */
  if (Math.random() * 100 >= chance) return;
  const role = pickOne(state.roles);
  if (!role) return;
  pushDreamMessage(role.id, { type: 'pat', patText: composePatText('ta') });
  refreshMessagesPage();
}

/* =========================================================
 * TA 主动发空间动态：按间隔分钟 + 概率判定，动态持久化
 * ========================================================= */
function nextSpaceProactiveDelay() {
  const st = state.settings;
  const min = clamp(Number(st.spaceProactiveMin) || 30, 1, 480);
  const max = clamp(Number(st.spaceProactiveMax) || 90, min, 480);
  return randInt(min, max) * 60 * 1000;
}
function checkTaSpacePosts() {
  if (!state) return;
  const now = Date.now();
  if (!state.nextSpaceProactiveAt) { state.nextSpaceProactiveAt = now + nextSpaceProactiveDelay(); persist(); return; }
  if (now < state.nextSpaceProactiveAt) return;
  state.nextSpaceProactiveAt = now + nextSpaceProactiveDelay();
  persist();
  if (state.settings.spaceProactiveEnabled === false) return;
  const chance = Number(state.settings.spaceProactiveChance ?? 15);
  if (chance <= 0) return;
  if (Math.random() * 100 >= chance) return;
  const role = pickOne(state.roles);
  if (!role) return;
  const text = composeCardText(role.id) || '我想你了';
  const moment = {
    id: uid(), text, images: [], image: '',
    likes: [], comments: [], fromTa: true, fromRoleId: role.id, ts: Date.now()
  };
  /* TA 主动发的动态同样参与「TA点赞/评论」判定，互动者排除发布者本人，同一条只判一次 */
  const others = state.roles.filter(r => r && r.id && r.id !== role.id);
  if (others.length) {
    const interactor = pickOne(others);
    moment.interactRoleId = interactor.id;
    moment.interactAt = Date.now() + randInt(5, 120) * 1000;
    moment.interacted = false;
  } else {
    moment.interactRoleId = '';
    moment.interactAt = 0;
    moment.interacted = true;
  }
  state.moments.unshift(moment);
  persist();
  if (currentRoute.page === 'space') renderSpacePage();
  showToast(taName(role.id) + ' 发布了新动态');
}

/* 统一的 TA 连发发送器：
 * - makeText(prevText) 返回本条文案，返回空串表示没有内容；
 * - fallback 仅在第一条没有内容时补一条兜底文案；
 * - quote 只挂在第一条上；
 * - 每条独立时间戳、独立等待与「正在输入…」，相邻两条之间额外间隔 0.5~1.5 秒；
 * - onDone 在整轮发完后回调（回复队列用它收尾）。 */
function sendTaBurst(roleId, opts) {
  if (!roleById(roleId)) return;
  const options = opts || {};
  const gen = options.gen != null ? options.gen : (chatGenMap.get(roleId) || 0);
  /* 心声：整轮连发只在开始处抽取一次，本轮所有消息共用同一组 heartTags；
     调用方也可以传入已抽好的 options.heartTags，让更早的引导消息与本轮保持一致 */
  const roundTags = (Array.isArray(options.heartTags) && options.heartTags.length)
    ? options.heartTags
    : makeHeartTags();
  /* single:true 固定只发 1 条（问卷回答等场景），不参与连发条数 */
  const total = options.single ? 1 : burstCount();
  let i = 0;
  let lastText = '';
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    typingMap.set(roleId, false);
    markUserRead(roleId);
    renderChatIf(roleId);
    refreshMessagesPage();
    if (typeof options.onDone === 'function') options.onDone();
  };
  const step = () => {
    if (gen !== (chatGenMap.get(roleId) || 0)) { finish(); return; }
    if (i >= total) { finish(); return; }
    typingMap.set(roleId, true);
    renderChatIf(roleId);
    refreshMessagesPage();
    /* 首条按回复时间等待；后续每条同样受回复时间约束，再加一点连发间隔避免刷屏 */
    const delay = replyDelayMs() + (i > 0 ? randInt(500, 1500) : 0);
    setTimeout(() => {
      if (gen !== (chatGenMap.get(roleId) || 0)) { finish(); return; }
      let text = typeof options.makeText === 'function'
        ? String(options.makeText(lastText) || '')
        : '';
      if (!text && i === 0 && options.fallback) text = String(options.fallback);
      if (text) {
        const payload = { type: 'text', content: text, heartTags: roundTags };
        if (i === 0 && options.quote) payload.quote = options.quote;
        pushDreamMessage(roleId, payload);
        lastText = text;
      }
      i++;
      if (!text) { finish(); return; }  /* 没有可发的文案：不空发，直接收尾 */
      if (i >= total) { finish(); return; }
      step();
    }, delay);
  };
  step();
}

/* TA 延迟发消息：先显示「正在输入…」，等待时间由最短/最长回复时间控制。
 * makePayload 可以是消息对象，也可以是返回消息对象的函数（到点再生成文案）。 */
function taSayAfterDelay(roleId, makePayload) {
  if (!roleById(roleId)) return;
  const gen = chatGenMap.get(roleId) || 0;
  typingMap.set(roleId, true);
  renderChatIf(roleId);
  refreshMessagesPage();
  const fire = () => {
    if (gen !== (chatGenMap.get(roleId) || 0)) { typingMap.set(roleId, false); return; }
    typingMap.set(roleId, false);
    const payload = typeof makePayload === 'function' ? makePayload() : makePayload;
    if (payload) pushDreamMessage(roleId, payload);
    renderChatIf(roleId);
    refreshMessagesPage();
  };
  const delay = replyDelayMs();
  if (delay > 0) setTimeout(fire, delay); else fire();
}

function scheduleReply(roleId) {
  replyQueue.set(roleId, (replyQueue.get(roleId) || 0) + 1);
  if (!replyBusy.get(roleId)) processReplyQueue(roleId);
}

function processReplyQueue(roleId) {
  const count = replyQueue.get(roleId) || 0;
  if (count <= 0) {
    replyBusy.set(roleId, false);
    typingMap.set(roleId, false);
    renderChatIf(roleId);
    refreshMessagesPage();
    return;
  }
  replyQueue.set(roleId, count - 1);
  replyBusy.set(roleId, true);
  const gen = chatGenMap.get(roleId) || 0;

  /* 回复判定：只由 replyChance 控制 */
  const willReply = Math.random() * 100 < Number(state.settings.replyChance ?? 100);

  if (!willReply) {
    // 未触发回复：固定显示「已读」小字，不产生TA的消息
    setTimeout(() => {
      if (gen !== (chatGenMap.get(roleId) || 0)) { replyBusy.set(roleId, false); return; }
      markUserRead(roleId, '');
      typingMap.set(roleId, false);
      renderChatIf(roleId);
      finishReplyStep(roleId);
    }, randInt(450, 1000));
    return;
  }

  typingMap.set(roleId, false);
  /* 连发：先按 replyChance 判定回复，命中后再决定本次回复形式 */
  const stickerPool = (state.stickers || []).filter(s => s && s.data);
  const emojiChance = Number(state.settings.emojiSendChance ?? 15);
  /* 表情包分支：命中概率且共享表情包库非空时，本次回复只发一张表情包（不拼接、不连发）；
   * 库为空自动跳过该分支，回退为正常字卡回复，不报错、不产生空白消息 */
  if (stickerPool.length && emojiChance > 0 && Math.random() * 100 < emojiChance) {
    taSendStickerReply(roleId, gen);
    return;
  }
  taReplyWithCards(roleId, gen);
}

/* 普通字卡回复：连发 + 拼接，供普通回复与表情包回退共用 */
function taReplyWithCards(roleId, gen, quote) {
  sendTaBurst(roleId, {
    gen,
    makeText: prev => composeUniqueReply(roleId, prev),
    fallback: EMPTY_CARD_TEXT,
    quote: quote !== undefined ? quote : maybeTaQuote(roleId),
    onDone: () => finishReplyStep(roleId)
  });
}

/* TA 回一张表情包：与用户共用同一套表情包库，随机取一张；
 * 单条消息、不参与拼接与连发，延迟与「正在输入…」时机和普通回复一致。 */
function taSendStickerReply(roleId, gen) {
  const pool = (state.stickers || []).filter(s => s && s.data);
  if (!pool.length) { taReplyWithCards(roleId, gen); return; }
  const quote = maybeTaQuote(roleId);
  typingMap.set(roleId, true);
  renderChatIf(roleId);
  refreshMessagesPage();
  const fire = () => {
    if (gen !== (chatGenMap.get(roleId) || 0)) { finishReplyStep(roleId); return; }
    typingMap.set(roleId, false);
    /* 等待期间库可能被清空：回退为字卡回复 */
    const now = (state.stickers || []).filter(s => s && s.data);
    if (!now.length) { taReplyWithCards(roleId, gen); return; }
    const sticker = pickOne(now);
    const payload = { type: 'sticker', image: sticker.data, content: '[表情]', heartTags: makeHeartTags() };
    if (quote) payload.quote = quote;
    pushDreamMessage(roleId, payload);
    finishReplyStep(roleId);
  };
  const delay = replyDelayMs();
  if (delay > 0) setTimeout(fire, delay); else fire();
}

function finishReplyStep(roleId) {
  typingMap.set(roleId, false);
  refreshMessagesPage();
  renderChatIf(roleId);
  if ((replyQueue.get(roleId) || 0) > 0) {
    setTimeout(() => processReplyQueue(roleId), 420);
  } else {
    replyBusy.set(roleId, false);
  }
}

function pushDreamMessage(roleId, payload) {
  if (!roleById(roleId)) return;
  const msg = Object.assign({ id: uid(), role: 'dream', type: 'text', ts: Date.now() }, payload);
  chatOf(roleId).push(msg);
  jarOnChatActivity();  /* 拾光瓶：收到 TA 消息同样计为当日互动 */
  const open = currentRoute.page === 'chat' && currentRoute.roleId === roleId;
  if (!open) state.unread[roleId] = (state.unread[roleId] || 0) + 1;
  persist();
  if (open) renderChatMessages();
  refreshMessagesPage();
  /* 聊天消息通知：字卡回复、主动回复、召回回应等全部经由本函数入聊天，这里统一触发 */
  if (!open) notifyChatMessage(roleId, msg);
  scheduleTaRecall(roleId, msg);
}

/* TA 撤回：按概率命中时，消息发出数秒后撤回；转账/问卷/通话等带操作的消息不撤回，避免破坏交互 */
function scheduleTaRecall(roleId, msg) {
  const p = Number(state.settings.taRecallChance ?? 0);
  if (!(p > 0) || msg.recalled) return;
  if (msg.type !== 'text' && msg.type !== 'sticker') return;
  if (!(Math.random() * 100 < p)) return;
  const gen = chatGenMap.get(roleId) || 0;
  setTimeout(() => {
    if (gen !== (chatGenMap.get(roleId) || 0)) return;
    if (msg.recalled) return;
    msg.recalled = true;
    msg.recalledAt = Date.now();
    persist();
    if (currentRoute.page === 'chat' && currentRoute.roleId === roleId) renderChatMessages();
    refreshMessagesPage();
  }, randInt(4000, 10000));
}

/* =========================================================
 * 后台通知（Notification API）
 * 策略（全代码统一）：页面可见时只更新未读红点、不弹系统通知；
 * 页面不可见时才发系统通知，避免同一消息既弹通知又有红点造成重复打扰。
 * ========================================================= */
function notifySupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

function truncateNotifyText(text, max) {
  const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/* 真正构造并弹出系统通知：只校验浏览器权限，未授权时静默跳过。
 * 供 sendSystemNotification（受总开关/前台抑制）与 notifyDefaultEvent（默认开启）复用。 */
function fireSystemNotification(title, body, tag, route) {
  if (!notifySupported() || Notification.permission !== 'granted') return false;
  try {
    const n = new Notification(truncateNotifyText(title || 'TA', 40), {
      body: truncateNotifyText(body, 80),
      tag: tag || undefined
    });
    n.onclick = () => {
      try { window.focus(); } catch (e) {}
      try { n.close(); } catch (e) {}
      if (route) {
        if (route.page === 'chat') openChat(route.roleId);
        else navigate(route.page === 'sub' && route.name ? { page: 'sub', name: route.name } : { page: route.page });
      }
    };
    return true;
  } catch (e) { /* 部分环境不支持构造通知，静默降级 */
    return false;
  }
}

/* 【一起专注结束】【收到信件】专用：默认开启、不设独立开关，
 * 不受【后台通知】总开关与前台抑制影响，页面在前台/后台都会发出。 */
function notifyDefaultEvent(title, body, tag, route) {
  return fireSystemNotification(title, body, tag, route);
}

function sendSystemNotification(title, body, tag, route, force) {
  if (!state || state.settings.notifyEnabled !== true) return;
  if (!notifySupported() || Notification.permission !== 'granted') return;
  /* 测试按钮传入 force：即使页面在前台也真实发出一条系统通知 */
  if (!force && document.visibilityState === 'visible') return;
  fireSystemNotification(title, body, tag, route);
}

function notifyChatMessage(roleId, msg) {
  if (!state.settings.notifyChat) return;
  const role = roleById(roleId);
  if (!role) return;
  const summary = msg && msg.type === 'sticker' ? '发来一张表情包'
    : msg && msg.type === 'gift' ? ('[礼物] ' + (msg.giftName || ''))
    : msg && msg.type === 'redpacket' ? '[转账]'
    : msg && msg.type === 'pat' ? '拍了拍你'
    : msg && msg.type === 'readInvite' ? '[一起读书] 邀请你一起读书'
    : msg && Array.isArray(msg.images) && msg.images.length ? ('[图片]' + (msg.content ? ' ' + truncateNotifyText(msg.content, 40) : ''))
    : truncateNotifyText(msg && msg.content || '', 60);
  sendSystemNotification(role.name, summary || '发来一条新消息', 'chat-' + roleId, { page: 'chat', roleId });
}

function notifySpaceInteraction(role, kind, text) {
  if (!state.settings.notifySpace) return;
  sendSystemNotification(
    role.name,
    kind === 'like' ? '赞了你的动态' : ('评论了你的动态：' + truncateNotifyText(text, 50)),
    'space-' + role.id,
    { page: 'space' }
  );
}

/* =========================================================
 * 后台保活：循环播放内联的静音音频，尽量让页面在手机后台保持运行。
 * 受浏览器自动播放策略与省电策略限制，不保证一定生效；音频保持极小音量/静音，
 * 不复用响亮通道，因此不影响来电铃声、一起专注提示音等其他声音。
 * ========================================================= */
let keepAliveAudio = null;
let keepAliveRetryBound = false;

function keepAliveSource() {
  const el = document.getElementById('keepAliveSrc');
  const src = el ? el.textContent.trim() : '';
  return src && src.indexOf('base64,') > 0 ? src : '';
}

function keepAliveStatusText() {
  if (!state || state.settings.keepAliveEnabled !== true) return '已关闭';
  if (keepAliveAudio && !keepAliveAudio.paused) return '播放中';
  if (keepAliveAudio && keepAliveAudio.paused) return '被浏览器暂停';
  return '已开启（等待播放）';
}

function updateKeepAliveStatus() {
  const el = document.getElementById('keepAliveStatus');
  if (el) el.textContent = keepAliveStatusText();
}

/* 播放被浏览器拦截时，绑定一次性的页面点击重试 */
function bindKeepAliveRetryOnce() {
  if (keepAliveRetryBound) return;
  keepAliveRetryBound = true;
  const handler = () => {
    if (state && state.settings.keepAliveEnabled === true) tryPlayKeepAlive();
  };
  document.addEventListener('pointerdown', handler, { passive: true });
  document.addEventListener('keydown', handler);
}

async function tryPlayKeepAlive() {
  if (!state || state.settings.keepAliveEnabled !== true) return;
  const src = keepAliveSource();
  if (!src) { showToast('未找到内置保活音频数据'); return; }
  if (!keepAliveAudio) {
    keepAliveAudio = new Audio(src);
    keepAliveAudio.loop = true;
    keepAliveAudio.preload = 'auto';
    keepAliveAudio.volume = 0.01; /* 近乎静音，避免影响其他提示音 */
    keepAliveAudio.addEventListener('play', updateKeepAliveStatus);
    keepAliveAudio.addEventListener('pause', updateKeepAliveStatus);
  }
  try {
    await keepAliveAudio.play();
    updateKeepAliveStatus();
  } catch (e) {
    updateKeepAliveStatus();
    bindKeepAliveRetryOnce();
    showToast('请点击页面任意位置后重试（浏览器要求用户操作才能播放）');
  }
}

function stopKeepAlive() {
  if (keepAliveAudio) {
    try { keepAliveAudio.pause(); } catch (e) {}
    try { keepAliveAudio.removeAttribute('src'); keepAliveAudio.load(); } catch (e) {}
    keepAliveAudio = null;
  }
  updateKeepAliveStatus();
}

function syncKeepAliveBySetting() {
  if (state.settings.keepAliveEnabled === true) tryPlayKeepAlive();
  else stopKeepAlive();
  updateKeepAliveStatus();
}

async function clearChat(roleId) {
  const role = roleById(roleId);
  if (!role) return;
  const ok = await confirmDialog('清空聊天记录', `将清空与「${role.name}」的全部聊天记录，无法恢复。`, '清空', true);
  if (!ok) return;
  bumpChatGen(roleId);
  typingMap.set(roleId, false);
  replyQueue.set(roleId, 0);
  replyBusy.set(roleId, false);
  state.chats[roleId] = [];
  state.unread[roleId] = 0;
  state.lastReplies[roleId] = '';
  persist(true);
  renderChatMessages();
  refreshMessagesPage();
  showToast('聊天记录已清空');
}

/* 表情面板 */
function toggleStickerSheet(roleId) {
  const sheet = $('#stickerSheet');
  if (!sheet) return;
  if (sheet.classList.contains('open')) { closeStickerSheet(); return; }
  closeChatPlus();
  /* 先收起键盘再弹面板：输入框失焦，避免键盘与面板同时占位互相顶撞 */
  const ta = $('#chatText');
  if (ta && document.activeElement === ta) ta.blur();
  renderStickerSheet(roleId);
  sheet.classList.add('open');
  /* 状态同步：面板打开时表情包按钮高亮 */
  const sb = $('#btnSticker');
  if (sb) sb.classList.add('active');
}

function closeStickerSheet() {
  const sheet = $('#stickerSheet');
  if (sheet) sheet.classList.remove('open');
  /* 状态同步：面板收起时复位表情包按钮选中态 */
  const sb = $('#btnSticker');
  if (sb) sb.classList.remove('active');
}

function renderStickerSheet(roleId) {
  const sheet = $('#stickerSheet');
  sheet.innerHTML = `
    <div class="sheet-head">
      <b>表情包</b>
      <button data-sticker-manage>管理 ›</button>
    </div>
    ${state.stickers.length
      ? `<div class="sticker-grid">${state.stickers.map(s =>
          `<button class="sticker-cell" data-sticker="${s.id}"><img src="${esc(s.data)}" alt="${esc(s.name)}"></button>`).join('')}</div>`
      : '<div class="empty" style="padding:18px">还没有表情包<br>去「表情包管理」添加一些吧</div>'}`;

  $('[data-sticker-manage]').addEventListener('click', () => {
    closeStickerSheet();
    navigate({ page: 'sub', name: 'stickers' });
  });
  $$('[data-sticker]', sheet).forEach(btn => {
    btn.addEventListener('click', () => {
      const sticker = state.stickers.find(s => s.id === btn.dataset.sticker);
      if (!sticker) return;
      closeStickerSheet();
      sendUserMessage(roleId, { type: 'sticker', image: sticker.data, content: '[表情]' });
    });
  });
}

/* 问卷作答 */
let pendingQuizRoleId = null;

function sendQuizToChat(quiz, roleId) {
  const rid = roleId || state.activeRoleId || (state.roles[0] && state.roles[0].id);
  if (!rid || !roleById(rid)) { showToast('请先选择一个梦角'); return; }
  chatOf(rid).push({
    id: uid(),
    role: 'user',
    type: 'quiz',
    quiz,
    content: '[问卷] ' + quiz.title,
    ts: Date.now(),
    read: false,
    isAnswered: false
  });
  state.unread[rid] = 0;
  state.activeRoleId = rid;
  persist();
  sendQuizAnswers(quiz, rid);
  routeStack = [];
  currentRoute = { page: 'chat', roleId: rid };
  applyRoute();
}

/* 问卷卡片：第一行 Emoji + 标题，第二行起为题目，选项垂直排列；
 * answers 为空时选项前是空心圆 ○，回答卡片中 TA 选中的选项换成 ✓。 */
function quizCardHTML(quiz, answers, hint, variant) {
  const qs = (quiz && quiz.questions) || [];
  const ans = Array.isArray(answers) ? answers : [];
  return `<div class="bubble quiz-bubble${variant === 'unanswered' ? ' quiz-unanswered' : ''}">
    <div class="qz-head"><span class="qz-emoji">📋</span><span class="qz-title">${esc((quiz && quiz.title) || '问卷')}</span></div>
    ${qs.map((qq, qi) => {
      const raw = ans[qi];
      const picked = Array.isArray(raw) ? raw : (raw == null ? [] : [raw]);
      return `<div class="qz-block">
        <div class="qz-q">${qi + 1}. ${esc(qq.text || '')}</div>
        <div class="qz-opts">${(qq.options || []).map((op, oi) => {
          const on = picked.indexOf(oi) >= 0;
          return `<div class="qz-opt${on ? ' picked' : ''}"><span class="qz-mark">${on ? '✓' : '○'}</span><span class="qz-opt-t">${esc(op)}</span></div>`;
        }).join('')}</div>
      </div>`;
    }).join('')}
    ${hint ? `<div class="quiz-hint">${hint}</div>` : ''}
  </div>`;
}

function sendQuizAnswers(quiz, roleId) {
  /* 按每题的作答模式抽取选项：
   * fixed  → 固定选 fixedCount 个；
   * random → 在 randomMin ~ randomMax 之间随机取一个数量；
   * 兼容旧数据（只有 pick / selectCount）时按固定选择处理；数量不得超过选项总数 */
  const answers = (quiz.questions || []).map(q => {
    const opts = q.options || [];
    if (!opts.length) return [];
    let want;
    if (q.selectMode === 'random') {
      const min = clamp(Math.round(Number(q.randomMin) || 1), 1, opts.length);
      const max = clamp(Math.round(Number(q.randomMax) || min), min, opts.length);
      want = Math.floor(Math.random() * (max - min + 1)) + min;
    } else {
      const legacy = q.fixedCount != null ? q.fixedCount
        : (q.selectCount != null ? q.selectCount : (q.maxSelect != null ? q.maxSelect : q.pick));
      want = clamp(Math.round(Number(legacy) || 1), 1, opts.length);
    }
    want = Math.min(want, opts.length);
    /* 随机打乱后抽取 want 个下标 */
    const pool = opts.map((_, i) => i);
    const picks = [];
    for (let i = 0; i < want && pool.length; i++) {
      picks.push(pool.splice(randInt(0, pool.length - 1), 1)[0]);
    }
    return picks.sort((a, b) => a - b);
  });
  const snapshot = JSON.parse(JSON.stringify({ title: quiz.title, questions: quiz.questions }));
  /* 问卷回答固定单张卡片：不参与字卡拼接与连发条数，只遵循回复时间 */
  taSayAfterDelay(roleId, () => {
    /* 把最近一条尚未回答的问卷标记为已回答：用户侧卡片由主题色底切换为白底 */
    const list = chatOf(roleId);
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].type === 'quiz' && list[i].isAnswered !== true) {
        list[i].isAnswered = true;
        break;
      }
    }
    return {
      type: 'quizAnswer',
      content: '[问卷回答]',
      quiz: snapshot,
      answers
    };
  });
}

/* =========================================================
 * 十二、双向语音通话（本地模拟）
 * ========================================================= */
const callState = {
  status: 'idle',        // idle | incoming | calling | active
  roleId: null,
  direction: null,       // in | out
  startedAt: 0,
  timerId: null,
  ringTimer: null,
  timeoutId: null,
  muted: false,
  failTimer: null,
  minimized: false
};
let incomingScheduler = null;

function getAudioCtx() {
  try {
    if (!window.__dreamAudioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      window.__dreamAudioCtx = new Ctx();
    }
    const ctx = window.__dreamAudioCtx;
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  } catch (e) { return null; }
}

function beep(freq = 880, dur = 0.18, delay = 0, gain = 0.06) {
  const ctx = getAudioCtx();
  if (!ctx) return;
  try {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    osc.connect(g);
    g.connect(ctx.destination);
    const t = ctx.currentTime + delay;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.start(t);
    osc.stop(t + dur + 0.03);
  } catch (e) { /* 忽略音频失败 */ }
}

function startRing() {
  stopRing();
  if (callState.muted) return;
  beep(880, 0.18, 0, 0.07);
  beep(660, 0.18, 0.22, 0.07);
  callState.ringTimer = setInterval(() => {
    if (callState.status !== 'incoming' || callState.muted) return;
    beep(880, 0.18, 0, 0.07);
    beep(660, 0.18, 0.22, 0.07);
  }, 1700);
}

function stopRing() {
  if (callState.ringTimer) {
    clearInterval(callState.ringTimer);
    callState.ringTimer = null;
  }
}

function clearCallTimers() {
  clearInterval(callState.timerId);
  clearTimeout(callState.timeoutId);
  clearTimeout(callState.failTimer);
  callState.timerId = null;
  callState.timeoutId = null;
  callState.failTimer = null;
  stopRing();
}

/* 随机来电判定间隔（分钟）：固定每 3~6 分钟做一次判定，再乘以 callChance 决定是否真正来电。
 * 不暴露给用户调整；维护时改这个常量即可。 */
const INCOMING_CALL_CHECK_MINUTES = [3, 6];

function scheduleIncoming() {
  clearTimeout(incomingScheduler);
  const delay = randInt(INCOMING_CALL_CHECK_MINUTES[0] * 60, INCOMING_CALL_CHECK_MINUTES[1] * 60) * 1000;
  incomingScheduler = setTimeout(() => {
    scheduleIncoming();
    tryIncomingCall();
  }, delay);
}

function tryIncomingCall() {
  if (callState.status !== 'idle') return;
  if (Math.random() * 100 >= Number(state.settings.callChance ?? 60)) return;
  let pool = state.roles.slice();
  if (!pool.length) return;
  startIncomingCall(pickOne(pool).id);
}

function startIncomingCall(roleId) {
  try {
    const role = roleById(roleId);
    if (!role) return;
    if (callState.status !== 'idle') return;
    callState.status = 'incoming';
    callState.roleId = roleId;
    callState.direction = 'in';
    callState.muted = false;
    renderCallOverlay();
    $('#callLayer').classList.add('show');
    startRing();
    /* 页面不可见时弹窗看不到：补一条系统通知（通知开关关闭时内部自动跳过），
     * 通知失败绝不影响来电弹窗本身 */
    try {
      sendSystemNotification(role.name, '邀请你进行语音通话', 'call-in', { page: 'chat', roleId });
    } catch (e) {}
    callState.timeoutId = setTimeout(() => {
      if (callState.status === 'incoming') endCall('missed');
    }, 20000);
  } catch (e) {
    /* 弹窗链路任何异常都不能吞掉整个通话调度器 */
    try {
      if (callState.status === 'incoming') endCall('missed');
      else { callState.status = 'idle'; $('#callLayer').classList.remove('show'); }
    } catch (e2) { callState.status = 'idle'; }
  }
}

function startOutgoingCall(roleId) {
  const role = roleById(roleId);
  if (!role) return;
  if (callState.status !== 'idle') { showToast('正在进行通话，请先结束'); return; }
  callState.status = 'calling';
  callState.roleId = roleId;
  callState.direction = 'out';
  callState.muted = false;
  renderCallOverlay();
  $('#callLayer').classList.add('show');

  callState.timeoutId = setTimeout(() => {
    if (callState.status !== 'calling') return;
    const answered = Math.random() * 100 < Number(state.settings.answerChance ?? 80);
    if (answered) {
      beginActiveCall();
    } else {
      const sub = $('#callSub');
      if (sub) sub.textContent = taName(callState.roleId) + '暂时无法接听…';
      const timer = $('#callTimer');
      if (timer) timer.textContent = '无人接听';
      callState.failTimer = setTimeout(() => {
        if (callState.status === 'calling') endCall('missed');
      }, 1900);
    }
  }, replyDelayMs());
}

function acceptIncomingCall() {
  if (callState.status !== 'incoming') return;
  clearTimeout(callState.timeoutId);
  callState.timeoutId = null;
  beginActiveCall();
}

function beginActiveCall() {
  clearTimeout(callState.timeoutId);
  clearTimeout(callState.failTimer);
  callState.timeoutId = null;
  callState.failTimer = null;
  stopRing();
  callState.status = 'active';
  callState.startedAt = Date.now();
  /* 等待接听/呼叫中小窗接起时，保持小窗形态、更新计时器；否则显示全屏 overlay */
  if (callState.minimized) {
    $('#callLayer').classList.remove('show');
    renderCallMini();
  } else {
    renderCallOverlay();
  }
  startActiveTimer();
  beep(660, 0.12, 0, 0.05);
}

function startActiveTimer() {
  clearInterval(callState.timerId);
  const tick = () => {
    const text = fmtDuration((Date.now() - callState.startedAt) / 1000);
    const el = $('#callTimer');
    if (el) el.textContent = text;
    const mini = $('#miniCallTimer');
    if (mini) mini.textContent = text;
  };
  tick();
  callState.timerId = setInterval(tick, 500);
}

function onCallHangup() {
  if (callState.status === 'incoming') endCall('missed');
  else if (callState.status === 'calling') endCall('cancelled');
  else if (callState.status === 'active') endCall('answered');
}

function endCall(kind) {
  if (callState.status === 'idle') return;
  const roleId = callState.roleId;
  const direction = callState.direction;
  const statusBefore = callState.status;
  const duration = statusBefore === 'active'
    ? Math.max(1, Math.round((Date.now() - callState.startedAt) / 1000))
    : 0;

  clearCallTimers();
  hideCallMini();
  const layer = $('#callLayer');
  layer.classList.remove('show');
  layer.innerHTML = '';
  callState.status = 'idle';
  callState.roleId = null;
  callState.direction = null;
  callState.startedAt = 0;
  callState.muted = false;

  const role = roleById(roleId);
  if (role) {
    const call = { direction, status: kind, duration, roleId };
    chatOf(roleId).push({
      id: uid(),
      role: 'system',
      type: 'call',
      call,
      ts: Date.now(),
      read: true
    });
    if (!(currentRoute.page === 'chat' && currentRoute.roleId === roleId)) {
      state.unread[roleId] = (state.unread[roleId] || 0) + 1;
    }
    /* 未接来电时若页面不可见，补一条通知（开关关闭时内部自动跳过） */
    if (kind === 'missed' && direction === 'in') {
      try {
        sendSystemNotification(role.name, '未接来电：' + role.name + ' 邀请你进行语音通话', 'call-missed', { page: 'chat', roleId });
      } catch (e) {}
    }
    persist();
    renderChatIf(roleId);
    refreshMessagesPage();
  }

  if (kind === 'answered') showToast('通话结束 · ' + fmtDuration(duration));
  else if (kind === 'cancelled') showToast('已取消通话');
  else if (statusBefore === 'incoming') showToast('未接来电');
  else showToast(taName(callState.roleId) + '暂时无法接听');

  scheduleIncoming();
}

function renderCallOverlay() {
  const layer = $('#callLayer');
  const c = callState;
  if (c.status === 'idle') {
    layer.classList.remove('show');
    layer.innerHTML = '';
    return;
  }
  const role = roleById(c.roleId);
  if (!role) return;
  const isImageAvatar = /^(data:image|https?:|blob:)/.test(role.avatar || '');

  let subText = '';
  if (c.status === 'incoming') subText = '邀请你语音通话…';
  else if (c.status === 'calling') subText = '正在呼叫…';
  else subText = '通话中';

  let actions = '';
  if (c.status === 'incoming') {
    actions = `
      <div class="call-col">
        <button class="call-btn reject" data-call-hang>📵</button>
        <div class="call-label">挂断</div>
      </div>
      <div class="call-col">
        <button class="call-btn accept" data-call-accept>📞</button>
        <div class="call-label">接听</div>
      </div>`;
  } else if (c.status === 'calling') {
    actions = `
      <div class="call-col">
        <button class="call-btn hang" data-call-hang>📵</button>
        <div class="call-label">取消</div>
      </div>`;
  } else {
    actions = `
      <div class="call-col">
        <button class="call-btn mute" data-call-mute>${c.muted ? '🔇' : '🔔'}</button>
        <div class="call-label">静音</div>
      </div>
      <div class="call-col">
        <button class="call-btn hang" data-call-hang>📵</button>
        <div class="call-label">挂断</div>
      </div>`;
  }

  layer.innerHTML = `
    <div class="call-screen">
      ${isImageAvatar ? `<div class="call-bg" style="background-image:url('${esc(role.avatar)}')"></div>` : ''}
      <div class="call-tools">
        ${c.status !== 'active' ? `<button data-call-ringmute title="铃声">${c.muted ? '🔇' : '🔔'}</button>` : ''}
        ${c.status !== 'idle' ? `<button data-call-min title="缩小成小窗" aria-label="缩小成小窗"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M5 12h14"/></svg></button>` : ''}
      </div>
      <div class="call-inner">
        <div class="call-kind">语音通话</div>
        <div class="call-avatar">${avatarHTML(role.avatar, 112, '', roleColor(role))}</div>
        <div class="call-name">${esc(role.name)}</div>
        <div class="call-sub" id="callSub">${esc(subText)}</div>
        <div class="call-timer" id="callTimer">${c.status === 'active' ? '00:00' : c.status === 'calling' ? '呼叫中' : '等待接听'}</div>
        <div class="call-actions">${actions}</div>
        <div class="call-tip">本地模拟通话 · 不产生真实语音</div>
      </div>
    </div>`;

  const accept = $('[data-call-accept]', layer);
  if (accept) accept.addEventListener('click', acceptIncomingCall);
  const hang = $('[data-call-hang]', layer);
  if (hang) hang.addEventListener('click', onCallHangup);
  const minBtn = $('[data-call-min]', layer);
  if (minBtn) minBtn.addEventListener('click', minimizeCall);
  const mute = $('[data-call-mute]', layer);
  if (mute) mute.addEventListener('click', () => {
    callState.muted = !callState.muted;
    mute.textContent = callState.muted ? '🔇' : '🔔';
  });
  const ringMute = $('[data-call-ringmute]', layer);
  if (ringMute) ringMute.addEventListener('click', () => {
    callState.muted = !callState.muted;
    ringMute.textContent = callState.muted ? '🔇' : '🔔';
    if (callState.muted) stopRing(); else startRing();
  });
}

/* ===================== 通话小窗（最小化 + 拖动） ===================== */
function minimizeCall() {
  /* 等待接听 / 呼叫中 / 通话中 三种状态都能缩小成小窗 */
  if (callState.status !== 'active' && callState.status !== 'incoming' && callState.status !== 'calling') return;
  callState.minimized = true;
  $('#callLayer').classList.remove('show');
  renderCallMini();
}

function restoreCallOverlay() {
  if (!callState.minimized) return;
  if (callState.status !== 'active' && callState.status !== 'incoming' && callState.status !== 'calling') return;
  hideCallMini();
  $('#callLayer').classList.add('show');
}

function renderCallMini() {
  const mini = $('#callMini');
  const role = roleById(callState.roleId);
  if (!mini || !role) return;
  let statusText = '';
  let timerText = '';
  if (callState.status === 'active') {
    statusText = '通话中';
    timerText = fmtDuration((Date.now() - callState.startedAt) / 1000);
    /* 通话中如果计时器未启动，立即启动一次 */
    if (!callState.timerId && callState.startedAt) startActiveTimer();
  } else if (callState.status === 'incoming') {
    statusText = '等待接听';
    timerText = '等待接听';
  } else if (callState.status === 'calling') {
    statusText = '呼叫中';
    timerText = '呼叫中';
  }
  mini.innerHTML = `
    ${avatarHTML(role.avatar, 34, '', roleColor(role))}
    <div class="mini-info">
      <div class="mini-name">${esc(role.name)}</div>
      <div class="mini-timer" id="miniCallTimer">${timerText}</div>
    </div>
    <button class="mini-hang" id="miniHang" title="挂断" aria-label="挂断">📵</button>`;
  mini.dataset.status = callState.status;
  mini.classList.add('show');
  $('#miniHang').addEventListener('click', e => {
    e.stopPropagation();
    onCallHangup();
  });
}

function hideCallMini() {
  const mini = $('#callMini');
  callState.minimized = false;
  if (!mini) return;
  mini.classList.remove('show', 'dragging');
  mini.innerHTML = '';
  mini.style.left = '';
  mini.style.top = '';
  mini.style.right = '';
  mini.style.bottom = '';
}

/* 拖动绑定一次：pointer 事件同时覆盖鼠标与触屏，touch-action:none 阻止页面滚动 */
let callMiniDragBound = false;
function bindCallMiniDrag() {
  if (callMiniDragBound) return;
  callMiniDragBound = true;
  const mini = $('#callMini');
  const app = $('#app');
  let startX = 0, startY = 0, baseLeft = 0, baseTop = 0, moved = false;

  mini.addEventListener('pointerdown', e => {
    if (!mini.classList.contains('show')) return;
    if (e.target.closest('.mini-hang')) return;
    moved = false;
    const rect = mini.getBoundingClientRect();
    const appRect = app.getBoundingClientRect();
    baseLeft = rect.left - appRect.left;
    baseTop = rect.top - appRect.top;
    startX = e.clientX;
    startY = e.clientY;
    try { mini.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    mini.classList.add('dragging');
    e.preventDefault();
  });
  mini.addEventListener('pointermove', e => {
    if (!mini.classList.contains('dragging')) return;
    if (!mini.hasPointerCapture || !mini.hasPointerCapture(e.pointerId)) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
    const appRect = app.getBoundingClientRect();
    const maxL = Math.max(0, appRect.width - mini.offsetWidth);
    const maxT = Math.max(0, appRect.height - mini.offsetHeight);
    mini.style.right = 'auto';
    mini.style.bottom = 'auto';
    mini.style.left = clamp(baseLeft + dx, 0, maxL) + 'px';
    mini.style.top = clamp(baseTop + dy, 0, maxT) + 'px';
    e.preventDefault();
  });
  mini.addEventListener('pointerup', e => {
    if (!mini.classList.contains('dragging')) return;
    mini.classList.remove('dragging');
    try { if (mini.hasPointerCapture(e.pointerId)) mini.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    if (!moved && !e.target.closest('.mini-hang')) restoreCallOverlay();
  });
  mini.addEventListener('pointercancel', () => mini.classList.remove('dragging'));
}

/* =========================================================
 * 十二·五、桌面首页
 * ========================================================= */
/* 桌面功能图标：统一使用 SVG 线条图标（跟随图标主题的 currentColor） */
const APP_ICONS = {
  messages: '<svg viewBox="0 0 24 24"><path d="M20.5 11.5a8.5 8.5 0 0 1-12.3 7.6L3.5 20l1-4.4A8.5 8.5 0 1 1 20.5 11.5Z"/><path d="M8.5 11h7M8.5 14h4"/></svg>',
  space: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.2"/><ellipse cx="12" cy="12" rx="8.2" ry="3.4" transform="rotate(-24 12 12)"/><circle cx="16.2" cy="8.2" r="1.4"/></svg>',
  beautify: '<svg viewBox="0 0 24 24"><path d="M12 3.5 13.6 9l5.4 1.6-5.4 1.6L12 17.7 10.4 12.2 5 10.6 10.4 9Z"/><path d="M18 16.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7Z"/></svg>',
  cards: '<svg viewBox="0 0 24 24"><rect x="3.2" y="5.2" width="17.6" height="13.6" rx="2.6"/><path d="M7 9.5h7M7 13h10M7 16.2h5"/></svg>',
  stickers: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.4"/><path d="M8.6 14.4a4.4 4.4 0 0 0 6.8 0"/><circle cx="9.2" cy="9.8" r=".9"/><circle cx="14.8" cy="9.8" r=".9"/></svg>',
  letters: '<svg viewBox="0 0 24 24"><rect x="3" y="5.5" width="18" height="13" rx="2.4"/><path d="m4 7.2 8 5.6 8-5.6"/></svg>',
  quizzes: '<svg viewBox="0 0 24 24"><rect x="5" y="4.5" width="14" height="15.5" rx="2.4"/><path d="M9 4.5V3.4h6v1.1M8.8 9.5h6.4M8.8 13h6.4M8.8 16.2h4"/></svg>',
  pomodoro: '<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="7.4"/><path d="M12 13V9.4M9.6 3.6h4.8"/></svg>',
  location: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.4"/><path d="m15.4 8.6-2 5-4.8 1.8 2-5Z"/></svg>',
  storage: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="6.4" rx="7.4" ry="2.8"/><path d="M4.6 6.4v11.2c0 1.6 3.3 2.8 7.4 2.8s7.4-1.2 7.4-2.8V6.4"/><path d="M4.6 12c0 1.6 3.3 2.8 7.4 2.8s7.4-1.2 7.4-2.8"/></svg>',
  probability: '<svg viewBox="0 0 24 24"><path d="M4.5 7h9M17.5 7h2M4.5 12h3M11.5 12h8M4.5 17h9M17.5 17h2"/><circle cx="15.5" cy="7" r="1.8"/><circle cx="9.5" cy="12" r="1.8"/><circle cx="15.5" cy="17" r="1.8"/></svg>',
  /* 互动词云：线条风柱状统计图（尺寸、描边色、线宽统一由 .chat-kebab button svg 控制） */
  wordcloud: '<svg viewBox="0 0 24 24"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
  redpackets: '<svg viewBox="0 0 24 24"><path d="M4.5 8.6h12.6l-3.1-3.1M19.5 15.4H6.9l3.1 3.1"/></svg>',
  wallet: '<svg viewBox="0 0 24 24"><path d="M3.6 7.6A2.4 2.4 0 0 1 6 5.2h10.4a2.4 2.4 0 0 1 2.4 2.4v.8"/><rect x="3.6" y="7.6" width="16.8" height="11.2" rx="2.4"/><circle cx="16.4" cy="13.2" r="1.2"/></svg>',
  ledger: '<svg viewBox="0 0 24 24"><path d="M5 4.6h11.4A2.6 2.6 0 0 1 19 7.2v12.2H7.6A2.6 2.6 0 0 1 5 16.8Z"/><path d="M5 16.8h14M9 8.4h6"/></svg>',
  todo: '<svg viewBox="0 0 24 24"><rect x="4.2" y="4.2" width="15.6" height="15.6" rx="3.6"/><path d="m8.4 12.4 2.5 2.5 4.9-5.6"/></svg>',
  anniversary: '<svg viewBox="0 0 24 24"><rect x="3.6" y="5.2" width="16.8" height="15" rx="2.4"/><path d="M3.6 9.4h16.8M8 3.4v3.4M16 3.4v3.4M12 12.6c.9-1.2 2.6-.7 2.6.7 0 1.3-1.5 2.4-2.6 3.2-1.1-.8-2.6-1.9-2.6-3.2 0-1.4 1.7-1.9 2.6-.7Z"/></svg>',
  snapshots: '<svg viewBox="0 0 24 24"><path d="M4 8.4h3.2l1.4-2h6.8l1.4 2H20a1.6 1.6 0 0 1 1.6 1.6v7.6A1.6 1.6 0 0 1 20 19.2H4a1.6 1.6 0 0 1-1.6-1.6V10A1.6 1.6 0 0 1 4 8.4Z"/><circle cx="12" cy="13.6" r="3.2"/></svg>',
  coin: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.4"/><path d="M12 7.6v8.8M9.6 10h3.6a1.6 1.6 0 0 1 0 3.2H9.8a1.6 1.6 0 0 0 0 3.2h4"/></svg>',
  linktest: '<svg viewBox="0 0 24 24"><path d="M9.4 14.6 14.6 9.4"/><path d="M10.8 7.6 12.2 6.2a3.6 3.6 0 0 1 5.1 5.1l-1.4 1.4M13.2 16.4l-1.4 1.4a3.6 3.6 0 0 1-5.1-5.1l1.4-1.4"/></svg>',
  gifts: '<svg viewBox="0 0 24 24"><rect x="3.4" y="9.4" width="17.2" height="10.4" rx="1.8"/><path d="M2.6 9.4h18.8v3.4H2.6ZM12 9.4v10.4M12 9.4C10.4 5.2 6.4 5 6.4 7.2c0 1.4 2.6 2.2 5.6 2.2Zm0 0c1.6-4.2 5.6-4.4 5.6-2.2 0 1.4-2.6 2.2-5.6 2.2Z"/></svg>',
  pat: '<svg viewBox="0 0 24 24"><path d="M9.3 11.6V6.6a1.7 1.7 0 0 1 3.4 0v4.4"/><path d="M12.7 9.2h1.2a1.6 1.6 0 0 1 1.6 1.6v1h.9a1.7 1.7 0 0 1 1.7 1.7v1.9a4.7 4.7 0 0 1-4.7 4.7h-1.9a4.4 4.4 0 0 1-3.5-1.8l-2.7-3.5a1.4 1.4 0 0 1 2.1-1.8l1.9 1.5"/></svg>',
  /* 小游戏：线条风游戏机 */
  games: '<svg viewBox="0 0 24 24"><path d="M7.2 8.4h9.6a4.6 4.6 0 0 1 4.5 5.5l-.6 2.9a2.7 2.7 0 0 1-4.6 1.3l-1.3-1.5a1.7 1.7 0 0 0-1.3-.6h-3a1.7 1.7 0 0 0-1.3.6l-1.3 1.5a2.7 2.7 0 0 1-4.6-1.3l-.6-2.9A4.6 4.6 0 0 1 7.2 8.4Z"/><path d="M8.7 11v3.2M7.1 12.6h3.2"/><circle cx="15.6" cy="11.5" r=".9"/><circle cx="17.5" cy="13.5" r=".9"/></svg>',
  /* 五子棋：线条风棋盘（一角黑子一角白子） */
  gomoku: '<svg viewBox="0 0 24 24"><rect x="3.4" y="3.4" width="17.2" height="17.2" rx="2.4"/><path d="M3.4 9.1h17.2M3.4 14.9h17.2M9.1 3.4v17.2M14.9 3.4v17.2"/><circle cx="9.1" cy="9.1" r="1.4" fill="currentColor" stroke="none"/><circle cx="14.9" cy="14.9" r="1.4"/></svg>',
  /* 桌面宠物：线条风小猫脸（双耳 + 眼睛 + 嘴 + 胡须） */
  pet: '<svg viewBox="0 0 24 24"><path d="M6.4 10.2 5 4.9a.7.7 0 0 1 1-.8l3.2 2.3M17.6 10.2 19 4.9a.7.7 0 0 0-1-.8l-3.2 2.3"/><path d="M12 6.1c-3.5 0-6.3 2.5-6.3 5.8 0 3.3 2.8 5.6 6.3 5.6s6.3-2.3 6.3-5.6c0-3.3-2.8-5.8-6.3-5.8Z"/><path d="M9.7 11.1v1M14.3 11.1v1M12 13.3v.9"/><path d="M10.7 15.3c.8.6 1.8.6 2.6 0M3.4 12.2l2.3.6M3.6 15l2.2-.4M20.6 12.2l-2.3.6M20.4 15l-2.2-.4"/></svg>',
  settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  phone: '<svg viewBox="0 0 24 24"><path d="M7.2 3.8h2.4l1.2 3.4-1.8 1.4a12 12 0 0 0 5.4 5.4l1.4-1.8 3.4 1.2v2.4a2 2 0 0 1-2.2 2A16.4 16.4 0 0 1 5.2 6a2 2 0 0 1 2-2.2Z"/></svg>',
  smile: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.4"/><path d="M8.6 14.4a4.4 4.4 0 0 0 6.8 0"/><circle cx="9.2" cy="9.8" r=".9"/><circle cx="14.8" cy="9.8" r=".9"/></svg>',
  /* 发图片：图片/相册/山峰样式，与留影的照相机图标明显区分 */
  image: '<svg viewBox="0 0 24 24"><rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2.6"/><circle cx="8.8" cy="9.6" r="1.5"/><path d="m4.2 16.8 4.6-4.6 3.1 3.1 3.3-3.3 4.6 4.6"/></svg>',
  /* 右上角快捷菜单：竖排三个圆点 */
  kebab: '<svg viewBox="0 0 24 24"><circle cx="12" cy="5.2" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="18.8" r="1.6"/></svg>',
  /* 一起做：两个人贴在一起（线条风，两人依偎） */
  readtogether: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  /* 一起读书：打开的书本（线条风，与「两人贴贴」明显区分） */
  readbook: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
  /* 一起听：线条风耳机 */
  listen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><path d="M4 14a2 2 0 0 1 2-2h1v8H6a2 2 0 0 1-2-2Z"/><path d="M20 14a2 2 0 0 0-2-2h-1v8h1a2 2 0 0 0 2-2Z"/></svg>',
  /* 提醒：线条风铃铛 */
  reminder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 16v-5a6 6 0 1 0-12 0v5l-2 2h16Z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>',
  /* 拾光瓶：线条风玻璃瓶（软木塞 + 瓶颈 + 瓶内一颗星） */
  jar: '<svg viewBox="0 0 24 24"><path d="M9.5 3.4h5"/><path d="M10 3.4v4.2c0 .5-.17.98-.5 1.38A5.2 5.2 0 0 0 6.6 13.4v3.4A3.9 3.9 0 0 0 10.5 20.6h3a3.9 3.9 0 0 0 3.9-3.9v-3.4a5.2 5.2 0 0 0-2.9-4.42.9.9 0 0 1-.5-.78V3.4"/><path d="m12 11.6.66 1.46 1.58.17-1.18 1.08.33 1.56L12 15.2l-1.39.67.33-1.56-1.18-1.08 1.58-.17Z"/></svg>',
  /* 检查更新：线条风循环刷新（尺寸与描边由 .app-update-btn svg 统一控制） */
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>'
};

const HOME_APPS = [
  { route: 'messages', label: '消息' },
  { route: 'wallet', label: '钱包' },
  { route: 'space', label: '空间' },
  { route: 'beautify', label: '美化' },
  { route: 'cards', label: '字卡库' },
  { route: 'stickers', label: '表情包' },
  { route: 'letters', label: '信件' },
  { route: 'location', label: '梦角定位' },
  { route: 'storage', label: '存储感知' },
  { route: 'probability', label: '概率与行为' },
  { route: 'todo', label: '待办' },
  { route: 'ledger', label: '记账本' },
  { route: 'anniversary', label: '纪念日' },
  { route: 'snapshots', label: '留影时刻' },
  { route: 'coin', label: '决策' },
  { route: 'linktest', label: '链接测试' },
  { route: 'gifts', label: '送礼物' },
  { route: 'pat', label: '拍一拍' },
  { route: 'pet', label: '桌面宠物' },
  { route: 'readtogether', label: '一起做' },
  { route: 'reminder', label: '提醒' },
  { route: 'jar', label: '拾光瓶' },
  { route: 'settings', label: '设置' }
];

/* 桌面分页容量规则：
 * 第 1 页 8 个，第 2 页 16 个，第 3 页及以后不设容量上限；
 * 页数由应用总数自动推算（totalApps 个 → 页数 = 最多几页能装下） */
const HOME_PAGE_CAPS = [8, 16, Infinity];  /* 0=8, 1=16, 2+=∞ */

/* 计算能装下 N 个应用的最小页数 */
function homePageCountFor(n) {
  if (n <= 0) return 2;                     /* 保底至少 2 页 */
  let remaining = n, pages = 0;
  while (remaining > 0) {
    const cap = HOME_PAGE_CAPS[pages] != null ? HOME_PAGE_CAPS[pages] : Infinity;
    if (cap === Infinity) { pages++; break; }
    if (remaining <= cap) { pages++; break; }
    remaining -= cap;
    pages++;
  }
  return Math.max(pages, 2);                /* 保底 2 页（第二页可能为空） */
}

/* 按容量切分应用列表到各页（返回 pages 数组） */
function splitIntoPages(routes, pageCount) {
  const pages = [];
  let idx = 0;
  for (let p = 0; p < pageCount; p++) {
    const cap = HOME_PAGE_CAPS[p] != null ? HOME_PAGE_CAPS[p] : Infinity;
    const slice = cap === Infinity
      ? routes.slice(idx)
      : routes.slice(idx, idx + cap);
    pages.push(slice);
    if (cap !== Infinity) idx += slice.length;
  }
  return pages;
}

/* 旧版迁移：拍平已有 homePages → 去重 → 补齐缺失 → 按容量重新切分 */
function migrateHomePages(src) {
  const valid = new Set(HOME_APPS.map(a => a.route));
  const existing = [];
  const push = r => { if (valid.has(r) && !existing.includes(r)) existing.push(r); };
  const hp = src && src.homePages;
  if (Array.isArray(hp)) {
    hp.forEach(row => { if (Array.isArray(row)) row.forEach(push); });
  } else if (Array.isArray(src && src.homeAppOrder)) {
    src.homeAppOrder.forEach(push);
  }
  HOME_APPS.forEach(a => push(a.route));   /* 补齐缺失 */
  const pageCount = homePageCountFor(existing.length);
  return splitIntoPages(existing, pageCount);
}

function homeAppsOfPage(p) {
  const pages = (state && Array.isArray(state.homePages)) ? state.homePages : [[], []];
  const map = new Map(HOME_APPS.map(a => [a.route, a]));
  return (pages[p] || []).map(r => map.get(r)).filter(Boolean);
}

/* 当前总页数 */
function homePageTotal() {
  const pages = (state && Array.isArray(state.homePages)) ? state.homePages : [[], []];
  return Math.max(pages.length, 2);
}

let homeEditMode = false;
let homeLongPressAt = 0;   /* 最近一次长按进入编辑模式的时间戳，用来吞掉误触点击 */
let homeDragEndAt = 0;     /* 最近一次同页拖拽结束的时间戳，用来吞掉松手时的点击 */
let homePageIdx = 0;
let homeSwipeSuppress = false;

let homeCalMonth = null;
let homeSelectedDay = '';
let homeClockTimer = null;

function anniversaryDateOf(a) {
  const d = new Date(String(a.date || '') + 'T00:00:00');
  return isNaN(d.getTime()) ? null : d;
}
function anniversaryOccursOn(a, y, m, day) {
  const d = anniversaryDateOf(a);
  if (!d) return false;
  if (a.type === 'once') return d.getFullYear() === y && d.getMonth() === m && d.getDate() === day;
  return d.getMonth() === m && d.getDate() === day;
}
function anniversariesOn(y, m, day) {
  return state.anniversaries.filter(a => anniversaryOccursOn(a, y, m, day));
}
function anniversaryDaysText(a) {
  const d = anniversaryDateOf(a);
  if (!d) return '日期无效';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let target = new Date(d);
  if (a.type !== 'once') {
    target = new Date(today.getFullYear(), d.getMonth(), d.getDate());
    if (target < today) target = new Date(today.getFullYear() + 1, d.getMonth(), d.getDate());
  }
  const diff = Math.round((target - today) / 86400000);
  if (diff === 0) return '就是今天';
  if (diff > 0) return `还有 ${diff} 天`;
  return `已过 ${-diff} 天`;
}

/* 相恋起点：纪念日里被标记 loveStart 的那一条（全局唯一由编辑器保证；删除后自动退回未绑定） */
function loveStartAnn() {
  return (state.anniversaries || []).find(a => a && a.loveStart && anniversaryDateOf(a)) || null;
}
/* 自动相恋天数 = 今天与起点的自然日差，双方都归零到当天 00:00:00 再算，避免时区/小时差导致多算一天 */
function loveDaysAuto() {
  const a = loveStartAnn();
  if (!a) return null;
  const d = anniversaryDateOf(a);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  start.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((today - start) / 86400000));
}

function renderHomePage() {
  const page = $('#page-home');
  if (!page) return;
  const now = new Date();
  if (!homeCalMonth) homeCalMonth = { y: now.getFullYear(), m: now.getMonth() };
  const ym = homeCalMonth;
  const weekNames = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  const startDow = new Date(ym.y, ym.m, 1).getDay();
  const daysInMonth = new Date(ym.y, ym.m + 1, 0).getDate();
  const prevDays = new Date(ym.y, ym.m, 0).getDate();
  let cells = '';
  for (let i = 0; i < startDow; i++) cells += `<div class="cal-day dim">${prevDays - startDow + 1 + i}</div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const isToday = ym.y === now.getFullYear() && ym.m === now.getMonth() && d === now.getDate();
    const key = `${ym.y}-${ym.m}-${d}`;
    const has = anniversariesOn(ym.y, ym.m, d).length > 0;
    /* 日历蓝点：仅当这一天仍有未完成待办时才显示；全部勾选完成后不再显示 */
    const hasTodo = todosOn(ym.y, ym.m, d).some(t => !t.isCompleted);
    const pInfo = periodsOn(ym.y, ym.m, d);
    const dailyList = dailyRemindersOn(ym.y, ym.m, d);
    /* ===== 标记分层 =====
       · 经期（进行中/历史）= redbar 整天浅红底；预测经期 = pred-dot 虚线红圈。
         这两类是「背景装饰」，不占用下方小圆点的名额，优先级最高。
       · 小圆点按「纪念日 > 日常提醒 > 待办」优先级，每类最多 1 个，总数 ≤ 4。
         日常提醒取当天第一个出现的类型的代表色（每类只出 1 个点，避免 3 色点溢出）。 */
    const periodBg = pInfo.periods.length ? '<i class="redbar"></i>'
                    : pInfo.predicted   ? '<i class="pred-dot"></i>' : '';
    const dotMarks = [];
    if (has) dotMarks.push('cdot');                              /* 纪念日：红点 */
    const firstRem = dailyList.find(r => REMINDER_TYPES[r.type]);
    if (firstRem) dotMarks.push(REMINDER_TYPES[firstRem.type].dotCls);  /* 提醒：首个类型颜色 */
    if (hasTodo) dotMarks.push('tdot');                          /* 待办：蓝点 */
    const dotsHtml = dotMarks.slice(0, 4).map(c => `<i class="${c}"></i>`).join('');
    cells += `<div class="cal-day${isToday ? ' today' : ''}${homeSelectedDay === key ? ' sel' : ''}" data-day="${d}">${periodBg}${d}<div class="calendar-dots-container">${dotsHtml}</div></div>`;
  }
  const tail = (7 - (startDow + daysInMonth) % 7) % 7;
  for (let i = 1; i <= tail; i++) cells += `<div class="cal-day dim">${i}</div>`;

  let note = '点击日期查看当天详情；有待办的日期会直接进入待办页；经期/提醒可到「提醒」查看';
  if (homeSelectedDay) {
    const [y, m, d] = homeSelectedDay.split('-').map(Number);
    const list = anniversariesOn(y, m, d);
    const tds = todosOn(y, m, d);
    const parts = [];
    if (list.length) parts.push(list.map(a => `🎗 ${esc(a.name)}`).join('　'));
    if (tds.length) {
      const un = tds.filter(t => !t.isCompleted).length;
      parts.push(`待办 ${tds.length} 条${un ? '（' + un + ' 条未完成）' : '（已完成）'}`);
    }
    /* 经期状态 */
    const period = periodAt(remFmtDate(y, m, d));
    if (period) parts.push(`🩸 经期第 ${period.dayIndex} 天`);
    /* 日常提醒 */
    const dailyList = dailyRemindersOn(y, m, d);
    if (dailyList.length) parts.push(`⏰ ${dailyList.length} 条日常提醒`);
    note = parts.length ? parts.join('　') : `${m + 1}月${d}日没有纪念日与待办`;
  }

  const greet = now.getHours() < 5 ? '夜深了，注意休息' : now.getHours() < 12 ? '早上好' : now.getHours() < 18 ? '下午好' : '晚上好';
  const unreadLetterCount = state.letters.filter(l => !l.read).length;
  const appBtn = app => `<button class="home-app" data-happ="${app.route}"><div class="ic">${APP_ICONS[app.route] || APP_ICONS.settings}</div><div class="lb">${esc(app.label)}</div>${app.route === 'todo' && todoBadgeCount() > 0 ? `<span class="app-badge">${todoBadgeCount() > 99 ? '99+' : todoBadgeCount()}</span>` : ''}${app.route === 'letters' && unreadLetterCount > 0 ? `<span class="app-badge">${unreadLetterCount > 99 ? '99+' : unreadLetterCount}</span>` : ''}</button>`;

  /* ===== 动态分页：按 totalPages 生成每页 section ===== */
  const totalPages = homePageTotal();
  const pageWidthPct = 100 / totalPages;
  const translateX = -(homePageIdx * pageWidthPct);

  /* 生成每页 section 的内部内容 */
  const pageSections = [];
  for (let p = 0; p < totalPages; p++) {
    const apps = homeAppsOfPage(p);
    const gridId = 'homeGrid' + p;
    let inner = '';

    if (p === 0) {
      /* 第一页：hero + quote + couple + 一起听/照片墙 + 功能网格 */
      inner = `
        <div class="home-hero">
          <div class="home-time" id="homeTime">${pad2(now.getHours())}:${pad2(now.getMinutes())}</div>
          <div class="home-date">${now.getMonth() + 1}月${now.getDate()}日 · ${weekNames[now.getDay()]}</div>
          <div class="home-greet">${greet}</div>
        </div>
        <div class="home-quote">
          <div class="qt">${esc(state.homeQuote)}</div>
          <button id="homeQuoteEdit">编辑</button>
        </div>
        <div class="couple-card" id="coupleCard">
          <div class="cp-side">
            <div class="cp-ava" id="cpMeAva" title="点击更换头像">${avatarHTML(state.couple.meAvatar, 52)}</div>
            <div class="cp-nm" id="cpMeName" title="点击编辑名字">${esc(state.couple.meName)}</div>
          </div>
          <div class="cp-mid">
            <div class="cp-t1">已相恋</div>
            <div class="cp-days" id="cpDays" title="点击设置天数">${loveDaysAuto() !== null ? loveDaysAuto() : state.couple.days}<small>天</small></div>
          </div>
          <div class="cp-side">
            <div class="cp-ava" id="cpTaAva" title="点击更换头像">${avatarHTML(state.couple.partnerAvatar, 52)}</div>
            <div class="cp-nm" id="cpTaName" title="点击编辑名字">${esc(state.couple.partnerName)}</div>
          </div>
        </div>
        <div class="home-sec">一起听</div>
        <div class="home-widgets">
          ${musicWidgetHTML()}
          ${photoWallWidgetHTML()}
        </div>
        <div class="home-sec">功能${homeEditMode ? ' · 点图标可移动' : ''}</div>
        <div class="home-grid${homeEditMode ? ' edit-on' : ''}${apps.length ? '' : ' is-empty'}" id="${gridId}">
          ${apps.map(appBtn).join('')}
        </div>`;
    } else if (p === 1) {
      /* 第二页：日历 + 功能网格（去掉原"应用"文字标题） */
      inner = `
        <div class="home-sec" style="margin-top:2px">日历</div>
        <div class="home-card compact" style="margin-top:0">
          <div class="home-card-head">
            <b>${ym.y}年${ym.m + 1}月</b>
            <div class="cal-nav">
              <button id="calPrev" title="上个月">‹</button>
              <button id="calNext" title="下个月">›</button>
            </div>
          </div>
          <div class="cal-week">${['日', '一', '二', '三', '四', '五', '六'].map(w => `<div>${w}</div>`).join('')}</div>
          <div class="cal-grid">${cells}</div>
          <div class="cal-note">${esc(note)}</div>
        </div>
        <div class="home-grid${homeEditMode ? ' edit-on' : ''}${apps.length ? '' : ' is-empty'}" id="${gridId}" style="margin-top:14px">
          ${apps.map(appBtn).join('')}
        </div>`;
    } else {
      /* 第三页及以后：只有功能网格 */
      inner = `
        <div class="home-grid${homeEditMode ? ' edit-on' : ''}${apps.length ? '' : ' is-empty'}" id="${gridId}" style="margin-top:14px">
          ${apps.map(appBtn).join('')}
        </div>`;
    }

    pageSections.push(`<section class="home-page" style="width:${pageWidthPct}%;flex-shrink:0">${inner}</section>`);
  }

  /* dots 动态生成 */
  let dotsHtml = '';
  for (let i = 0; i < totalPages; i++) {
    dotsHtml += `<i class="dot${homePageIdx === i ? ' active' : ''}" data-dot="${i}"></i>`;
  }

  page.innerHTML = `
    <div class="home-topbar">
      ${homeEditMode ? '<button class="home-edit-btn" id="homeEditBtn">完成</button>' : ''}
    </div>
    <div class="home-pager" id="homePager">
      <div class="home-pages" id="homePages" style="width:${totalPages * 100}%;transform:translateX(${translateX}%)">
        ${pageSections.join('')}
      </div>
    </div>
    <div class="home-dots">${dotsHtml}</div>`;

  clearInterval(homeClockTimer);
  homeClockTimer = setInterval(() => {
    const el = document.getElementById('homeTime');
    if (!el || currentRoute.page !== 'home') { clearInterval(homeClockTimer); homeClockTimer = null; return; }
    const t = new Date();
    el.textContent = `${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
  }, 1000);

  const editBtn = $('#homeEditBtn');
  if (editBtn) editBtn.addEventListener('click', () => exitHomeEditMode());
  $('#homeQuoteEdit').addEventListener('click', async () => {
    const v = await promptDialog('编辑这句话', '写一句想对自己说的话', state.homeQuote);
    if (v === null) return;
    state.homeQuote = v || '今天也要好好照顾自己，慢一点也没关系。';
    persist();
    renderHomePage();
    showToast('已保存');
  });

  /* ===== 情侣空间组件：头像 / 名字 / 相恋天数点击自定义，立即持久化 ===== */
  const CP_DEFAULT = { meAvatar: '🧑‍🦰', meName: '我', partnerAvatar: '🧑‍🦱', partnerName: 'TA', days: 100 };
  const cpAvaKey = side => side === 'me' ? 'meAvatar' : 'partnerAvatar';
  const cpNameKey = side => side === 'me' ? 'meName' : 'partnerName';
  const saveCouple = () => { persist(true); renderHomePage(); };
  const editCoupleAvatar = side => {
    const who = side === 'me' ? '我的' : 'TA 的';
    showActionSheet(`${who}头像`, [
      {
        label: '上传本地图片', onClick: async () => {
          const url = await pickImage(320, .85);
          if (!url) return;
          state.couple[cpAvaKey(side)] = url;
          saveCouple();
          showToast('头像已更新');
        }
      },
      {
        label: '输入图片 URL', onClick: async () => {
          const cur = state.couple[cpAvaKey(side)];
          const v = await promptDialog('输入图片 URL', 'https://…', /^(https?:|data:image|blob:)/.test(cur) ? cur : '');
          if (v === null) return;
          const url = v.trim();
          if (url && !/^(https?:|data:image|blob:)/.test(url)) { showToast('请输入有效的图片 URL'); return; }
          state.couple[cpAvaKey(side)] = url || CP_DEFAULT[cpAvaKey(side)];
          saveCouple();
          showToast('头像已更新');
        }
      },
      {
        label: '恢复默认 Emoji', onClick: () => {
          state.couple[cpAvaKey(side)] = CP_DEFAULT[cpAvaKey(side)];
          saveCouple();
          showToast('已恢复默认头像');
        }
      }
    ]);
  };
  const editCoupleName = side => {
    const key = cpNameKey(side);
    const who = side === 'me' ? '我的' : 'TA 的';
    promptDialog(`${who}名字`, '输入名字', state.couple[key]).then(v => {
      if (v === null) return;
      state.couple[key] = v.trim() || CP_DEFAULT[key];
      saveCouple();
      showToast('名字已更新');
    });
  };
  /* 情侣空间：头像 / 名字统一交互 —— 长按 500ms 触发修改，长按抬起不触发任何点击
     · 左侧「我」头像 / 名字：单击无动作，仅长按修改
     · 右侧 TA 头像：单击 → 打开与当前梦角的聊天（保留原功能），长按 → 修改 TA 头像
     · 右侧 TA 名字：长按修改名字
     事件 stopPropagation 防止误触外层 couple-card / home 编辑监听 */
  const coupleLongPress = (el, onLongPress, onClick) => {
    if (!el) return;
    let lpTimer = null;
    let fired = false;
    const cancel = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
    /* 彻底屏蔽浏览器长按弹出的系统菜单（复制/存储图片等） */
    el.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); });
    el.addEventListener('pointerdown', e => {
      if (typeof e.button === 'number' && e.button > 0) return;
      fired = false;
      cancel();
      lpTimer = setTimeout(() => { lpTimer = null; fired = true; onLongPress(); }, 500);
    });
    el.addEventListener('pointerup', cancel);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('pointerleave', cancel);
    el.addEventListener('click', e => {
      e.stopPropagation();
      /* 长按已触发 → 吞掉紧随其后的 click，松开手指不会触发任何点击 */
      if (fired) { fired = false; e.preventDefault(); return; }
      if (onClick) onClick();
    });
  };

  const cpJumpChat = () => {
    const roleId = state && (state.activeRoleId || (state.roles && state.roles[0] && state.roles[0].id));
    if (!roleId) { showToast('还没有绑定的梦角哦'); return; }
    openChat(roleId);
  };

  coupleLongPress($('#cpMeAva'), () => editCoupleAvatar('me'));
  coupleLongPress($('#cpMeName'), () => editCoupleName('me'));
  coupleLongPress($('#cpTaAva'), () => editCoupleAvatar('ta'), cpJumpChat);
  coupleLongPress($('#cpTaName'), () => editCoupleName('ta'));
  $('#cpDays').addEventListener('click', async () => {
    /* 已绑定相恋起点 → 天数自动计算，不再手动输入，提示并可直接跳转纪念日页 */
    if (loveStartAnn()) {
      const go = await confirmDialog('已自动计算', '相恋天数已与纪念日绑定，去【纪念日】修改相恋起点日期。', '去纪念日');
      if (go) navigate({ page: 'sub', name: 'anniversary' });
      return;
    }
    const v = await promptDialog('相恋天数', '输入数字', String(state.couple.days));
    if (v === null) return;
    const n = Math.round(Number(v.trim()));
    if (!Number.isFinite(n) || n < 0) { showToast('请输入不小于 0 的数字'); return; }
    state.couple.days = clamp(n, 0, 99999);
    saveCouple();
    showToast('相恋天数已更新');
  });
  $('#calPrev').addEventListener('click', () => {
    homeCalMonth = { y: ym.m === 0 ? ym.y - 1 : ym.y, m: ym.m === 0 ? 11 : ym.m - 1 };
    homeSelectedDay = '';
    renderHomePage();
  });
  $('#calNext').addEventListener('click', () => {
    homeCalMonth = { y: ym.m === 11 ? ym.y + 1 : ym.y, m: ym.m === 11 ? 0 : ym.m + 1 };
    homeSelectedDay = '';
    renderHomePage();
  });
  $$('.cal-day[data-day]', page).forEach(el => el.addEventListener('click', () => {
    const d = Number(el.dataset.day);
    /* 当天有待办：直接进入待办页并定位到该日（YYYY-MM-DD，月 +1） */
    if (todosOn(ym.y, ym.m, d).length) {
      todoFocusDate = ym.y + '-' + pad2(ym.m + 1) + '-' + pad2(d);
      navigate({ page: 'sub', name: 'todo' });
      return;
    }
    homeSelectedDay = `${ym.y}-${ym.m}-${el.dataset.day}`;
    renderHomePage();
  }));

  /* 所有页图标：长按任意 App 进入编辑模式（iPhone 桌面式摇晃）；编辑态点击图标弹出操作菜单 */
  const totalPagesBind = homePageTotal();
  for (let gi = 0; gi < totalPagesBind; gi++) {
    const sel = '#homeGrid' + gi;
    const grid = $(sel);
    if (!grid) continue;
    $$('.home-app', grid).forEach(el => {
      el.addEventListener('click', e => {
        /* 长按进入编辑 / 拖拽换位刚结束 → 吞掉紧随其后的这次点击，避免误开 App */
        if (Date.now() - homeLongPressAt < 400 || Date.now() - homeDragEndAt < 400) { e.preventDefault(); return; }
        if (homeSwipeSuppress) { homeSwipeSuppress = false; e.preventDefault(); return; }
        if (homeEditMode) { e.preventDefault(); openHomeAppMenu(el.dataset.happ); return; }
        openHomeApp(el.dataset.happ);
      });
      /* 非编辑态：长按 0.5 秒进入编辑模式；编辑态：按住图标直接拖拽，拖到别的图标上即时换位 */
      let lpTimer = null;
      const cancelLP = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
      el.addEventListener('pointerdown', e => {
        if (typeof e.button === 'number' && e.button > 0) return;
        if (homeEditMode) { startHomeDrag(el, e); return; }
        cancelLP();
        lpTimer = setTimeout(() => { lpTimer = null; enterHomeEditMode(); }, 500);
      });
      /* 手指移动超过 10px 视为滑动翻页/滚动，取消长按——
         安卓修复后横向滑动不再派发 pointercancel，必须在这里主动取消，否则滑动途中误进编辑态 */
      let lpX = 0, lpY = 0;
      el.addEventListener('pointerdown', e => { lpX = e.clientX; lpY = e.clientY; });
      el.addEventListener('pointermove', e => {
        if (!lpTimer) return;
        if (Math.abs(e.clientX - lpX) > 10 || Math.abs(e.clientY - lpY) > 10) cancelLP();
      });
      el.addEventListener('pointerup', cancelLP);
      el.addEventListener('pointercancel', cancelLP);
      el.addEventListener('pointerleave', cancelLP);
    });
  }

  /* 编辑态：点击桌面空白处退出编辑 */
  $$('.home-page', page).forEach(pg => pg.addEventListener('click', e => {
    if (!homeEditMode) return;
    if (Date.now() - homeLongPressAt < 400) return;
    if (e.target.closest('.home-app')) return;
    if (e.target.closest('button')) return;
    exitHomeEditMode();
  }));

  /* 左右滑动 / 圆点切换分页；滑动后抑制误触点击。
     安卓修复：touch-action:pan-y（CSS）保证横向手势不被浏览器抢走。
     关键教训：绝不能 pointerdown 就 setPointerCapture —— click 也是 PointerEvent，
     捕获会把 click 重定向到 pager 本身，电脑端所有桌面图标点击全部失效（本次回归根因）。
     正确做法：确认是横向翻页手势后再捕获，普通点击不受影响 */
  const pager = $('#homePager');
  let swX = 0, swY = 0, swOn = false, swMoved = false;
  pager.addEventListener('pointerdown', e => {
    if (homeEditMode) { swOn = false; return; }
    swOn = true; swMoved = false; swX = e.clientX; swY = e.clientY;
  });
  pager.addEventListener('pointermove', e => {
    if (!swOn) return;
    const dx = e.clientX - swX, dy = e.clientY - swY;
    /* 方向判定：只有横向位移明显大于纵向才视为翻页手势，纵向滑动不干预（也不 preventDefault） */
    if (Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy)) {
      if (!swMoved) {
        swMoved = true;
        /* 确认横向滑动手势后才捕获指针：滑动途中 move/up 稳定送达（安卓），点击场景走不到这里 */
        try { pager.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      }
    }
  });
  const swEnd = e => {
    if (!swOn) return;
    swOn = false;
    if (!swMoved) return;
    homeSwipeSuppress = true;
    setTimeout(() => { homeSwipeSuppress = false; }, 350);
    const dx = e.clientX - swX;
    const totalPages = homePageTotal();
    if (dx < -50 && homePageIdx < totalPages - 1) setHomePage(homePageIdx + 1);
    else if (dx > 50 && homePageIdx > 0) setHomePage(homePageIdx - 1);
  };
  pager.addEventListener('pointerup', swEnd);
  pager.addEventListener('pointercancel', () => { swOn = false; });
  $$('.home-dots .dot', page).forEach(d => d.addEventListener('click', () => setHomePage(Number(d.dataset.dot))));

  /* 桌面一起听组件 / 照片墙：图标与上传交互 */
  bindHomeWidgets(page);
}

function setHomePage(i) {
  const totalPages = homePageTotal();
  homePageIdx = clamp(Number(i) || 0, 0, totalPages - 1);
  const pages = $('#homePages');
  if (pages) {
    const pct = 100 / totalPages;
    pages.style.transform = `translateX(${-(homePageIdx * pct)}%)`;
  }
  $$('.home-dots .dot').forEach(d => d.classList.toggle('active', Number(d.dataset.dot) === homePageIdx));
}

function openHomeApp(route) {
  if (route === 'messages' || route === 'space') switchTab(route);
  else navigate({ page: 'sub', name: route });
}

/* 桌面编辑模式：长按图标进入（图标摇晃），点空白处或「完成」退出 */
function enterHomeEditMode() {
  if (homeEditMode) return;
  homeEditMode = true;
  homeLongPressAt = Date.now();
  renderHomePage();
  showToast('编辑模式：点图标可移动，点空白处完成');
  try { if (navigator.vibrate) navigator.vibrate(12); } catch (e) {}
}

function exitHomeEditMode() {
  if (!homeEditMode) return;
  homeEditMode = false;
  renderHomePage();
}

/* ===== 编辑态：同页拖拽排序（pointer 事件，手指 / 鼠标通用） ===== */
function startHomeDrag(el, e) {
  const grid = el.closest('.home-grid');
  if (!grid) return;
  let moved = false;
  let lastTarget = null;

  const onMove = ev => {
    if (!moved) {
      if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
      moved = true;
      el.classList.add('dragging');
    }
    if (ev.cancelable) ev.preventDefault();
    const hit = document.elementFromPoint(ev.clientX, ev.clientY);
    const target = hit && hit.closest ? hit.closest('.home-app') : null;
    if (!target || target === el || target.parentElement !== grid) { lastTarget = null; return; }
    if (target === lastTarget) return;
    lastTarget = target;
    const r = target.getBoundingClientRect();
    /* 指针落在目标图标左半边 → 插到它前面，否则插到它后面：拖过去即换位 */
    grid.insertBefore(el, ev.clientX < r.left + r.width / 2 ? target : target.nextElementSibling);
  };

  const finish = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', finish);
    document.removeEventListener('pointercancel', finish);
    el.classList.remove('dragging');
    if (!moved) return;                     /* 只是点一下 → 交给 click 打开菜单 */
    homeDragEndAt = Date.now();             /* 400ms 内吞掉点击，防止松手误开应用 */
    saveHomeOrder();                        /* 立刻写入本地存储 */
  };

  document.addEventListener('pointermove', onMove, { passive: false });
  document.addEventListener('pointerup', finish);
  document.addEventListener('pointercancel', finish);
}

/* 把当前所有页的图标顺序写回 state 并立即持久化（刷新不丢失） */
function saveHomeOrder() {
  const totalPages = homePageTotal();
  const newPages = [];
  for (let i = 0; i < totalPages; i++) {
    const grid = document.getElementById('homeGrid' + i);
    newPages.push(grid ? $$('.home-app', grid).map(x => x.dataset.happ).filter(Boolean) : []);
  }
  /* 兜底：如果一个 grid 都找不到，别覆盖 */
  if (newPages.every(p => p.length === 0)) return;
  state.homePages = newPages;
  persist(true);
}

/* 编辑态点击图标：弹出操作菜单，支持跨任意页迁移 */
function openHomeAppMenu(route) {
  const app = HOME_APPS.find(a => a.route === route);
  if (!app) return;
  const pages = state.homePages;
  const totalPages = Math.max(pages.length, 2);
  let from = -1;
  for (let i = 0; i < pages.length; i++) { if (pages[i] && pages[i].includes(route)) { from = i; break; } }
  if (from < 0) return;

  /* 动态生成"移至第 N 页"选项（排除当前页） */
  const moveOptions = [];
  for (let p = 0; p < totalPages; p++) {
    if (p === from) continue;
    moveOptions.push({
      label: '移至第' + (p + 1) + '页',
      onClick: () => {
        pages[from] = pages[from].filter(r => r !== route);
        /* 确保目标页存在 */
        while (pages.length <= p) pages.push([]);
        pages[p].push(route);
        persist();
        renderHomePage();
        showToast('已移到第' + (p + 1) + '页');
      }
    });
  }
  showActionSheet(app.label, moveOptions.concat([{ label: '完成编辑', onClick: () => exitHomeEditMode() }]));
}

/* =========================================================
 * 十二·六、一起听（全局唯一 Audio + objectURL 歌单）
 * 关键约束：
 * 1. 整个模块只创建一个 Audio 对象，页面来回切换不中断播放；
 * 2. 音频 Blob URL 只存在内存，绝不写入 localStorage；移除 / 刷新前 revoke；
 * 3. 任何 audio.play() 都只在用户点击（播放 / 切歌 / 点歌单）中调用，避免自动播放拦截。
 * ========================================================= */
const PHOTO_WALL_MAX = 1;
const MUSIC_ICONS = {
  prev: '<svg viewBox="0 0 24 24"><path d="M7 5v14"/><path d="M18 6.5 10 12l8 5.5Z"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M17 5v14"/><path d="M6 6.5 14 12 6 17.5Z"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M8 5.4v13.2L19 12Z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M9 6v12M15 6v12"/></svg>',
  list: '<svg viewBox="0 0 24 24"><path d="M4 7h12M4 12h12M4 17h7"/><circle cx="18" cy="17" r="2.2"/><path d="M20.2 17V7.5"/></svg>'
};
const MUSIC_MODE_META = {
  sequence: {
    label: '顺序播放',
    /* 标准「循环圈」图标：与单曲循环同形，但中间没有数字 1 */
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"></path><path d="M3 11v-1a4 4 0 0 1 4-4h14"></path><path d="m7 22-4-4 4-4"></path><path d="M21 13v1a4 4 0 0 1-4 4H3"></path></svg>'
  },
  loop: {
    label: '单曲循环',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"></path><path d="M3 11v-1a4 4 0 0 1 4-4h14"></path><path d="m7 22-4-4 4-4"></path><path d="M21 13v1a4 4 0 0 1-4 4H3"></path><path d="M11 10h1v5"></path></svg>'
  },
  random: {
    label: '随机播放',
    icon: '<svg viewBox="0 0 24 24"><path d="M4 7h3.5l9 10H20M20 7h-3.5l-2.4 2.7M4 17h3.5l2.4-2.7"/><path d="M17.5 5.5 20 7l-2.5 1.5M17.5 15.5 20 17l-2.5 1.5"/></svg>'
  }
};

let musicAudio = null;       /* 全局唯一的音乐 Audio */
let musicTracks = [];        /* 运行时歌单：{ id, name, displayName, url, size } */
let musicIndex = -1;
let musicSeeking = false;    /* 进度条拖拽中：暂停 timeupdate 回写，避免 thumb 跳动 */
let musicBubbleTimer = null;
let musicBubbleHideTimer = null;
const musicUrls = new Set(); /* 当前会话创建的 Blob URL，统一 revoke */

function musicRole() {
  return roleById(state.activeRoleId) || state.roles[0] || null;
}
function musicTrack() {
  return musicTracks[musicIndex] || null;
}
function musicDisplayName() {
  const t = musicTrack();
  if (t) return t.displayName || t.name;
  return state.music.name || '';
}
function musicIsPlaying() {
  return !!(musicAudio && !musicAudio.paused && !musicAudio.ended);
}

/* =========================================================
 * 唱片中心图：主界面与桌面 3×2 组件共用同一份数据
 * 上传后写入当前歌曲（同时保留 state.music.cover 作为兜底）
 * ========================================================= */
function musicCoverURL() {
  const t = musicTrack();
  return (t && t.cover) || state.music.cover || '';
}

function musicSetCover(url) {
  state.music.cover = url || '';
  const t = musicTrack();
  if (t) t.cover = state.music.cover;
  musicPersistList();
  persist(true);
}

/* 直接改两个界面的中心图 src，不整页重绘，避免页面跳动 */
function musicUpdateCoverUI() {
  const url = musicCoverURL();
  const btn = document.getElementById('listenCover');
  if (btn) {
    btn.classList.toggle('no-cover', !url);
    let img = btn.querySelector('img');
    if (url) {
      if (!img) {
        btn.innerHTML = '<img alt="唱片封面">';
        img = btn.querySelector('img');
      }
      if (img.getAttribute('src') !== url) img.setAttribute('src', url);
    } else {
      if (img) img.remove();
      if (!btn.querySelector('.ls-cover-note')) {
        btn.innerHTML = '<span class="ls-cover-note">♪</span>';
      }
    }
  }
  const wv = document.getElementById('homeMusicVinyl');
  if (wv) {
    let img = wv.querySelector('img');
    if (url) {
      if (!img) {
        img = document.createElement('img');
        img.alt = '唱片封面';
        wv.insertBefore(img, wv.firstChild);
      }
      if (img.getAttribute('src') !== url) img.setAttribute('src', url);
      const note = wv.querySelector('.mw-note');
      if (note) note.remove();
    } else {
      if (img) img.remove();
      if (!wv.querySelector('.mw-note')) {
        const note = document.createElement('span');
        note.className = 'mw-note';
        note.textContent = '♪';
        wv.appendChild(note);
      }
    }
  }
}

/* 点击任意黑胶中心：触发 index.html 里的隐藏图片选择器 */
function openMusicCoverPicker() {
  const input = document.getElementById('musicCoverInput');
  if (!input) { showToast('缺少图片选择器'); return; }
  input.value = '';
  input.click();
}

async function musicApplyCoverFile(file) {
  if (!file || !/^image\//.test(file.type || '')) {
    showToast('请选择图片文件');
    return;
  }
  try {
    const raw = await readFileAsDataURL(file);
    const url = await compressDataURL(raw, 320, .82);
    musicSetCover(url);
    musicUpdateCoverUI();
    showToast('唱片中心图片已更新');
  } catch (e) {
    showToast('图片读取失败，请换一张试试');
  }
}

/* =========================================================
 * LRC 歌词解析
 * 支持 [mm:ss]、[mm:ss.xx]、[mm:ss.xxx]、一行多时间标签、[offset:] 校正；
 * 元数据标签（[ti:] 等）自动忽略，文本只存原文并做体积上限保护。
 * ========================================================= */
const MUSIC_LRC_MAX = 12000;

function parseLRC(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '');
  let offsetMs = 0;
  const off = raw.match(/^\[offset:([+-]?\d{1,6})\]/im);
  if (off) offsetMs = Number(off[1]) || 0;
  const out = [];
  const tagRe = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  raw.split(/\r?\n/).forEach(line => {
    const src = line.trim();
    if (!src) return;
    const stamps = [];
    let m;
    tagRe.lastIndex = 0;
    while ((m = tagRe.exec(src))) {
      const min = Number(m[1]) || 0;
      const sec = Number(m[2]) || 0;
      const ms = m[3] ? Number(m[3].padEnd(3, '0').slice(0, 3)) : 0;
      stamps.push(min * 60 + sec + ms / 1000);
    }
    if (!stamps.length) return;
    const content = src.replace(tagRe, '').replace(/\s+/g, ' ').trim();
    if (!content) return;
    stamps.forEach(t => out.push({ t: Math.max(0, t + offsetMs / 1000), text: content }));
  });
  out.sort((a, b) => a.t - b.t);
  return out.filter((x, i, arr) => i === 0 || x.t !== arr[i - 1].t || x.text !== arr[i - 1].text);
}

function musicSetLyricText(track, raw) {
  if (!track) return 0;
  const text = String(raw || '').slice(0, MUSIC_LRC_MAX);
  const lines = parseLRC(text);
  track.lrc = text;
  track.lyrics = lines;
  return lines.length;
}

function musicReadTextFile(file) {
  return new Promise(resolve => {
    try {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => resolve('');
      fr.readAsText(file, 'utf-8');
    } catch (e) { resolve(''); }
  });
}

/* 当前时间对应的歌词行：二分查找最后一条 t <= currentTime 的记录 */
function musicCurrentLyricText(sec) {
  const t = musicTrack();
  if (!t || !Array.isArray(t.lyrics) || !t.lyrics.length) return '';
  const cur = Number(sec) || 0;
  let lo = 0, hi = t.lyrics.length - 1, hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t.lyrics[mid].t <= cur + 0.12) { hit = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return hit >= 0 ? t.lyrics[hit].text : '';
}

/* 桌面组件显示：前 15 个字，无歌词时显示“暂无歌词” */
function musicLyricDisplay() {
  const t = musicTrack();
  if (!t || !Array.isArray(t.lyrics) || !t.lyrics.length) return '暂无歌词';
  const line = musicAudio ? musicCurrentLyricText(musicAudio.currentTime) : '';
  return line ? Array.from(line).slice(0, 15).join('') : '暂无歌词';
}

/* 主界面歌词：完整显示当前唱到的一句 */
function musicLyricFullDisplay() {
  const t = musicTrack();
  if (!t || !Array.isArray(t.lyrics) || !t.lyrics.length) return '暂无歌词';
  const line = musicAudio ? musicCurrentLyricText(musicAudio.currentTime) : '';
  return line || '暂无歌词';
}

/* 同步桌面歌词（15 字）与一起听主界面歌词（完整一句）；timeupdate / 拖拽进度都会调用 */
function musicUpdateLyricLine() {
  const homeEl = $('#homeMusicLyric');
  if (homeEl) {
    const text = musicLyricDisplay();
    if (homeEl.textContent !== text) homeEl.textContent = text;
  }
  const pageEl = $('#listenLyric');
  if (pageEl) {
    const text = musicLyricFullDisplay();
    if (pageEl.textContent !== text) pageEl.textContent = text;
  }
}

/* 全局唯一 Audio：事件只绑一次；play / pause 驱动所有界面同步 */
function musicEnsureAudio() {
  if (musicAudio) return musicAudio;
  musicAudio = new Audio();
  musicAudio.preload = 'auto';
  musicAudio.addEventListener('play', musicSyncState);
  musicAudio.addEventListener('pause', musicSyncState);
  musicAudio.addEventListener('ended', musicHandleEnded);
  musicAudio.addEventListener('loadedmetadata', musicSyncProgress);
  musicAudio.addEventListener('timeupdate', () => { if (!musicSeeking) musicSyncProgress(); });
  musicAudio.addEventListener('error', () => {
    if (musicTrack()) showToast('音频加载失败，请重新上传这首歌');
  });
  return musicAudio;
}

/* 首次进入时把持久化的歌单元数据还原成运行时列表（不含音频，Blob 无法跨刷新） */
function musicTracksInit() {
  const list = (state.music && Array.isArray(state.music.list)) ? state.music.list : [];
  musicTracks = list.map(t => ({
    id: t.id,
    name: t.name,
    displayName: t.displayName || '',
    lrc: t.lrc || '',
    lyrics: parseLRC(t.lrc || ''),
    cover: t.cover || '',
    url: '',
    size: 0
  }));
  musicIndex = musicTracks.length ? 0 : -1;
}

/* 只把歌名与歌词同步回 state（音频 Blob URL 绝不写入） */
function musicPersistList() {
  state.music.list = musicTracks.map(t => ({
    id: t.id,
    name: t.name,
    displayName: t.displayName || '',
    lrc: (t.lrc || '').slice(0, 12000),
    cover: t.cover || ''
  }));
  persist();
}

/* 播放进度：timeupdate / loadedmetadata 统一刷新秒数与滑杆填充 */
function musicSyncProgress() {
  const audio = musicAudio;
  const seek = $('#listenSeek');
  if (!audio) { musicUpdateLyricLine(); return; }
  const dur = (Number.isFinite(audio.duration) && audio.duration > 0) ? audio.duration : 0;
  const cur = Math.max(0, Number.isFinite(audio.currentTime) ? audio.currentTime : 0);
  const curEl = $('#listenCur');
  const durEl = $('#listenDur');
  if (curEl) curEl.textContent = fmtDuration(cur);
  if (durEl) durEl.textContent = dur ? fmtDuration(dur) : '00:00';
  if (seek && !musicSeeking) {
    const pct = dur > 0 ? clamp(cur / dur, 0, 1) : 0;
    seek.value = String(Math.round(pct * 1000));
    seek.style.setProperty('--seek-pct', (pct * 100).toFixed(2) + '%');
  }
  musicUpdateLyricLine();
}

/* 歌名 / 封面 / 歌单数量同步到一起听页 */
function musicUpdateName() {
  const nameEl = $('#listenName');
  if (nameEl) nameEl.textContent = musicDisplayName() || '还没有选择歌曲';
  const sub = $('#listenSub');
  if (sub) {
    if (!musicTracks.length) sub.textContent = '还没有歌曲，点右下角「播放列表」添加';
    else if (musicTracks.some(t => !t.url)) sub.textContent = `${musicTracks.length} 首 · 刷新后音频需重新上传 · 点击歌名可改名`;
    else sub.textContent = `${musicTracks.length} 首 · 点击歌名可改名`;
  }
  const coverBtn = $('#listenCover');
  if (coverBtn) musicUpdateCoverUI();
  const homeName = $('#homeMusicName');
  if (homeName) homeName.textContent = musicDisplayName() || '还没有歌曲';
  musicUpdateLyricLine();
}

function musicUpdateModeButton() {
  const btn = $('#listenMode');
  if (!btn) return;
  const meta = MUSIC_MODE_META[state.music.playMode] || MUSIC_MODE_META.sequence;
  btn.innerHTML = `${meta.icon}<span>${meta.label}</span>`;
}

/* 播放 / 暂停状态：只同步按钮图标与气泡；黑胶旋转由 CSS 常驻动画负责 */
function musicSyncState() {
  const playing = musicIsPlaying();
  const icon = playing ? MUSIC_ICONS.pause : MUSIC_ICONS.play;
  const lp = $('#listenPlay');
  if (lp) lp.innerHTML = icon;
  const wt = $('#homeMusicToggle');
  if (wt) wt.innerHTML = icon;
  if (playing) {
    if (!musicBubbleTimer) musicScheduleBubble();
  } else {
    clearTimeout(musicBubbleTimer);
    musicBubbleTimer = null;
  }
}

function musicSyncAll() {
  musicSyncState();
  musicSyncProgress();
  musicUpdateModeButton();
  musicUpdateName();
  musicRenderSheetIfOpen();
}

/* 播放时按 60~150 秒的随机间隔，从主字卡库抽一句话冒气泡 */
function musicScheduleBubble() {
  clearTimeout(musicBubbleTimer);
  musicBubbleTimer = setTimeout(() => {
    musicBubbleTimer = null;
    if (!musicIsPlaying()) return;
    if (currentRoute && currentRoute.page === 'sub' && currentRoute.name === 'listen') {
      const role = musicRole();
      const text = role ? (composeCardText(role.id) || '我在，慢慢听。') : '我在，慢慢听。';
      showListenBubble(text);
    }
    musicScheduleBubble();
  }, randInt(60, 150) * 1000);
}

function showListenBubble(text) {
  const b = $('#listenBubble');
  if (!b) return;
  b.textContent = text;
  b.classList.add('show');
  clearTimeout(musicBubbleHideTimer);
  musicBubbleHideTimer = setTimeout(() => {
    const b2 = $('#listenBubble');
    if (b2) b2.classList.remove('show');
  }, 4600);
}

/* 播放指定歌曲；autoplay 只在用户点击链路中传 true */
function musicPlayIndex(i, autoplay) {
  const track = musicTracks[i];
  if (!track) return;
  if (!track.url) {
    showToast('这首歌的音频已失效，请点播放列表右上角 ＋ 重新上传');
    return;
  }
  const audio = musicEnsureAudio();
  musicIndex = i;
  if (audio.dataset.musicId !== track.id) {
    try { audio.pause(); } catch (e) { /* 忽略 */ }
    audio.src = track.url;
    audio.dataset.musicId = track.id;
    audio.currentTime = 0;
  }
  state.music.name = track.displayName || track.name;
  persist();
  if (autoplay) {
    const p = audio.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => showToast('播放被系统拦截，请再点一次播放'));
    }
  }
  musicSyncAll();
}

function musicTogglePlay() {
  const audio = musicEnsureAudio();
  const cur = musicTrack();
  if (!cur || !cur.url) {
    /* 当前曲目无效（例如刷新后未重新上传）：找第一首可播放的 */
    let first = -1;
    for (let i = 0; i < musicTracks.length; i++) {
      if (musicTracks[i].url) { first = i; break; }
    }
    if (first < 0) {
      showToast('先添加一首歌吧');
      openMusicPlaylist();
      return;
    }
    musicPlayIndex(first, true);
    return;
  }
  if (audio.paused) {
    const p = audio.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => showToast('播放被系统拦截，请再点一次播放'));
    }
  } else {
    audio.pause();
  }
}

/* 上一首 / 下一首：只在可播放曲目之间循环 */
function musicStep(dir) {
  const playable = [];
  musicTracks.forEach((t, i) => { if (t.url) playable.push(i); });
  if (!playable.length) {
    showToast('音频已失效，请重新上传');
    openMusicPlaylist();
    return;
  }
  let pos = playable.indexOf(musicIndex);
  if (pos < 0) pos = dir > 0 ? -1 : 0;
  const nextPos = (pos + dir + playable.length) % playable.length;
  musicPlayIndex(playable[nextPos], true);
}

/* 播放结束：按三种播放模式分流 */
function musicHandleEnded() {
  const mode = state.music.playMode;
  const audio = musicEnsureAudio();
  if (!musicTracks.length) return;
  if (mode === 'loop') {
    audio.currentTime = 0;
    const p = audio.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
    return;
  }
  if (mode === 'random') {
    const playable = [];
    musicTracks.forEach((t, i) => { if (t.url) playable.push(i); });
    if (!playable.length) return;
    let pick = playable[randInt(0, playable.length - 1)];
    if (playable.length > 1 && pick === musicIndex) {
      pick = playable[(playable.indexOf(musicIndex) + 1) % playable.length];
    }
    musicPlayIndex(pick, true);
    return;
  }
  /* sequence：播下一首，最后一首播完就停止 */
  let next = -1;
  for (let i = musicIndex + 1; i < musicTracks.length; i++) {
    if (musicTracks[i].url) { next = i; break; }
  }
  if (next >= 0) {
    musicPlayIndex(next, true);
  } else {
    try { audio.pause(); audio.currentTime = 0; } catch (e) { /* 忽略 */ }
    musicSyncAll();
  }
}

function musicCycleMode() {
  const order = ['sequence', 'loop', 'random'];
  const cur = order.indexOf(state.music.playMode);
  state.music.playMode = order[(cur + 1) % order.length];
  persist();
  musicUpdateModeButton();
  showToast('播放模式：' + (MUSIC_MODE_META[state.music.playMode] || MUSIC_MODE_META.sequence).label);
}

/* 多选上传：每个文件生成 objectURL，只登记运行时列表 */
async function musicAddFiles(files) {
  const all = Array.from(files || []);
  /* 文件选择器已去掉 accept 限制（iOS 会因类型限制把文件置灰），
     这里统一按文件名后缀识别，兼容系统不返回 MIME 的情况 */
  const isAudioName = name => /\.(mp3|m4a|aac|wav|ogg|flac|webm|opus|amr|aiff|aif|wma|ape|mid|midi)$/i.test(name || '');
  const isLyricName = name => /\.(lrc|txt)$/i.test(name || '');
  const lyricFiles = all.filter(f => f && isLyricName(f.name));
  const list = all.filter(f => f && (isAudioName(f.name) || (!isLyricName(f.name) && /^audio\//.test(f.type || ''))));
  if (!list.length && !lyricFiles.length) {
    showToast('请选择音频文件（.mp3 / .wav / .m4a / .flac）或 .lrc 歌词');
    return;
  }
  let firstNew = -1;
  const added = [];
  list.forEach(file => {
    const url = URL.createObjectURL(file);
    musicUrls.add(url);
    const track = {
      id: uid(),
      name: (file.name || '').replace(/\.(mp3|m4a|aac|wav|ogg|flac|webm)$/i, '') || '未命名歌曲',
      displayName: '',
      /* 若同时选中同名 .lrc，会在下面自动配对填充 */
      lrc: '',
      lyrics: [],
      url,
      size: file.size || 0
    };
    musicTracks.push(track);
    added.push(track);
    if (firstNew < 0) firstNew = musicTracks.length - 1;
  });
  musicPersistList();
  if (firstNew >= 0 && (musicIndex < 0 || !musicTrack() || !musicTrack().url)) {
    /* 只装载，不自动 play：play() 必须由用户后续点击触发 */
    musicIndex = firstNew;
    const t = musicTracks[firstNew];
    const audio = musicEnsureAudio();
    audio.src = t.url;
    audio.dataset.musicId = t.id;
    audio.currentTime = 0;
    state.music.name = t.name;
    persist();
  }
  if (lyricFiles.length) await musicAttachLrcFiles(lyricFiles, added);
  musicSyncAll();
  renderListenPageIfOpen();
  renderHomeIfOpen();
  if (list.length) showToast(`已添加 ${list.length} 首歌`);
}

/* 同名 .lrc 自动配对：先按文件名匹配，匹配不到则挂到本次新增的第一首 */
async function musicAttachLrcFiles(files, addedTracks) {
  let count = 0;
  for (const file of files) {
    const base = String(file.name || '').replace(/\.(lrc|txt)$/i, '').trim().toLowerCase();
    let target = musicTracks.find(t => t.name.trim().toLowerCase() === base);
    if (!target && addedTracks && addedTracks.length) target = addedTracks[0];
    if (!target) target = musicTrack();
    if (!target) continue;
    const raw = await musicReadTextFile(file);
    const lines = musicSetLyricText(target, raw);
    if (!lines) {
      showToast(`《${target.displayName || target.name}》未识别到歌词时间轴`);
      continue;
    }
    count++;
  }
  if (count) {
    musicPersistList();
    showToast(`已加载 ${count} 份歌词`);
  }
}

/* ---------- 单曲歌词：播放列表里的「词」按钮 / 与音频一起多选 .lrc ---------- */
let musicLyricTargetId = '';

function openMusicLyricPicker(trackId) {
  const input = document.getElementById('lyricFileInput');
  if (!input) { showToast('缺少歌词选择器'); return; }
  musicLyricTargetId = trackId || '';
  input.value = '';
  input.click();
}

async function musicHandleLyricFile(file) {
  if (!file) return;
  /* 选择器已去掉 accept 限制，这里按后缀校验，避免选到其它文件 */
  if (!/\.(lrc|txt)$/i.test(file.name || '')) { showToast('请选择 LRC 歌词文件（.lrc / .txt）'); return; }
  const track = musicTracks.find(t => t.id === musicLyricTargetId) || musicTrack();
  if (!track) { showToast('请先添加一首歌'); return; }
  const raw = await musicReadTextFile(file);
  const lines = musicSetLyricText(track, raw);
  if (!lines) { showToast('未识别到歌词时间轴，请确认是 LRC 文件'); return; }
  musicPersistList();
  musicSyncAll();
  renderListenPageIfOpen();
  renderHomeIfOpen();
  musicRenderSheetIfOpen();
  showToast(`已为《${track.displayName || track.name}》加载 ${lines.length} 句歌词`);
}

function musicRemoveTrack(id) {
  const i = musicTracks.findIndex(t => t.id === id);
  if (i < 0) return;
  const track = musicTracks[i];
  const isCurrent = i === musicIndex;
  if (isCurrent) {
    const audio = musicEnsureAudio();
    try { audio.pause(); } catch (e) { /* 忽略 */ }
    audio.removeAttribute('src');
    audio.dataset.musicId = '';
    try { audio.load(); } catch (e) { /* 忽略 */ }
    musicIndex = -1;
  }
  if (track.url) {
    try { URL.revokeObjectURL(track.url); } catch (e) { /* 忽略 */ }
    musicUrls.delete(track.url);
  }
  musicTracks.splice(i, 1);
  if (i < musicIndex) musicIndex -= 1;
  /* 移除的正是当前封面来源时，一并清掉兜底封面，避免显示已删除歌曲的图 */
  if (track.cover && state.music.cover === track.cover) state.music.cover = '';
  if (musicIndex >= 0 && musicTracks[musicIndex]) {
    state.music.name = musicTracks[musicIndex].displayName || musicTracks[musicIndex].name;
  } else {
    state.music.name = '';
  }
  musicPersistList();
  musicSyncAll();
  renderListenPageIfOpen();
  renderHomeIfOpen();
  showToast('已移除');
}

/* 刷新 / 关闭页面前释放所有 objectURL（音频本身不持久化） */
function musicReleaseAll() {
  if (musicAudio) {
    try { musicAudio.pause(); } catch (e) { /* 忽略 */ }
    try { musicAudio.removeAttribute('src'); musicAudio.load(); } catch (e) { /* 忽略 */ }
  }
  musicUrls.forEach(url => {
    try { URL.revokeObjectURL(url); } catch (e) { /* 忽略 */ }
  });
  musicUrls.clear();
}
window.addEventListener('beforeunload', musicReleaseAll);

function openMusicFilePicker() {
  const input = document.getElementById('musicFileInput');
  if (!input) { showToast('缺少音频选择器'); return; }
  input.value = '';
  input.click();
}

/* ---------- 播放列表抽屉 ---------- */
let musicSheetOpenedAt = 0;
let musicSheetDocBound = false;

function openMusicPlaylist() {
  const existing = document.getElementById('musicSheet');
  if (existing) {
    musicSheetOpenedAt = Date.now();
    existing.classList.add('show');
    renderMusicSheetList();
    return;
  }
  const host = document.getElementById('app') || document.body;
  const mask = document.createElement('div');
  mask.className = 'ls-sheet-mask';
  mask.id = 'musicSheet';
  mask.innerHTML = `
    <div class="ls-sheet" role="dialog" aria-modal="true" aria-label="播放列表">
      <div class="ls-sheet-grab" id="musicSheetClose" role="button" aria-label="关闭播放列表"></div>
      <div class="ls-sheet-head">
        <b>播放列表</b>
        <button class="ls-sheet-add" id="musicSheetAdd" type="button" aria-label="添加歌曲">＋</button>
      </div>
      <div class="ls-sheet-list" id="musicSheetList"></div>
      <div class="ls-sheet-tip">音频只在本次打开期间有效，刷新后需重新上传；不会写入本地存储。</div>
    </div>`;
  host.appendChild(mask);
  musicSheetOpenedAt = Date.now();
  mask.addEventListener('click', e => {
    if (e.target === mask) closeMusicPlaylist();
  });
  $('#musicSheetAdd', mask).addEventListener('click', e => {
    e.stopPropagation();
    openMusicFilePicker();
  });
  $('#musicSheetClose', mask).addEventListener('click', e => {
    e.stopPropagation();
    closeMusicPlaylist();
  });
  /* 兜底：在捕获阶段监听文档点击，只要点在抽屉（.ls-sheet）之外就关闭。
     遮罩元素被子节点、动画或层级影响时也能稳定关闭。 */
  if (!musicSheetDocBound) {
    musicSheetDocBound = true;
    document.addEventListener('click', e => {
      const sheet = document.getElementById('musicSheet');
      if (!sheet || !sheet.classList.contains('show')) return;
      if (Date.now() - musicSheetOpenedAt < 260) return;
      const t = e.target;
      if (t && t.closest && t.closest('.ls-sheet')) return;
      closeMusicPlaylist();
    }, true);
  }
  renderMusicSheetList();
  requestAnimationFrame(() => mask.classList.add('show'));
}

function closeMusicPlaylist() {
  const mask = document.getElementById('musicSheet');
  if (!mask) return;
  mask.classList.remove('show');
  setTimeout(() => {
    /* 若 200ms 内又被重新打开，就保留节点，避免刚打开就被移除 */
    if (mask.parentNode && !mask.classList.contains('show')) mask.parentNode.removeChild(mask);
  }, 200);
}

function renderMusicSheetList() {
  const box = document.getElementById('musicSheetList');
  if (!box) return;
  if (!musicTracks.length) {
    box.innerHTML = '<div class="ls-sheet-empty">还没有歌曲，点右上角 ＋ 添加</div>';
    return;
  }
  box.innerHTML = musicTracks.map((t, i) => `
    <div class="ls-song${i === musicIndex ? ' active' : ''}" data-song="${i}" role="button" tabindex="0">
      <span class="ls-song-i">${i + 1}</span>
      <span class="ls-song-name">${esc(t.displayName || t.name)}</span>
      ${t.url ? '' : '<span class="ls-song-dead">待重新上传</span>'}
      <button class="ls-song-lyric${t.lyrics && t.lyrics.length ? ' has' : ''}" data-song-lyric="${i}" type="button" title="加载 / 更换 LRC 歌词" aria-label="加载歌词">词</button>
      <button class="ls-song-del" data-song-del="${i}" type="button" aria-label="移除">×</button>
    </div>`).join('');
  $$('[data-song]', box).forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('[data-song-del]') || e.target.closest('[data-song-lyric]')) return;
      musicPlayIndex(Number(row.dataset.song), true);
    });
  });
  $$('[data-song-lyric]', box).forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const i = Number(btn.dataset.songLyric);
      if (musicTracks[i]) openMusicLyricPicker(musicTracks[i].id);
    });
  });
  $$('[data-song-del]', box).forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const i = Number(btn.dataset.songDel);
      if (musicTracks[i]) musicRemoveTrack(musicTracks[i].id);
    });
  });
}

function musicRenderSheetIfOpen() {
  if (document.getElementById('musicSheet')) renderMusicSheetList();
}

/* ---------- 一起听主界面 ---------- */
function renderListenPage() {
  const role = musicRole();
  const roleName = esc(taName(role && role.id));
  const playing = musicIsPlaying();
  const cover = musicCoverURL();
  const modeMeta = MUSIC_MODE_META[state.music.playMode] || MUSIC_MODE_META.sequence;
  const body = subShell('一起听', `
    <div class="ls-hero">
      <div class="ls-hero-row">
        <div class="ls-ava">${avatarHTML(state.my.avatar, 44)}</div>
        <svg class="ls-ecg" viewBox="0 0 100 30" aria-hidden="true">
          <path d="M2 16h14l4-7 5 14 4-9 4 4h13l4-9 5 18 5-9h12l3-4 4 8 4-4h13"/>
        </svg>
        <div class="ls-ava ta">${role ? roleAvatarHTML(role, 44) : ''}</div>
      </div>
      <div class="ls-together">${roleName} 陪你一起听</div>
    </div>
    <div class="ls-stage">
      <div class="ls-bubble" id="listenBubble"></div>
      <div class="ls-vinyl" id="listenVinyl">
        <button class="ls-cover${cover ? '' : ' no-cover'}" id="listenCover" type="button" title="点击更换唱片中心图片">
          <img ${cover ? `src="${esc(cover)}"` : ''} alt="唱片封面">
          ${cover ? '' : '<span class="ls-cover-note">♪</span>'}
        </button>
      </div>
      <button class="ls-name" id="listenName" type="button" title="点击修改歌名">${esc(musicDisplayName() || '还没有选择歌曲')}</button>
      <div class="ls-lyric" id="listenLyric">${esc(musicLyricFullDisplay())}</div>
      <div class="ls-sub" id="listenSub">${musicTracks.length ? `${musicTracks.length} 首${musicTracks.some(t => !t.url) ? ' · 刷新后音频需重新上传' : ''} · 点击歌名可改名` : '还没有歌曲，点右下角「播放列表」添加'}</div>
    </div>
    <div class="ls-controls">
      <div class="ls-progress">
        <span class="ls-time" id="listenCur">00:00</span>
        <input class="ls-seek" id="listenSeek" type="range" min="0" max="1000" value="0" step="1" aria-label="播放进度">
        <span class="ls-time" id="listenDur">00:00</span>
      </div>
      <div class="ls-main">
        <button class="ls-btn" id="listenPrev" type="button" aria-label="上一首">${MUSIC_ICONS.prev}</button>
        <button class="ls-btn big" id="listenPlay" type="button" aria-label="播放暂停">${playing ? MUSIC_ICONS.pause : MUSIC_ICONS.play}</button>
        <button class="ls-btn" id="listenNext" type="button" aria-label="下一首">${MUSIC_ICONS.next}</button>
      </div>
      <div class="ls-extra">
        <button class="ls-mode" id="listenMode" type="button" aria-label="切换播放模式">${modeMeta.icon}<span>${modeMeta.label}</span></button>
        <button class="ls-listbtn" id="listenList" type="button">${MUSIC_ICONS.list}<span>播放列表</span></button>
      </div>
    </div>
  `);

  /* 进度条：input 实时改 currentTime；change 释放拖拽并刷新 UI */
  const seek = $('#listenSeek', body);
  if (seek) {
    seek.addEventListener('input', e => {
      const audio = musicEnsureAudio();
      const dur = (Number.isFinite(audio.duration) && audio.duration > 0) ? audio.duration : 0;
      if (!dur) return;
      musicSeeking = true;
      audio.currentTime = (Number(e.target.value) / 1000) * dur;
      const cur = $('#listenCur');
      if (cur) cur.textContent = fmtDuration(audio.currentTime);
      seek.style.setProperty('--seek-pct', (Number(e.target.value) / 10).toFixed(2) + '%');
      musicUpdateLyricLine();
    });
    seek.addEventListener('change', () => {
      musicSeeking = false;
      musicSyncProgress();
    });
    /* 触屏拖拽结束兜底：部分浏览器只触发 pointerup 不触发 change */
    seek.addEventListener('pointerup', () => {
      musicSeeking = false;
      musicSyncProgress();
    });
    seek.addEventListener('touchend', () => {
      musicSeeking = false;
      musicSyncProgress();
    }, { passive: true });
  }

  /* 主界面黑胶中心：与桌面组件走同一个隐藏图片选择器 */
  const listenCoverBtn = $('#listenCover', body);
  if (listenCoverBtn) listenCoverBtn.addEventListener('click', () => openMusicCoverPicker());

  $('#listenName', body).addEventListener('click', async () => {
    if (!musicTrack()) { showToast('先添加一首歌吧'); openMusicPlaylist(); return; }
    const cur = musicDisplayName();
    const v = await promptDialog('修改歌名', '输入当前音频的显示名称', cur);
    if (v === null) return;
    const name = v.trim().slice(0, 60);
    if (!name) return;
    const t = musicTrack();
    if (t) { t.displayName = name; musicPersistList(); }
    state.music.name = name;
    persist(true);
    musicUpdateName();
    musicRenderSheetIfOpen();
    renderHomeIfOpen();
    showToast('歌名已保存');
  });

  $('#listenPrev', body).addEventListener('click', () => musicStep(-1));
  $('#listenPlay', body).addEventListener('click', () => musicTogglePlay());
  $('#listenNext', body).addEventListener('click', () => musicStep(1));
  $('#listenMode', body).addEventListener('click', () => musicCycleMode());
  $('#listenList', body).addEventListener('click', () => openMusicPlaylist());

  musicSyncAll();
}

/* =========================================================
 * 拾光瓶：陪伴养成（桌面图标入口 + 全屏二级页，纯 CSS/Emoji，无图片素材）
 * 规则：
 *   打卡 —— 每天首次收发消息 +1 颗星（一天只集一颗）；
 *   断联 —— 启动时检查，lastChatDate 距今超过 2 天，瓶子变暗（星星失去光泽）；
 *   复活 —— 暗淡状态下任意一条消息即恢复发光，并照常集当天的星。
 * ========================================================= */
const JAR_RENDER_MAX = 60;   /* 瓶内最多渲染的星星节点数，超出以角标计数，防止 DOM 过多卡顿 */
let jarDropPending = false;  /* 下一次拾光瓶页渲染时，最新那颗星播放「瓶口掉落」动画 */

/* 两个 YYYY-MM-DD 之间的整天差（b - a），按本地零点计算，不受时分秒影响 */
function jarDaysBetween(a, b) {
  const pa = String(a || '').split('-'), pb = String(b || '').split('-');
  if (pa.length !== 3 || pb.length !== 3) return 0;
  const da = new Date(+pa[0], +pa[1] - 1, +pa[2]);
  const db = new Date(+pb[0], +pb[1] - 1, +pb[2]);
  return Math.round((db - da) / 86400000);
}

/* 启动检查：断联超过 2 天 → 瓶子进入暗淡状态（在首次渲染前调用，直接以最新状态上屏） */
function jarCheckStreak() {
  const jd = state.jarData;
  if (!jd || !jd.lastChatDate) return;
  if (jarDaysBetween(jd.lastChatDate, todayKey()) > 2 && !jd.isDimmed) {
    jd.isDimmed = true;
    persist();
  }
}

/* 聊天互动钩子：发送与接收消息都会调用。
 * 规则：每条消息 totalMessages+1；每满 100 条 stars+1；
 *       连续天数按自然日结算（昨天 +1 / 断签重置 1 / 当天不变）；
 *       暗淡状态下任意一条消息即复活。 */
function jarOnChatActivity() {
  const jd = state.jarData;
  if (!jd) return;
  const today = todayKey();
  const prev = jd.lastChatDate;

  jd.totalMessages += 1;
  if (prev !== today) {
    jd.streakDays = (prev && jarDaysBetween(prev, today) === 1) ? jd.streakDays + 1 : 1;
  }
  jd.lastChatDate = today;              /* 每次聊天都更新最近聊天日期 */
  if (jd.isDimmed) jd.isDimmed = false; /* 复活：星星恢复发光 */

  if (jd.totalMessages % 100 === 0) {
    jd.stars += 1;
    jarDropPending = true;
    /* 动态总数提示：模板字符串实时读取最新 stars */
    showToast(`✨ 恭喜！你们聊了 100 句话，拾光瓶里多了一颗星星！当前共有 ${jd.stars} 颗星星。`);
  }
  persist();
  renderJarIfOpen();
}

/* 二级页重绘入口：仅当拾光瓶页正在展示时重绘（掉落动画标记随之消费） */
function renderJarIfOpen() {
  if (currentRoute && currentRoute.page === 'sub' && currentRoute.name === 'jar') renderJarPage();
}

/* 动态鼓励语：按连续天数 / 星星数分档显示 */
function jarEncourage(jd) {
  if (jd.isDimmed) return '瓶子有点想你了，去和 TA 聊聊吧';
  if (jd.streakDays >= 30) return '日复一日的陪伴，是最长情的告白。';
  if (jd.streakDays >= 7) return '每一次倾诉，都在这里留下了闪亮的痕迹。';
  if (jd.stars >= 5) return '瓶中的星光越来越亮，都是你们说过的话。';
  return '每一百句悄悄话，都会化作瓶中的星光。';
}

/* 拾光瓶二级页：顶部数据面板 + 中央玻璃瓶 + 底部进度；布局确定性伪随机，重绘不跳动 */
function renderJarPage() {
  const jd = state.jarData || { stars: 0, totalMessages: 0, streakDays: 0, lastChatDate: '', isDimmed: false };
  const total = Math.max(0, Math.floor(jd.stars) || 0);
  const n = Math.min(total, JAR_RENDER_MAX);
  const dropIdx = jarDropPending ? n - 1 : -1;
  jarDropPending = false;   /* 动画类名已写入本次 HTML，立即清除标记，避免下次重绘重复播放 */
  let stars = '';
  for (let i = 0; i < n; i++) {
    const left = 6 + ((i * 37 + 11) % 72);               /* 6% ~ 78%，层内横向错开 */
    const bottom = 6 + Math.floor(i / 6) * 16 + ((i * 17) % 5);  /* 每 6 颗叠一层，层内 ±4px 错落 */
    const size = 15 + ((i * 7) % 7);                     /* 15 ~ 21px */
    const bd = (2 + ((i * 13) % 10) * 0.14).toFixed(2);  /* 呼吸周期 2.0 ~ 3.3s，各不相同 */
    stars += `<span class="jar-star${i === dropIdx ? ' drop' : ''}" style="left:${left}%;bottom:${bottom}px;font-size:${size}px;--bd:${bd}s">${i % 4 === 3 ? '⭐' : '✨'}</span>`;
  }
  /* 距离下一颗星：100 - (累计 % 100)；余数为 0 时新一轮刚开始，差 100 句 */
  const remain = 100 - (jd.totalMessages % 100);
  const pct = (jd.totalMessages % 100) / 100 * 100;
  subShell('拾光瓶', `
    <div class="jar-page${jd.isDimmed ? ' dim' : ''}">
      <div class="jar-panel">
        <div class="jar-stats">
          <div class="jar-stat"><span class="js-ic">⭐</span><span class="js-tx">累计星光</span><b>${total}</b><span class="js-unit">颗</span></div>
          <div class="jar-stat"><span class="js-ic">🔥</span><span class="js-tx">已连续聊天</span><b>${jd.streakDays}</b><span class="js-unit">天</span></div>
        </div>
        <div class="jar-enc">${esc(jarEncourage(jd))}</div>
      </div>
      <div class="jar-stage">
        <div class="jar-bottle big">
          <i class="jar-cork"></i>
          <div class="jar-stars">${stars}</div>
          ${total > JAR_RENDER_MAX ? `<b class="jar-badge">×${total}</b>` : ''}
        </div>
      </div>
      <div class="jar-progress">
        <div class="jp-text">距离下一颗星星还需要 <b>${remain}</b> 句话哦~</div>
        <div class="jp-bar"><i style="width:${pct}%"></i></div>
      </div>
    </div>`);
}

/* ---------- 桌面 3×2 音乐组件 / 1×2 照片墙 ---------- */
function musicWidgetHTML() {
  const cover = musicCoverURL();
  const playing = musicIsPlaying();
  const name = musicDisplayName() || '还没有歌曲';
  return `
    <div class="home-widget music-widget" id="homeMusicWidget">
      <div class="mw-vinyl" id="homeMusicVinyl" title="点击更换唱片中心图片">
        <img ${cover ? `src="${esc(cover)}"` : ''} alt="唱片封面" id="homeMusicCover">
        ${cover ? '' : '<span class="mw-note">♪</span>'}
      </div>
      <div class="mw-main">
        <div class="mw-name" id="homeMusicName">${esc(name)}</div>
        <div class="mw-lyric" id="homeMusicLyric">${esc(musicLyricDisplay())}</div>
        <div class="mw-ctrl">
          <button class="mw-btn" data-mw="prev" type="button" aria-label="上一首">${MUSIC_ICONS.prev}</button>
          <button class="mw-btn play" data-mw="toggle" id="homeMusicToggle" type="button" aria-label="播放暂停">${playing ? MUSIC_ICONS.pause : MUSIC_ICONS.play}</button>
          <button class="mw-btn" data-mw="next" type="button" aria-label="下一首">${MUSIC_ICONS.next}</button>
        </div>
      </div>
    </div>`;
}

function photoWallWidgetHTML() {
  const imgs = state.photoWall.images;
  if (!imgs.length) {
    return `
      <div class="home-widget photo-wall-widget" id="homePhotoWall">
        <button class="pw-empty" data-pw-add type="button" aria-label="添加照片">
          <span>＋</span><em>照片墙</em>
        </button>
      </div>`;
  }
  /* 只取第一张：单图铺满整个 1×2 组件，不再渲染多余格子或「添加」按钮 */
  const src = imgs[0];
  return `
    <div class="home-widget photo-wall-widget" id="homePhotoWall">
      <div class="pw-grid">
        <button class="pw-cell" data-pw="0" type="button" aria-label="照片 1">
          <img src="${esc(src)}" alt="照片 1">
        </button>
      </div>
    </div>`;
}

function openPhotoWallPicker() {
  const input = document.getElementById('photoWallInput');
  if (!input) { showToast('缺少图片选择器'); return; }
  input.value = '';
  input.click();
}

function openPhotoWallActions(i) {
  const imgs = state.photoWall.images;
  if (!imgs[i]) return;
  showActionSheet('照片墙', [
    {
      label: '更换这张图片',
      onClick: async () => {
        const url = await pickImage(800, .7);
        if (!url) return;
        state.photoWall.images[i] = url;
        persist(true);
        renderHomeIfOpen();
        showToast('照片已更新');
      }
    },
    {
      label: '删除这张图片',
      onClick: () => {
        state.photoWall.images.splice(i, 1);
        persist(true);
        renderHomeIfOpen();
        showToast('已删除');
      }
    },
    {
      label: '清空照片墙',
      onClick: () => {
        state.photoWall.images = [];
        persist(true);
        renderHomeIfOpen();
        showToast('照片墙已清空');
      }
    }
  ]);
}

async function photoWallAddFiles(files) {
  const list = Array.from(files || []).filter(f => f && /^image\//.test(f.type));
  if (!list.length) { showToast('请选择图片文件'); return; }
  const room = PHOTO_WALL_MAX - state.photoWall.images.length;
  if (room <= 0) { showToast('照片墙最多放 1 张'); return; }
  let added = 0;
  for (const file of list.slice(0, room)) {
    try {
      const raw = await readFileAsDataURL(file);
      state.photoWall.images.push(await compressDataURL(raw, 800, .7));
      added++;
    } catch (e) { /* 单张失败跳过 */ }
  }
  if (added) {
    persist(true);
    renderHomeIfOpen();
    showToast(`已添加 ${added} 张照片`);
  } else {
    showToast('图片读取失败');
  }
}

/* 静态文件选择器只绑定一次（index.html 中的 hidden input） */
function musicBindInputs() {
  const mi = document.getElementById('musicFileInput');
  if (mi && mi.dataset.bound !== '1') {
    mi.dataset.bound = '1';
    mi.addEventListener('change', () => {
      const files = Array.from(mi.files || []);
      mi.value = '';
      if (files.length) musicAddFiles(files);
    });
  }
  const pi = document.getElementById('photoWallInput');
  if (pi && pi.dataset.bound !== '1') {
    pi.dataset.bound = '1';
    pi.addEventListener('change', () => {
      const files = Array.from(pi.files || []);
      pi.value = '';
      if (files.length) photoWallAddFiles(files);
    });
  }
  const li = document.getElementById('lyricFileInput');
  if (li && li.dataset.bound !== '1') {
    li.dataset.bound = '1';
    li.addEventListener('change', () => {
      const file = (li.files || [])[0];
      li.value = '';
      if (file) musicHandleLyricFile(file);
    });
  }
  /* 唱片中心图：主界面与桌面组件共用 */
  const ci = document.getElementById('musicCoverInput');
  if (ci && ci.dataset.bound !== '1') {
    ci.dataset.bound = '1';
    ci.addEventListener('change', () => {
      const file = (ci.files || [])[0];
      ci.value = '';
      if (file) musicApplyCoverFile(file);
    });
  }
}

function renderHomeIfOpen() {
  if (currentRoute && currentRoute.page === 'home') renderHomePage();
}
function renderListenPageIfOpen() {
  if (currentRoute && currentRoute.page === 'sub' && currentRoute.name === 'listen') renderListenPage();
}

function bindHomeWidgets(page) {
  const mw = $('#homeMusicWidget', page);
  if (mw) {
    mw.addEventListener('click', e => {
      /* 黑胶中心（含未设置图片时的 ♪）：点一下换图，不跳转页面 */
      if (e.target.closest('.mw-vinyl') || e.target.closest('#homeMusicCover')) {
        e.stopPropagation();
        if (homeSwipeSuppress) return;
        openMusicCoverPicker();
        return;
      }
      if (e.target.closest('[data-mw]')) return;
      if (homeSwipeSuppress) return;
      navigate({ page: 'sub', name: 'listen' });
    });
    const prev = $('[data-mw="prev"]', mw);
    const toggle = $('[data-mw="toggle"]', mw);
    const next = $('[data-mw="next"]', mw);
    if (prev) prev.addEventListener('click', e => { e.stopPropagation(); musicStep(-1); });
    if (toggle) toggle.addEventListener('click', e => { e.stopPropagation(); musicTogglePlay(); });
    if (next) next.addEventListener('click', e => { e.stopPropagation(); musicStep(1); });
  }
  const pw = $('#homePhotoWall', page);
  if (pw) {
    pw.addEventListener('click', e => {
      if (homeSwipeSuppress) return;
      const add = e.target.closest('[data-pw-add]');
      if (add) { e.stopPropagation(); openPhotoWallPicker(); return; }
      const cell = e.target.closest('[data-pw]');
      if (cell) { e.stopPropagation(); openPhotoWallActions(Number(cell.dataset.pw)); }
    });
  }
}

/* =========================================================
 * 桌面宠物：桌面悬浮 + 单指拖动 / 双指缩放 + 点击弹字卡气泡
 * 开关、图片、坐标、缩放全部存在 state.pet，随完整备份一起导出/导入
 * ========================================================= */
const PET_BASE_W = 100;     /* 桌宠基准宽度（px），缩放倍率以它为基准 */
const PET_SCALE_MIN = 0.5;  /* 最小缩放：基准的 0.5 倍 */
const PET_SCALE_MAX = 2.5;  /* 最大缩放：基准的 2.5 倍 */
const PET_TAP_MS = 200;     /* 点击判定：按下到抬起小于 200ms */
const PET_TAP_MOVE = 10;    /* 点击判定：总位移小于 10px */

let petDom = null;
let petGesture = null;
let petBubbleTimer = null;
let petLastTouchAt = 0;

function petData() {
  if (!state.pet || typeof state.pet !== 'object') {
    state.pet = { enabled: false, image: '', left: null, top: null, scale: 1 };
  }
  return state.pet;
}

function petEnsureDom() {
  if (petDom && document.body.contains(petDom.layer)) return petDom;
  const layer = document.getElementById('petLayer');
  if (!layer) return null;
  layer.innerHTML = `
    <div class="desk-pet" id="deskPet"><img id="deskPetImg" alt="桌面宠物"></div>
    <div class="pet-bubble" id="petBubble"></div>`;
  const pet = layer.querySelector('#deskPet');
  const img = layer.querySelector('#deskPetImg');
  const bubble = layer.querySelector('#petBubble');
  /* 图片加载完成后高度才准确，重新钳一次位置 */
  img.addEventListener('load', () => {
    if (currentRoute && currentRoute.page === 'home') petLayout(true);
  });
  bindPetGestures(pet);
  petDom = { layer, pet, img, bubble };
  return petDom;
}

/* 计算桌宠在桌面图层内的位置与缩放后尺寸；apply=true 时同步写入样式。
   桌面未显示（图层 display:none）时返回 null，避免量到 0 尺寸。 */
function petLayout(apply = false) {
  const d = petEnsureDom();
  if (!d) return null;
  const W = d.layer.clientWidth;
  const H = d.layer.clientHeight;
  if (!W || !H) return null;
  const p = petData();
  const scale = clamp(Number(p.scale) || 1, PET_SCALE_MIN, PET_SCALE_MAX);
  const w = PET_BASE_W * scale;
  const h = (d.pet.offsetHeight || PET_BASE_W) * scale;
  let left, top;
  if (typeof p.left === 'number' && typeof p.top === 'number') {
    left = clamp(p.left, 0, Math.max(0, W - w));
    top = clamp(p.top, 0, Math.max(0, H - h));
  } else {
    /* 默认位置：桌面右下角 */
    left = Math.max(0, W - w - 16);
    top = Math.max(0, H - h - 24);
  }
  if (apply) {
    d.pet.style.left = left + 'px';
    d.pet.style.top = top + 'px';
    d.pet.style.transform = `scale(${scale})`;
  }
  return { left, top, w, h, W, H, el: d.pet };
}

/* 全局统一同步桌宠显隐：开启 + 上传图片即显示在任意页面（桌面/聊天/子页都浮）。
   导航栏、输入框、sticker sheet、modalRoot z-index 都高于桌宠，不会被盖住 */
function syncPetVisibility() {
  const d = petEnsureDom();
  if (!d) return;
  const p = petData();
  const show = !!(p.enabled && p.image);
  if (!show) {
    d.layer.classList.remove('on');
    petHideBubble();
    return;
  }
  if (d.img.getAttribute('src') !== p.image) d.img.setAttribute('src', p.image);
  d.layer.classList.add('on');
  petLayout(true);
  /* 首帧后图片可能已完成加载，再钳一次 */
  requestAnimationFrame(() => petLayout(true));
}

/* ---------------- 手势：单指拖动 / 双指缩放 / 点击 ---------------- */
function bindPetGestures(el) {
  el.addEventListener('touchstart', e => {
    petHideBubble();
    if (e.touches.length >= 2) {
      /* 双指按下：进入缩放模式，禁止拖动 */
      const a = e.touches[0], b = e.touches[1];
      petGesture = {
        mode: 'pinch',
        t0: Date.now(),
        dist0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1,
        scale0: clamp(Number(petData().scale) || 1, PET_SCALE_MIN, PET_SCALE_MAX),
        maxDist: 999,
        pinched: true
      };
      petLayout(true);
      e.preventDefault();
      return;
    }
    petStartDrag(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false });

  el.addEventListener('touchmove', e => {
    const g = petGesture;
    if (!g) return;
    if (e.touches.length >= 2) {
      /* 关键：必须 preventDefault + passive:false，否则 iOS 会把整个网页放大 */
      e.preventDefault();
      const a = e.touches[0], b = e.touches[1];
      if (g.mode !== 'pinch') {
        g.mode = 'pinch';
        g.pinched = true;
        g.dist0 = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
        g.scale0 = clamp(Number(petData().scale) || 1, PET_SCALE_MIN, PET_SCALE_MAX);
      }
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
      petData().scale = clamp(g.scale0 * (dist / g.dist0), PET_SCALE_MIN, PET_SCALE_MAX);
      petLayout(true);
      return;
    }
    if (g.mode !== 'drag' || g.pinched || e.touches.length !== 1) return;
    e.preventDefault();
    petDragTo(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false });

  const touchEnd = () => {
    petLastTouchAt = Date.now();
    petEndGesture();
  };
  el.addEventListener('touchend', touchEnd);
  el.addEventListener('touchcancel', touchEnd);

  /* 兼容鼠标：按住拖动，松开判定点击 */
  el.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (Date.now() - petLastTouchAt < 700) return;  /* 忽略触摸后的合成鼠标事件 */
    e.preventDefault();
    petHideBubble();
    petStartDrag(e.clientX, e.clientY);
    const onMove = ev => petDragTo(ev.clientX, ev.clientY);
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      petEndGesture();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function petStartDrag(x, y) {
  const box = petLayout(false);
  if (!box) return;
  petGesture = {
    mode: 'drag',
    t0: Date.now(),
    x0: x, y0: y,
    left0: box.left, top0: box.top,
    maxDist: 0,
    pinched: false
  };
  if (petDom && petDom.pet) petDom.pet.classList.add('dragging');
}

function petDragTo(x, y) {
  const g = petGesture;
  if (!g || g.mode !== 'drag' || g.pinched) return;
  const dx = x - g.x0, dy = y - g.y0;
  const dist = Math.hypot(dx, dy);
  g.maxDist = Math.max(g.maxDist || 0, dist);
  if (dist < 3) return;  /* 过滤手指抖动 */
  const box = petLayout(false);
  if (!box) return;
  const p = petData();
  p.left = clamp(g.left0 + dx, 0, Math.max(0, box.W - box.w));
  p.top = clamp(g.top0 + dy, 0, Math.max(0, box.H - box.h));
  petLayout(true);
}

function petEndGesture() {
  const g = petGesture;
  petGesture = null;
  if (petDom && petDom.pet) petDom.pet.classList.remove('dragging');
  if (!g) return;

  /* 双指缩放过：保存缩放并钳制位置 */
  if (g.pinched) {
    const p = petData();
    p.scale = clamp(Number(p.scale) || 1, PET_SCALE_MIN, PET_SCALE_MAX);
    const box = petLayout(false);
    if (box) {
      if (typeof p.left === 'number') p.left = clamp(p.left, 0, Math.max(0, box.W - box.w));
      if (typeof p.top === 'number') p.top = clamp(p.top, 0, Math.max(0, box.H - box.h));
    }
    petLayout(true);
    persist();
    return;
  }

  /* 拖动过：坐标在移动时已实时更新，这里钳制边界后持久化 */
  if ((g.maxDist || 0) >= 3) {
    const p = petData();
    const box = petLayout(false);
    if (box) {
      p.left = clamp(typeof p.left === 'number' ? p.left : box.left, 0, Math.max(0, box.W - box.w));
      p.top = clamp(typeof p.top === 'number' ? p.top : box.top, 0, Math.max(0, box.H - box.h));
    }
    petLayout(true);
    persist();
    return;
  }

  /* 点击判定：单指、短于 200ms、位移小于 10px */
  if ((g.maxDist || 0) < PET_TAP_MOVE && (Date.now() - g.t0) < PET_TAP_MS) {
    petShowBubble();
  }
}

/* ---------------- 字卡气泡 ---------------- */
function petShowBubble() {
  const d = petEnsureDom();
  if (!d) return;
  const box = petLayout(false);
  if (!box) return;
  /* 从主字卡库随机抽（走统一的拼接逻辑，但不连发）；库为空时的兜底文案 */
  const text = composeCardText('__pet__') || '戳我干嘛呀~';
  const bubble = d.bubble;
  bubble.classList.remove('show', 'under', 'over');
  bubble.textContent = text;

  /* 先量出气泡尺寸，再按桌宠位置贴边摆放，保证不超出屏幕左右边缘 */
  bubble.style.left = '0px';
  bubble.style.top = '0px';
  const bw = bubble.offsetWidth;
  const bh = bubble.offsetHeight;
  let x = box.left + box.w / 2 - bw / 2;
  x = clamp(x, 8, Math.max(8, box.W - bw - 8));
  const petMid = box.top + box.h / 2;
  let y, cls;
  if (petMid < box.H / 2) {
    /* 桌宠在屏幕上半部分 → 气泡显示在下方 */
    y = box.top + box.h + 10;
    cls = 'under';
  } else {
    /* 桌宠在下半部分 → 气泡显示在上方 */
    y = box.top - bh - 10;
    cls = 'over';
  }
  y = clamp(y, 6, Math.max(6, box.H - bh - 6));
  bubble.style.left = x + 'px';
  bubble.style.top = y + 'px';
  bubble.classList.add(cls, 'show');

  /* 5 秒后自动淡出；再次点击会刷新内容并重新计时 */
  clearTimeout(petBubbleTimer);
  petBubbleTimer = setTimeout(petHideBubble, 5000);
}

function petHideBubble() {
  if (petBubbleTimer) { clearTimeout(petBubbleTimer); petBubbleTimer = null; }
  if (petDom && petDom.bubble) petDom.bubble.classList.remove('show');
}

/* ---------------- 图片上传（GIF 原样保留，静态图压透明背景） ---------------- */
function compressPetImage(dataURL, maxDim = 800) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxDim / Math.max(img.width || 1, img.height || 1));
        const w = Math.max(1, Math.round((img.width || 1) * scale));
        const h = Math.max(1, Math.round((img.height || 1) * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        /* 不铺白底，保留背景透明 */
        ctx.drawImage(img, 0, 0, w, h);
        let out = canvas.toDataURL('image/webp', .9);
        if (!out.startsWith('data:image/webp')) out = canvas.toDataURL('image/png');
        resolve(out);
      } catch (e) { resolve(dataURL); }
    };
    img.onerror = () => resolve(dataURL);
    img.src = dataURL;
  });
}

function pickPetImage() {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) return resolve(null);
      if (!/^image\//.test(file.type)) { showToast('请选择图片或 GIF 文件'); return resolve(null); }
      const isGif = /gif/i.test(file.type) || /\.gif$/i.test(file.name || '');
      const limit = isGif ? 2.5 : 8;
      if (file.size > limit * 1024 * 1024) {
        showToast(isGif ? 'GIF 请控制在 2.5MB 以内' : '图片请控制在 8MB 以内');
        return resolve(null);
      }
      try {
        const raw = await readFileAsDataURL(file);
        /* GIF 必须原样保存，走 canvas 压缩会丢动画 */
        if (isGif) return resolve(raw);
        resolve(await compressPetImage(raw, 800));
      } catch (e) { resolve(null); }
    });
    input.click();
  });
}

/* ---------------- 桌宠管理页 ---------------- */
function renderPetPage() {
  const p = petData();
  const scale = clamp(Number(p.scale) || 1, PET_SCALE_MIN, PET_SCALE_MAX);
  const posText = (typeof p.left === 'number' && typeof p.top === 'number')
    ? `x ${Math.round(p.left)} · y ${Math.round(p.top)}`
    : '默认（桌面右下角）';
  const body = subShell('桌面宠物', `
    <div class="panel">
      <div class="panel-title">显示设置</div>
      <div class="slider-row row-between">
        <div>
          <div style="font-size:13px">在桌面显示桌宠</div>
          <div class="muted">关闭后桌宠不在桌面出现，图片与位置会保留</div>
        </div>
        <label class="switch"><input type="checkbox" id="petEnabled" ${p.enabled ? 'checked' : ''}><span class="slider"></span></label>
      </div>
      <div class="tip-box" style="margin-top:10px">只有「开启显示」并且已上传图片时，桌宠才会出现在桌面首页；进入其他页面会自动隐藏，回到桌面再出现。</div>
    </div>
    <div class="panel">
      <div class="panel-title">桌宠图片</div>
      ${p.image
        ? `<div class="pet-preview"><img src="${p.image}" alt="桌宠预览"></div>`
        : '<div class="pet-empty">还没有上传桌宠图片</div>'}
      <div class="muted" style="margin:8px 0 12px">建议上传背景透明的 GIF 动图</div>
      <div class="btn-row">
        <button class="btn primary" id="petPick" style="flex:1">上传图片</button>
        <button class="btn ghost" id="petClear" style="flex:1">清除图片</button>
      </div>
      <div class="tip-box" style="margin-top:10px">图片以 Base64 保存在本地，会随「存储感知」统计并纳入完整备份。GIF 原样保留动效，普通图片自动压缩。</div>
    </div>
    <div class="panel">
      <div class="panel-title">位置与大小</div>
      <div class="pet-meta">当前缩放：${scale.toFixed(2)}x · 当前位置：${esc(posText)}</div>
      <div class="muted">回到桌面后可直接拖动桌宠；双指捏合缩放（0.5x ~ 2.5x），位置与大小会自动保存。</div>
      <button class="btn block" id="petReset" style="margin-top:12px">恢复默认位置与大小</button>
    </div>
  `);

  const box = $('#petEnabled');
  if (box) box.addEventListener('change', e => {
    petData().enabled = e.target.checked;
    persist();
    showToast(e.target.checked ? '桌宠已开启，回到桌面即可看到' : '桌宠已关闭');
  });

  const pick = $('#petPick', body);
  if (pick) pick.addEventListener('click', async () => {
    const url = await pickPetImage();
    if (!url) return;
    petData().image = url;
    await persist(true);
    renderPetPage();
    showToast('桌宠图片已更新');
  });

  const clear = $('#petClear', body);
  if (clear) clear.addEventListener('click', async () => {
    if (!petData().image) { showToast('还没有桌宠图片'); return; }
    const ok = await confirmDialog('清除图片', '确定清除当前桌宠图片吗？清除后桌宠将不再显示。', '清除', true);
    if (!ok) return;
    petData().image = '';
    await persist(true);
    renderPetPage();
    syncPetVisibility();
    showToast('桌宠图片已清除');
  });

  const reset = $('#petReset', body);
  if (reset) reset.addEventListener('click', async () => {
    const p2 = petData();
    p2.scale = 1;
    p2.left = null;
    p2.top = null;
    await persist(true);
    renderPetPage();
    showToast('已恢复默认位置与大小');
  });
}

/* 窗口尺寸变化时只做边界钳制（不参与键盘高度计算） */
window.addEventListener('resize', () => {
  if (!petData().enabled || !petData().image) return;
  petLayout(true);
  petHideBubble();
});

/* =========================================================
 * 美化：桌面 / 聊天 / 空间壁纸与图标主题
 * ========================================================= */
const WALL_PRESETS = [
  { id: 'mist', name: '晨雾', css: 'linear-gradient(160deg,#F7F9FC 0%,#E6ECF5 100%)' },
  { id: 'blue', name: '浅蓝', css: 'linear-gradient(160deg,#EDF5FF 0%,#DCE9FB 100%)' },
  { id: 'sunset', name: '暖霞', css: 'linear-gradient(160deg,#FFF3EA 0%,#FDE2E4 100%)' },
  { id: 'mint', name: '薄荷', css: 'linear-gradient(160deg,#EAF8F2 0%,#D8EFF5 100%)' },
  { id: 'plain', name: '纯白', css: '#F7F7FA' },
  { id: 'grey', name: '浅灰', css: '#EFEFF4' }
];

function wallBackground(value) {
  if (!value) return '';
  if (value.startsWith('preset:')) {
    const p = WALL_PRESETS.find(w => w.id === value.slice(7));
    return p ? p.css : '';
  }
  const safe = String(value).replace(/"/g, '%22');
  return `linear-gradient(rgba(255,255,255,.34),rgba(255,255,255,.34)), url("${safe}") center/cover no-repeat`;
}

function applyBeautify() {
  if (!state || !state.beautify) return;
  const b = state.beautify;
  const app = document.getElementById('app');
  if (app) app.className = 'icon-theme-' + (['blue', 'light', 'dark'].includes(b.iconTheme) ? b.iconTheme : 'blue');
  /* 组件外观：磨砂玻璃开关 + 透明度，统一走 CSS 变量（实时生效，无需重绘页面） */
  if (app) {
    app.classList.toggle('glass-on', b.glassOn === true);
    const gOp = clamp(Number(b.glassOpacity), 0, 100);
    app.style.setProperty('--glass-bg-opacity', String((Number.isFinite(gOp) ? gOp : 80) / 100));
    app.style.setProperty('--glass-blur', '16px');
  }
  const setWall = (el, value) => {
    if (!el) return;
    const bg = wallBackground(value);
    if (bg) el.style.background = bg;
    else el.style.removeProperty('background');
  };
  setWall(document.getElementById('page-home'), b.deskWall);
  /* 空间页壁纸：绑到 Banner 封面区（不再全屏铺满） */
  const banner = document.querySelector('#page-space .space-banner');
  if (banner) setWall(banner, b.spaceWall);

  /* 聊天页壁纸：永远尝试设置（不要被 currentRoute 限制，
     因为 applyBeautify 也在 boot 时执行，此时聊天页未激活但后续进入需要壁纸已生效）；
     同时把盖住壁纸的中间层（消息滚动区）改成半透明，让壁纸透出来；
     顶栏/输入区本来就是半透明 + 模糊，无需额外处理。 */
  const chatWall = (b.chatWallByRole && currentRoute && currentRoute.roleId)
    ? (b.chatWallByRole[currentRoute.roleId] || '')
    : '';
  const effectiveChatWall = chatWall || b.chatWallGlobal || '';
  const pageChat = document.getElementById('page-chat');
  if (pageChat) {
    setWall(pageChat, effectiveChatWall);
    const scroll = pageChat.querySelector('.chat-scroll');
    if (scroll) {
      if (effectiveChatWall) {
        /* 有壁纸 → 滚动区半透明，让壁纸透出来 */
        scroll.style.background = 'rgba(242,242,247,0.18)';
        scroll.style.backdropFilter = 'blur(0px)';
      } else {
        scroll.style.removeProperty('background');
        scroll.style.removeProperty('backdrop-filter');
      }
    }
  }
  /* 自定义样式：把字体 / 气泡代码重新挂到 head，保证壁纸、主题重绘后依然生效 */
  applyCustomStyleInline(b);
}

/* =========================================================
 * 十二·五、美化 - 样式自定义（字体 / 气泡）
 * 数据流：输入框原始文本 → 智能解析（链接 / 完整 CSS / 纯属性包裹）
 *         → 注入 <style id="custom-style-injector">（补 !important + 锁 #page-chat 作用域）→ 持久化
 * 防污染：全局注入入口 applyCustomStyleInline 统一调用 csScopeToChat，
 *         Toast（#toast）与来电弹窗（#callLayer）都在 #page-chat 之外，物理隔离。
 * ========================================================= */
const CS_TEMPLATES = {
  bubble: `/* 请将 .your-bubble-class 替换为你网页实际的气泡类名 */
.your-bubble-class {
    background: rgba(255, 192, 203, 0.5);
    color: #333;
    border-radius: 18px;
    padding: 8px 16px;
    box-shadow: 0 2px 10px rgba(0,0,0,0.1);
}`,
  font: `/* 请将 .your-text-class 替换为你网页实际的文字类名 */
.your-text-class {
    font-family: "Songti SC", serif;
    font-size: 15px;
    font-weight: 500;
    color: #333;
    line-height: 1.5;
    letter-spacing: 0.5px;
}`
};

/* 字体链接 / 上传 TTF 共用的基础选择器：让全站文字立刻使用新字体 */
const CS_FONT_SELECTOR = 'body, .chat-text';

let csTab = 'font';                        /* 当前分类：font / bubble */
const csDraft = { font: '', bubble: '' };  /* 输入框草稿（内存态，切换分类不丢） */
let csLastFontData = '';                   /* 本次上传的字体 dataURL，随预设一起保存 */
let csPreviewTimer = null;

/* 注入器：放在 head 末尾，天然晚于 style.css，同优先级规则即可覆盖内置样式 */
function csInjector() {
  let el = document.getElementById('custom-style-injector');
  if (!el) {
    el = document.createElement('style');
    el.id = 'custom-style-injector';
    document.head.appendChild(el);
  } else if (el !== document.head.lastElementChild) {
    /* 始终排在 head 最后一个 style 之后：同权重时后出现的规则才能覆盖 style.css 里的内置样式 */
    document.head.appendChild(el);
  }
  return el;
}

/* 预览用的独立 style：只作用于 .cs-preview，绝不污染真实聊天 */
function csPreviewStyle() {
  let el = document.getElementById('custom-style-preview');
  if (!el) {
    el = document.createElement('style');
    el.id = 'custom-style-preview';
    document.head.appendChild(el);
  }
  return el;
}

/* 把已应用的两类代码合并注入；没有内容时清空 */
function applyCustomStyleInline(b) {
  const cs = (b && b.customStyle) || {};
  const applied = cs.applied || {};
  const css = [applied.font, applied.bubble].filter(Boolean).join('\n\n');
  /* 防污染：注入全局前统一锁进 #page-chat 作用域（Toast / 来电弹窗都在 #page-chat 之外） */
  csInjector().textContent = css ? csScopeToChat(css) : '';
}

/* 字体格式：按后缀推断 format()，保证浏览器能正确解码 */
function csFontFormat(name) {
  const s = String(name || '').split('?')[0].split('#')[0].toLowerCase();
  if (s.endsWith('.woff2')) return 'woff2';
  if (s.endsWith('.woff')) return 'woff';
  if (s.endsWith('.otf')) return 'opentype';
  return 'truetype';
}

/* 由字体链接自动生成字体名：取文件名去掉后缀并清洗成合法标识，再加 AutoFont_ 前缀 */
function csFontFamilyName(url) {
  const base = String(url || '').split('?')[0].split('#')[0].split('/').pop() || '';
  const id = base.replace(/\.(ttf|otf|woff2|woff|eot)$/i, '')
    .replace(/[^\w-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'WebFont';
  return 'AutoFont_' + id;
}

function csFontFace(src, format, family) {
  const name = family || 'CustomFont';
  return `@font-face {
  font-family: '${name}';
  src: url('${src}') format('${format}');
  font-display: swap;
}`;
}

/* 字体链接 → @font-face + 生效选择器（原样注入；全局注入时再统一锁 #page-chat 作用域） */
function csFontLinkCSS(url) {
  const clean = url.split('?')[0].split('#')[0].toLowerCase();
  const family = csFontFamilyName(url);
  return `${csFontFace(url, csFontFormat(clean), family)}
${CS_FONT_SELECTOR} { font-family: '${family}' !important; }`;
}

/* ---------------- 强制提升权重：给用户代码的每条声明补 !important ----------------
 * style.css 里 .msg.mine .bubble / .msg.theirs .bubble 写死了气泡配色，
 * 用户只写 background: pink 时即使同权重也会被覆盖，因此统一加 !important。
 * 注意：@font-face / @keyframes 里的描述符不能加 !important，必须原样保留；
 *       @import 等语句也不能加。
 * ------------------------------------------------------------------ */
function csImportantOne(decl) {
  const t = decl.trim();
  if (!t) return decl;
  if (t.charAt(0) === '@') return decl;
  if (!t.includes(':')) return decl;              /* 不是声明（注释或选择器残留） */
  if (/!\s*important/i.test(t)) return decl;      /* 已经写过就不再重复 */
  return decl.replace(/\s*$/, '') + ' !important';
}

/* 处理一个声明块（花括号内部）：按顶层分号切分，逐条补 !important */
function csImportantDeclBlock(body) {
  let out = '';
  let buf = '';
  let quote = '';
  let paren = 0;
  let comment = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    const nx = body[i + 1];
    if (comment) {
      buf += ch;
      if (ch === '*' && nx === '/') { buf += nx; i++; comment = false; }
      continue;
    }
    if (quote) {
      buf += ch;
      if (ch === '\\') { if (nx) { buf += nx; i++; } continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && nx === '*') { buf += '/*'; i++; comment = true; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '(') { paren++; buf += ch; continue; }   /* url(...) 里的分号不算分隔符 */
    if (ch === ')') { paren--; buf += ch; continue; }
    if (ch === ';' && paren === 0) { out += csImportantOne(buf) + ';'; buf = ''; continue; }
    buf += ch;
  }
  out += csImportantOne(buf);   /* 最后一条声明可能没有分号 */
  return out;
}

/* 对整段 CSS 逐块补 !important；语法本身有问题时原样返回，交给语法校验报错 */
function csForceImportant(css) {
  const split = csSplitTopRules(css);
  if (split.broken) return css;
  const out = split.rules.map(rule => {
    const idx = rule.indexOf('{');
    if (idx < 0) return rule;                       /* @import / @charset 等语句 */
    const head = rule.slice(0, idx);
    const headClean = head.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    const end = rule.lastIndexOf('}');
    const inner = rule.slice(idx + 1, end < 0 ? rule.length : end);
    const tail = end < 0 ? '' : rule.slice(end);    /* 通常就是 '}' */
    /* 描述符块：不能加 !important */
    if (/^@(font-face|keyframes|-webkit-keyframes|-moz-keyframes|import|charset|namespace|page|counter-style|property|font-feature-values)/i.test(headClean)) {
      return rule;
    }
    /* @media / @supports 等：递归处理内部规则 */
    if (headClean.charAt(0) === '@') {
      return head + '{' + csForceImportant(inner) + tail;
    }
    return head + '{' + csImportantDeclBlock(inner) + tail;
  });
  return out.join('\n');
}

/* 兼容层：用户很可能照着旧预览的类名写 .message-bubble / .message-sent / .message-received，
   但真实聊天页只有 .msg.mine|.msg.theirs > .msg-body > .bubble。
   当代码里只有这些旧类名、完全没提到 .msg / .bubble 时，自动复制一份改写成真实选择器的规则，
   保证「预览能生效的代码，聊天页也一定生效」 */
function csAliasBubbleCss(css) {
  if (!/\.(message-bubble|message-sent|message-received)\b/.test(css)) return '';
  if (/(^|[^\w.-])\.(msg|bubble)\b/.test(css)) return '';   /* 已经命中真实类名，无需别名 */
  const split = csSplitTopRules(css);
  if (split.broken) return '';
  const out = [];
  split.rules.forEach(rule => {
    const idx = rule.indexOf('{');
    if (idx < 0) return;                                   /* @import 等语句跳过 */
    const head = rule.slice(0, idx);
    const headClean = head.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (headClean.charAt(0) === '@') return;               /* @font-face / @media 等不复制 */
    const aliased = head
      .replace(/\.message-sent\b/g, '.msg.mine .bubble')      /* 我发出的 */
      .replace(/\.message-received\b/g, '.msg.theirs .bubble')/* TA 发出的 */
      .replace(/\.message-bubble\b/g, '.msg .bubble');        /* 通用气泡 */
    if (aliased !== head) out.push(aliased + rule.slice(idx));
  });
  return out.join('\n');
}

/* ---------------- 防污染护盾：全局注入前把每条规则锁进 #page-chat 作用域 ----------------
 * 背景：Toast（#toast）在 #app 之外，来电弹窗（#callLayer）在 #viewport 之外，
 *       二者都不在 #page-chat 内。用户一旦写了 div / .bubble 这类宽泛选择器，
 *       全局注入就会误伤系统浮层。统一加 #page-chat 前缀后物理隔离。
 * 规则：
 *   1. 普通选择器一律加 "#page-chat " 前缀（已带前缀的不重复加）；
 *   2. body / html / :root 改写为 #page-chat —— 字体在聊天页整体继承生效，
 *      同时保证注入样式绝对碰不到真正的 body 与全局 div；
 *   3. @font-face / @keyframes 是定义块、不渲染任何元素，原样保留；
 *   4. @media / @supports 递归处理内部；
 *   5. @import 无法作用域化，统一提取到最前并补回分号（CSS 规范也要求它在规则之前）。
 * ---------------------------------------------------------------------------------- */
function csScopeSelectorToChat(head) {
  return head.split(',').map(s => {
    const t = s.trim();
    if (!t) return '';
    if (/^(?:body|html|:root)\b/i.test(t)) return t.replace(/^(?:body|html|:root)\b/i, '#page-chat');
    if (/^#page-chat\b/i.test(t)) return t;
    return '#page-chat ' + t;
  }).filter(Boolean).join(', ');
}

function csScopeToChat(css) {
  const split = csSplitTopRules(css);
  if (split.broken) return css;   /* 语法有问题时原样返回，交给语法校验报错 */
  const imports = [];
  const out = [];
  split.rules.forEach(rule => {
    const idx = rule.indexOf('{');
    if (idx < 0) {
      /* @import / @charset 等顶层语句：拆分时分号被吃掉，这里补回 */
      imports.push(/;\s*$/.test(rule) ? rule : rule.replace(/\s*$/, ';'));
      return;
    }
    const head = rule.slice(0, idx);
    const headClean = head.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    const end = rule.lastIndexOf('}');
    const inner = rule.slice(idx + 1, end < 0 ? rule.length : end);
    const tail = end < 0 ? '' : rule.slice(end);
    if (/^@(font-face|keyframes|-webkit-keyframes|-moz-keyframes|charset|namespace|page|counter-style|property|font-feature-values)/i.test(headClean)) {
      out.push(rule);
      return;
    }
    if (headClean.charAt(0) === '@') {
      out.push(head + '{' + csScopeToChat(inner) + tail);
      return;
    }
    out.push(csScopeSelectorToChat(head) + '{' + inner + tail);
  });
  return imports.concat(out).join('\n');
}

/* 智能解析：纯链接 → @font-face / @import；带大括号的完整 CSS → 原样注入（只补 !important）；
   纯属性 → 自动包裹该分类的精准选择器（气泡 .msg .bubble / 字体 body, .chat-text）。
   注意：这里不做作用域；全局注入入口 applyCustomStyleInline 会统一再套 #page-chat。 */
function csBuildCSS(raw, tab) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return '';

  /* 1) 链接：整段只有一个 URL 时才按链接处理，避免把含 http 的代码误判 */
  if (/^https?:\/\//i.test(text) && !/\s/.test(text)) {
    const clean = text.split('?')[0].split('#')[0].toLowerCase();
    /* 字体直链（.ttf / .woff / .woff2 / .otf）→ @font-face + 生效选择器 */
    if (/\.(ttf|otf|woff2|woff|eot)$/.test(clean)) return csFontLinkCSS(text);
    /* CSS 文件 / 其它链接 → 按样式表导入（@import 不能加 !important） */
    return `@import url('${text}');`;
  }

  /* 2) 含大括号（或 @ 规则）→ 原封不动地直接注入，只补 !important 提升权重，绝不包裹；
     若只写了旧类名 .message-*，再追加一份命中真实聊天 DOM 的别名规则 */
  if (/\{/.test(text) || /^@/.test(text)) {
    const base = csForceImportant(text);
    const alias = csAliasBubbleCss(base);
    return alias ? base + '\n\n' + alias : base;
  }

  /* 3) 纯属性：自动包裹该分类的精准选择器（注入时再锁 #page-chat，绝不污染系统浮层） */
  const target = tab === 'bubble' ? '.msg .bubble' : 'body, .chat-text';
  return csForceImportant(`${target} { ${text} }`);
}

/* ---------------- 识别并应用：语法校验 / 外链预检 ----------------
 * 校验针对「解析后要注入的最终 CSS」。
 * -------------------------------------------------------------- */

/* 把 CSS 拆成顶层规则块：insertRule 一次只能插一条规则，
   多规则整体插入必然报错，所以先按顶层花括号拆分逐条校验。
   返回值：{ rules, broken }，broken 表示括号不配对（多余右括号 / 未闭合左括号） */
function csSplitTopRules(css) {
  const out = [];
  let buf = '';
  let depth = 0;
  let quote = '';
  let comment = false;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    const nx = css[i + 1];
    if (comment) {
      buf += ch;
      if (ch === '*' && nx === '/') { buf += nx; i++; comment = false; }
      continue;
    }
    if (quote) {
      buf += ch;
      if (ch === '\\') { if (nx) { buf += nx; i++; } continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && nx === '*') { buf += '/*'; i++; comment = true; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '{') { depth++; buf += ch; continue; }
    if (ch === '}') {
      depth--;
      if (depth < 0) { return { rules: out, broken: true }; }  /* 多余的右括号 */
      buf += ch;
      if (depth === 0) { out.push(buf); buf = ''; }
      continue;
    }
    if (ch === ';' && depth === 0) {
      /* 顶层分号：@import / @charset 这类语句在这里结束 */
      if (buf.trim()) { out.push(buf); buf = ''; }
      continue;
    }
    buf += ch;
  }
  if (quote || comment || depth > 0) return { rules: out, broken: true };  /* 未闭合的引号 / 注释 / 括号 */
  if (buf.trim()) out.push(buf);
  return { rules: out, broken: false };
}

/* 语法校验：临时建一个 style，把每条规则 insertRule 进去，任一失败即判为语法错误。
   @import / @charset / @namespace 属于语句而非规则，跳过 insertRule（它们的有效性由外链预检负责） */
function csValidateCss(css) {
  const split = csSplitTopRules(css);
  if (split.broken) return { ok: false };
  const rules = split.rules.filter(r => r.trim());
  if (!rules.length) return { ok: true };
  const probe = document.createElement('style');
  document.head.appendChild(probe);
  try {
    const sheet = probe.sheet;
    if (!sheet) return { ok: true };            /* 环境不支持则跳过校验，不阻塞应用 */
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i].trim();
      if (/^@(import|charset|namespace)\b/i.test(rule)) continue;
      try {
        sheet.insertRule(rule, sheet.cssRules.length);
      } catch (e) {
        return { ok: false };
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false };
  } finally {
    probe.remove();
  }
}

/* 提取代码里所有 url(...) 链接：Base64、纯色 #、blob 不联网，直接跳过 */
function csExtractUrls(css) {
  const out = [];
  const seen = new Set();
  const re = /url\(\s*(?:'([^']*)'|"([^"]*)"|([^)]*?))\s*\)/gi;
  let m;
  while ((m = re.exec(css))) {
    const raw = String(m[1] != null ? m[1] : (m[2] != null ? m[2] : m[3])).trim();
    if (!raw) continue;
    if (/^(data|blob|about):/i.test(raw) || raw.charAt(0) === '#') continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/* 单个外链探测：true = 能正常加载。
   fetch 能拿到真实状态码（同源或带 CORS 的 CDN）；
   被 CORS 拦下时，图片类退回 new Image() 真解码，
   字体 / CSS 类无法确认则放行，避免把可用资源误判为失败 */
function csProbeResource(url) {
  return new Promise(resolve => {
    let done = false;
    const fin = ok => { if (!done) { done = true; resolve(ok); } };
    const isImage = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)(\?|#|$)/i.test(url);
    const timer = setTimeout(() => fin(false), 8000);
    const end = ok => { clearTimeout(timer); fin(ok); };
    try {
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      if (ctrl) setTimeout(() => { try { ctrl.abort(); } catch (e) { /* 已结束 */ } }, 8000);
      fetch(url, { method: 'GET', cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
        .then(res => end(res.ok || res.status === 0))
        .catch(() => {
          if (!isImage) { end(true); return; }
          const img = new Image();
          img.onload = () => end(true);
          img.onerror = () => end(false);
          img.src = url;
        });
    } catch (e) {
      end(!isImage);
    }
  });
}

/* 预览作用域：把每条选择器前面加上 .cs-preview，任意用户代码都只影响预览框 */
function csScopeBlock(css, prefix) {
  let out = '';
  let buf = '';
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '{') {
      /* 找到配对的右花括号，内部整体交给下一层处理 */
      let j = i + 1, depth = 1;
      while (j < css.length && depth > 0) {
        if (css[j] === '{') depth++;
        else if (css[j] === '}') depth--;
        j++;
      }
      const inner = css.slice(i + 1, j - 1);
      const head = buf.trim();
      buf = '';
      if (!head) {
        out += '{' + inner + '}';
      } else if (head.charAt(0) === '@') {
        out += /^@(media|supports|layer|container|document)/i.test(head)
          ? head + ' {' + csScopeBlock(inner, prefix) + '}'
          : head + ' {' + inner + '}';   /* @font-face / @keyframes 保持原样 */
      } else {
        const sels = head.split(',').map(s => {
          const t = s.trim();
          if (!t) return '';
          /* 预览容器不在 #app 里：去掉 #app 前缀，否则这些选择器在预览里永远不命中 */
          const clean = t.replace(/^#app\s+/i, '');
          return prefix + ' ' + clean;
        }).filter(Boolean).join(', ');
        out += sels + ' {' + inner + '}';
      }
      i = j;
    } else if (ch === '}') {
      buf = '';
      i++;
    } else {
      buf += ch;
      i++;
    }
  }
  return out;
}

function csScopeCSS(css, prefix) {
  const imports = (css.match(/@import\s+url\([^)]*\)\s*;/gi) || []).join('\n');
  const rest = css.replace(/@import\s+url\([^)]*\)\s*;/gi, '');
  return (imports ? imports + '\n' : '') + csScopeBlock(rest, prefix);
}

/* 超大样式（Base64 字体草稿可达几十 MB）判定阈值：超过则构建 / 注入一律异步 */
const CS_BIG_CSS_LEN = 1024 * 1024;

/* 实时预览：解析当前分类的草稿并注入预览作用域（预览不套 #app 前缀，否则永远不命中）。
 * 超大字体草稿走 setTimeout 异步注入，避免几十 MB 的 style 写入阻塞主线程造成假死；
 * 异步分支在执行时重新读取草稿，清空操作不会被旧内容覆盖 */
function csUpdatePreview() {
  const draft = csDraft[csTab] || '';
  if (draft.length > CS_BIG_CSS_LEN) {
    setTimeout(() => {
      try {
        const css = csBuildCSS(csDraft[csTab] || '', csTab);
        csPreviewStyle().textContent = css ? csScopeCSS(css, '.cs-preview') : '';
      } catch (e) { /* 超大文本注入失败不影响页面其它功能 */ }
    }, 0);
    return;
  }
  const css = csBuildCSS(draft, csTab);
  csPreviewStyle().textContent = css ? csScopeCSS(css, '.cs-preview') : '';
}

/* 全局注入：超大字体样式延迟到下一轮事件循环，防止点击「应用」时页面卡住 */
function csApplyInlineDeferred() {
  const css = ((state.beautify.customStyle.applied || {})[csTab]) || '';
  if (css.length > CS_BIG_CSS_LEN) {
    setTimeout(() => { try { applyCustomStyleInline(state.beautify); } catch (e) { /* 忽略 */ } }, 0);
  } else {
    applyCustomStyleInline(state.beautify);
  }
}

/* localStorage 镜像：满足「保存到 localStorage」；预设含大字体时失败也无妨，IndexedDB 才是主存储 */
function customStyleMirror() {
  const cs = state.beautify.customStyle;
  try { localStorage.setItem('dc-custom-css-v1', JSON.stringify(cs.applied)); } catch (e) { /* 配额不足时忽略 */ }
  try { localStorage.setItem('dc-custom-presets-v1', JSON.stringify(cs.presets)); } catch (e) { /* 配额不足时忽略 */ }
}

/* 复制带大括号的完整代码模板：优先 Clipboard API，非安全环境退回 execCommand */
async function csCopyTemplate() {
  const text = CS_TEMPLATES[csTab] || CS_TEMPLATES.font;
  let ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch (e) { ok = false; }
  if (!ok) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    } catch (e) { ok = false; }
  }
  showToast(ok ? '模板已复制' : '复制失败，请长按输入框手动复制');
}

/* 一键清空：只清空当前分类的编辑草稿与预览，不影响已应用的全局样式和已保存的预设 */
function csClearDraft() {
  csDraft[csTab] = '';
  const input = $('#csInput');
  if (input) input.value = '';
  if (csPreviewTimer) { clearTimeout(csPreviewTimer); csPreviewTimer = null; }
  /* 立即清掉预览注入的样式，预览框瞬间回到默认气泡与默认字体 */
  csPreviewStyle().textContent = '';
  /* 顺带清掉上一次的校验结果，避免清空后还留着红字报错 */
  csSetStatus('', '');
  showToast('已清空输入框内容');
}

function csSwitchTab(mode) {
  if (!mode || mode === csTab) return;
  csTab = mode;
  state.beautify.customStyle.tab = mode;
  csSetStatus('', '');   /* 换分类后旧的校验结果不再适用 */
  $$('[data-cs-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.csTab === mode));
  const up = $('#csUploadFont');
  if (up) up.classList.toggle('hidden', mode !== 'font');
  const input = $('#csInput');
  if (input) input.value = csDraft[mode] || '';
  csUpdatePreview();
}

/* 应用到全局：空输入视为清除该分类的自定义样式 */
function csApplyCurrent() {
  const css = csBuildCSS(csDraft[csTab], csTab);
  const cs = state.beautify.customStyle;
  cs.applied[csTab] = css;
  cs.tab = csTab;
  persist();
  customStyleMirror();
  csApplyInlineDeferred();   /* 超大字体异步注入，防止阻塞主线程 */
  /* 方便排查：控制台能直接看到真正注入到 head 的最终 CSS */
  console.info('[样式自定义] 已注入 #custom-style-injector，长度 ' + css.length + '\n' + css);
  showToast(css ? '已应用到全局' : '已清除该分类的自定义样式');
}

/* 状态标签：ok 绿 / error 红 / warn 橙 / info 灰 */
function csSetStatus(kind, text) {
  const el = $('#css-apply-status');
  if (!el) return;
  el.className = 'cs-apply-status' + (kind ? ' ' + kind : '');
  el.textContent = text || '';
}

/* 识别并应用：清空状态 → 语法校验 → 外链预检 → 原样注入 → 类名校验 → 落盘
   带大括号的完整 CSS 永远原样注入，纯属性自动包裹该分类的精准选择器 */
async function csApplyGuarded() {
  csSetStatus('', '');
  const raw = String(csDraft[csTab] || '').trim();
  if (!raw) {
    csSetStatus('error', '❌ 请输入代码');
    showToast('请输入代码');
    return;
  }
  /* 智能解析：链接 / 完整 CSS 原样注入，纯属性自动包裹 */
  const css = csBuildCSS(raw, csTab);
  if (!css) {
    csSetStatus('error', '❌ 请输入代码');
    showToast('请输入代码');
    return;
  }

  /* 1) 语法校验：逐条 insertRule，任一失败即判定为语法错误 */
  if (!csValidateCss(css).ok) {
    csSetStatus('error', '❌ 代码语法错误，请检查括号或分号');
    showToast('代码语法错误，请检查括号或分号');
    return;
  }

  /* 2) 外链预检：url() 里的图片 / 字体能否正常加载 */
  const urls = csExtractUrls(css);
  if (urls.length) {
    csSetStatus('info', '⏳ 正在检查资源链接…');
    const results = await Promise.all(urls.map(csProbeResource));
    if (results.indexOf(false) !== -1) {
      csSetStatus('error', '❌ 资源加载失败，请检查图片/字体链接是否有效');
      showToast('资源加载失败，请检查图片/字体链接是否有效');
      return;
    }
  }

  /* 3) 写入并落盘：state（IndexedDB）+ localStorage 镜像，刷新后依然生效 */
  const cs = state.beautify.customStyle;
  cs.applied[csTab] = css;
  cs.tab = csTab;
  persist();
  customStyleMirror();
  csApplyInlineDeferred();   /* 超大字体异步注入，防止阻塞主线程 */
  console.info('[样式自定义] 已注入 #custom-style-injector，长度 ' + css.length + '\n' + css);

  /* 4) 类名校验：命中需求指定的三个类名，或项目真实在用的 .bubble / .chat-text，即算作用到气泡上 */
  if (/(?:^|[^\w.-])\.\s*(message-sent|message-received|message-bubble|bubble|chat-text)\b/.test(css)) {
    csSetStatus('ok', '✅ 应用成功！');
    showToast('已应用到全局');
  } else {
    csSetStatus('warn', '⚠️ 已应用，但未检测到气泡类名；若界面无变化，请检查类名是否与现有气泡匹配');
    showToast('已应用，可检查类名是否匹配');
  }
}

async function csSavePreset() {
  const name = await promptDialog('保存为预设', '给这套样式起个名字', csTab === 'font' ? '字体预设' : '气泡预设');
  if (name === null) return;
  if (!name) { showToast('预设名称不能为空'); return; }
  const raw = csDraft[csTab] || '';
  const css = csBuildCSS(raw, csTab);
  if (!css) { showToast('请先粘贴或上传内容'); return; }
  const cs = state.beautify.customStyle;
  cs.presets.unshift({
    id: uid(),
    name: String(name).slice(0, 20),
    mode: csTab,
    code: raw,
    css,
    font: csLastFontData || '',
    ts: Date.now()
  });
  persist();
  customStyleMirror();
  renderBeautifyPage();
  /* 大字体预设（代码 + Base64 字体数据）会明显占用 IndexedDB 空间，保存后提醒 */
  const big = raw.length + css.length + String(csLastFontData || '').length > CS_BIG_CSS_LEN;
  showToast(big ? '预设已保存。注意：保存大字体预设会占用较多空间' : '预设已保存');
}

function csLoadPreset(id) {
  const p = state.beautify.customStyle.presets.find(x => x.id === id);
  if (!p) return;
  if (p.mode !== csTab) csSwitchTab(p.mode);
  csDraft[p.mode] = p.code || '';
  const input = $('#csInput');
  if (input) input.value = csDraft[p.mode];
  csUpdatePreview();
  showToast('已载入预设：' + p.name);
}

async function csDeletePreset(id) {
  const p = state.beautify.customStyle.presets.find(x => x.id === id);
  if (!p) return;
  const ok = await confirmDialog('删除预设', '确定删除「' + p.name + '」吗？', '删除', true);
  if (!ok) return;
  state.beautify.customStyle.presets = state.beautify.customStyle.presets.filter(x => x.id !== id);
  persist();
  customStyleMirror();
  renderBeautifyPage();
  showToast('已删除预设');
}

/* 上传 TTF：读成 Base64 → 生成 @font-face + 使用规则，填入字体分类的输入框。
 * 大小限制从 6MB 放宽到 30MB 软上限（超过只警告、不拦截）；
 * 大文件读取期间显示全局 Loading，防止十几 MB 转换 Base64 时用户误以为卡死 */
const CS_FONT_SOFT_LIMIT = 30 * 1024 * 1024;   /* 30MB 软上限 */

/* 全局 Loading（字体解析专用）：动态创建 / 销毁遮罩，不影响其它页面 */
function csFontLoading(show) {
  let mask = document.getElementById('csFontLoading');
  if (show) {
    if (mask) return;
    mask = document.createElement('div');
    mask.id = 'csFontLoading';
    mask.style.cssText = 'position:fixed;inset:0;z-index:20000;background:rgba(0,0,0,.35);display:grid;place-items:center;';
    mask.innerHTML = '<div style="background:rgba(24,30,40,.92);color:#fff;font-size:13px;padding:12px 22px;border-radius:12px;line-height:1.6;">正在解析字体文件，请稍候...</div>';
    document.body.appendChild(mask);
  } else if (mask) {
    mask.remove();
  }
}

function csReadFontFile(file) {
  if (!file) return;
  /* 格式粗筛：扩展名或 font/* MIME 至少要过一个，明显不对的文件直接提示 */
  const okType = /\.(ttf|otf|woff2?|eot)$/i.test(file.name) || /^font\//.test(file.type || '');
  if (!okType) { showToast('字体解析失败，请检查文件格式'); return; }
  /* 超 30MB 不拦截，仅提示存储与加载开销 */
  if (file.size > CS_FONT_SOFT_LIMIT) {
    showToast('建议使用 20MB 以内的 TTF/OTF 字体文件。较大的字体会占用较多存储空间，可能影响网页加载速度。');
  }
  csFontLoading(true);
  const reader = new FileReader();
  reader.onload = () => {
    /* 异步落地：Base64 字符串可达几十 MB，生成代码与写输入框放到下一轮事件循环，防止阻塞主线程 */
    setTimeout(() => {
      try {
        const data = String(reader.result || '');
        if (!data || data.indexOf('data:') !== 0) throw new Error('bad font data');
        csLastFontData = data;
        if (csTab !== 'font') csSwitchTab('font');
        csDraft.font = csFontFace(data, csFontFormat(file.name), 'CustomFont') + '\n' +
          `${CS_FONT_SELECTOR} { font-family: 'CustomFont', -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif !important; }`;
        const input = $('#csInput');
        if (input) input.value = csDraft.font;
        csUpdatePreview();   /* 内部对超大文本已做异步注入 */
        showToast('字体已载入，点【应用到全局】生效');
      } catch (e) {
        showToast('字体解析失败，请检查文件格式');
      } finally {
        csFontLoading(false);
      }
    }, 30);
  };
  reader.onerror = () => { csFontLoading(false); showToast('字体解析失败，请检查文件格式'); };
  reader.onabort = reader.onerror;
  try {
    reader.readAsDataURL(file);
  } catch (e) {
    csFontLoading(false);
    showToast('字体解析失败，请检查文件格式');
  }
}

/* 样式自定义面板（美化页最下方） */
function customStylePanelHTML() {
  const cs = state.beautify.customStyle;
  csTab = cs.tab === 'bubble' ? 'bubble' : 'font';
  /* 首次进入回填已应用的代码；之后保留用户正在编辑的草稿 */
  if (!csDraft.font) csDraft.font = cs.applied.font || '';
  if (!csDraft.bubble) csDraft.bubble = cs.applied.bubble || '';
  const presets = cs.presets || [];
  return `
    <div class="panel" id="customStylePanel">
      <div class="panel-title">样式自定义</div>
      <!-- 分类切换：字体 / 气泡 -->
      <div class="cs-tabs">
        <button class="cs-tab ${csTab === 'font' ? 'active' : ''}" data-cs-tab="font">设置字体样式</button>
        <button class="cs-tab ${csTab === 'bubble' ? 'active' : ''}" data-cs-tab="bubble">设置气泡样式</button>
      </div>
      <!-- 操作栏：复制模板；字体分类额外显示上传 TTF；清空只清编辑草稿 -->
      <div class="cs-toolbar">
        <button class="btn ghost" id="csCopyTemplate">复制代码模板</button>
        <button class="btn ghost ${csTab === 'font' ? '' : 'hidden'}" id="csUploadFont">上传 TTF 字体</button>
        <button class="btn ghost cs-clear" id="csClear" title="清空输入框">清空</button>
      </div>
      <!-- 代码输入区 -->
      <textarea class="cs-input" id="csInput" spellcheck="false" placeholder="请粘贴 CSS 代码、在线字体链接或 CSS 文件链接">${esc(csDraft[csTab] || '')}</textarea>
      <div class="muted" style="font-size:12px;margin:6px 0 0;line-height:1.6">样式只在聊天页内生效（自动锁定 #page-chat 作用域），绝不会污染 Toast、来电弹窗等系统界面。纯属性（如 background: pink;）会自动包裹气泡/文字选择器并强制加 !important；含花括号的代码原样注入。贴字体直链（.ttf / .woff / .woff2）自动生成 @font-face，贴 .css 链接自动生成 @import。若应用成功但界面没变化，请检查类名是否命中 .msg.mine / .msg.theirs > .msg-body > .bubble（可在控制台检查）。</div>
      <!-- 共用预览区：DOM 与聊天页完全一致（.msg.theirs / .msg.mine > .msg-body > .bubble），
           这样预览里生效的代码，在真实聊天页必然也生效 -->
      <div class="cs-preview" id="csPreview">
        <div class="msg theirs">
          <div class="msg-body"><div class="bubble">今晚的风很轻，我把今天的心事折成纸船，放进你的梦里。</div></div>
        </div>
        <div class="msg mine">
          <div class="msg-body"><div class="bubble">那我在岸边等你，记得带上我最喜欢的那颗星。</div></div>
        </div>
        <div class="cs-test-text chat-text">字体预览 · AaBb 0123 · 梦之信使</div>
      </div>
      <!-- 操作按钮区：应用到全局 / 识别并应用（主色）+ 状态标签 -->
      <div class="btn-row cs-apply-row">
        <button class="btn primary" id="csApply" style="flex:1">应用到全局</button>
        <button class="btn primary" id="csApplySafe" style="flex:1">识别并应用</button>
        <span id="css-apply-status" class="cs-apply-status"></span>
      </div>
      <div class="btn-row" style="margin-top:8px">
        <button class="btn ghost" id="csSavePreset" style="flex:1">保存为预设</button>
      </div>
      <!-- 预设列表 -->
      <div class="muted" style="font-size:12px;margin:14px 0 6px">我的预设（点击加载）</div>
      <div class="cs-preset-list" id="csPresetList">
        ${presets.length ? presets.map(p => `
          <div class="cs-preset">
            <button class="cs-preset-main" data-cs-load="${p.id}">
              <span class="cs-badge">${p.mode === 'bubble' ? '气泡' : '字体'}</span>
              <span class="cs-preset-name">${esc(p.name)}</span>
            </button>
            <button class="cs-preset-del" data-cs-del="${p.id}" aria-label="删除预设">×</button>
          </div>`).join('') : '<div class="cs-empty">还没有预设，调好样式后点【保存为预设】。</div>'}
      </div>
      <input type="file" id="csFontFile" accept=".ttf,.otf,.woff,.woff2,font/*" class="hidden">
    </div>`;
}

function bindCustomStyleEvents() {
  $$('[data-cs-tab]').forEach(btn => btn.addEventListener('click', () => csSwitchTab(btn.dataset.csTab)));

  const copyBtn = $('#csCopyTemplate');
  if (copyBtn) copyBtn.addEventListener('click', csCopyTemplate);

  const upBtn = $('#csUploadFont');
  if (upBtn) upBtn.addEventListener('click', () => {
    const input = $('#csFontFile');
    if (input) { input.value = ''; input.click(); }
  });
  const fileInput = $('#csFontFile');
  if (fileInput) fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    if (file) csReadFontFile(file);
    fileInput.value = '';
  });

  const input = $('#csInput');
  if (input) input.addEventListener('input', () => {
    csDraft[csTab] = input.value;
    if (csPreviewTimer) clearTimeout(csPreviewTimer);
    csPreviewTimer = setTimeout(csUpdatePreview, 300);   /* 防抖：边输入边预览 */
  });

  const applyBtn = $('#csApply');
  if (applyBtn) applyBtn.addEventListener('click', csApplyCurrent);
  const safeApplyBtn = $('#csApplySafe');
  if (safeApplyBtn) safeApplyBtn.addEventListener('click', csApplyGuarded);
  const clearBtn = $('#csClear');
  if (clearBtn) clearBtn.addEventListener('click', csClearDraft);
  const saveBtn = $('#csSavePreset');
  if (saveBtn) saveBtn.addEventListener('click', csSavePreset);

  /* 预设列表：容器委托，点击加载 / 删除 */
  const list = $('#csPresetList');
  if (list) list.addEventListener('click', e => {
    const del = e.target.closest('[data-cs-del]');
    if (del) { e.stopPropagation(); csDeletePreset(del.dataset.csDel); return; }
    const load = e.target.closest('[data-cs-load]');
    if (load) csLoadPreset(load.dataset.csLoad);
  });

  csUpdatePreview();
}

function renderBeautifyPage() {
  const b = state.beautify;
  const roleId = state.activeRoleId || (state.roles[0] && state.roles[0].id) || '';
  const perRole = (b.chatWallByRole || {})[roleId] || '';
  const presetHTML = (key, current) => `
    <div class="wall-grid">
      <button class="wall-cell ${!current ? 'active' : ''}" data-wall="${key}" data-value="" style="background:#F2F2F7"><span>默认</span></button>
      ${WALL_PRESETS.map(p => `<button class="wall-cell ${current === 'preset:' + p.id ? 'active' : ''}" data-wall="${key}" data-value="preset:${p.id}" style="background:${p.css}"><span>${p.name}</span></button>`).join('')}
    </div>`;

  /* 主题颜色：当前值回显（预设点高亮、调色板取色器同步当前色），切换后立即应用并持久化 */
  const curTheme = String(state.settings.theme || '#007AFF');
  const themeHex = /^#[0-9a-fA-F]{6}$/.test(curTheme) ? curTheme : '#007AFF';
  const themeIs = c => themeHex.toLowerCase() === String(c).toLowerCase();
  const themeLabel = (THEME_PRESETS.find(p => themeIs(p.c)) || {}).n || themeHex.toUpperCase();

  subShell('美化', `
    <div class="panel">
      <div class="panel-title">桌面壁纸</div>
      ${presetHTML('deskWall', b.deskWall)}
      <div class="btn-row" style="margin-top:10px">
        <button class="btn ghost" id="uploadDesk" style="flex:1">上传图片</button>
        <button class="btn ghost" id="urlDesk" style="flex:1">图片链接</button>
      </div>
    </div>
    <div class="panel">
      <div class="panel-title">聊天壁纸</div>
      <div class="field"><label>应用梦角</label>
        <select class="select" id="beautyChatRole">${state.roles.map(r => `<option value="${r.id}"${r.id === roleId ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select>
      </div>
      <div class="muted" style="font-size:12px;margin-bottom:8px">当前梦角单独设置；未单独设置时使用全局聊天壁纸。</div>
      ${presetHTML('chatWallByRole', perRole)}
      <div class="btn-row" style="margin-top:10px">
        <button class="btn ghost" id="uploadChat" style="flex:1">上传图片</button>
        <button class="btn ghost" id="urlChat" style="flex:1">图片链接</button>
      </div>
      <div class="muted" style="font-size:12px;margin:14px 0 6px">全局聊天壁纸（所有梦角通用）</div>
      ${presetHTML('chatWallGlobal', b.chatWallGlobal)}
    </div>
    <div class="panel">
      <div class="panel-title">空间壁纸</div>
      ${presetHTML('spaceWall', b.spaceWall)}
      <div class="btn-row" style="margin-top:10px">
        <button class="btn ghost" id="uploadSpace" style="flex:1">上传图片</button>
        <button class="btn ghost" id="urlSpace" style="flex:1">图片链接</button>
      </div>
    </div>
    <div class="panel">
      <div class="panel-title">主题颜色</div>
      <div class="muted" style="font-size:12px;margin-bottom:8px">点击色块立即应用；自定义颜色会先弹出取色面板，点【确认】后才生效</div>
      <div class="color-row">
        ${THEME_PRESETS.map(p => `<button class="color-dot ${themeIs(p.c) ? 'active' : ''}" data-tcolor="${p.c}" title="${p.n}" aria-label="${p.n}" style="background:${p.c}"></button>`).join('')}
        <button class="color-custom" id="themeCustomBtn" type="button" title="自定义颜色" aria-label="自定义颜色">＋</button>
      </div>
      <div class="muted" id="themeColorText" style="margin-top:8px;font-size:12px">当前主题色：${themeLabel}</div>
    </div>
    <div class="panel">
      <div class="panel-title">图标主题</div>
      <div class="theme-grid">
        <button class="theme-cell ${b.iconTheme === 'blue' ? 'active' : ''}" data-theme="blue">标准</button>
        <button class="theme-cell ${b.iconTheme === 'light' ? 'active' : ''}" data-theme="light">浅底</button>
        <button class="theme-cell ${b.iconTheme === 'dark' ? 'active' : ''}" data-theme="dark">深底</button>
      </div>
    </div>
    <div class="panel">
      <div class="panel-title">组件外观</div>
      <div class="slider-row row-between">
        <div>
          <div style="font-size:13px">开启磨砂玻璃（毛玻璃效果）</div>
          <div class="muted">作用于桌面 5 个区块（日历、情侣空间、自定义句子、功能图标、梦角）。开启后叠加背景模糊；关闭时只有半透明白底，壁纸清晰不模糊</div>
        </div>
        <label class="switch"><input type="checkbox" id="glassOn" ${b.glassOn ? 'checked' : ''}><span class="slider"></span></label>
      </div>
      ${sliderRowHTML('透明度调节', '5 个区块白色底的透明度，数值越低越能透出背后的壁纸（开关磨砂都实时生效）', 'glassOpacity', b.glassOpacity, 0, 100, '%')}
    </div>
    <div class="panel">
      <button class="btn ghost block" id="beautyReset">恢复默认外观</button>
    </div>
    ${customStylePanelHTML()}`);

  const setWallValue = (key, value) => {
    if (key === 'chatWallByRole') {
      const rid = $('#beautyChatRole').value;
      state.beautify.chatWallByRole[rid] = value;
    } else {
      state.beautify[key] = value;
    }
    persist();
    applyBeautify();
    renderBeautifyPage();
  };

  $$('[data-wall]').forEach(btn => btn.addEventListener('click', () => setWallValue(btn.dataset.wall, btn.dataset.value)));
  $$('[data-theme]').forEach(btn => btn.addEventListener('click', () => {
    state.beautify.iconTheme = btn.dataset.theme;
    persist();
    applyBeautify();
    renderBeautifyPage();
  }));
  $('#beautyChatRole').addEventListener('change', () => renderBeautifyPage());

  /* 主题颜色：预设色块一键应用；自定义颜色改为「确认后生效」弹窗——
   * 拖动取色盘时只更新弹窗内的小预览，绝不写全局变量、不保存、不重渲染，
   * 避免磨砂玻璃页面被高频重绘拖垮 */
  $$('[data-tcolor]').forEach(btn => btn.addEventListener('click', () => setGlobalThemeColor(btn.dataset.tcolor)));
  const themeCustomBtn = $('#themeCustomBtn');
  if (themeCustomBtn) themeCustomBtn.addEventListener('click', openThemeColorPicker);

  /* 组件外观：磨砂开关 + 透明度滑块，实时写 CSS 变量并持久化 */
  const glassOnEl = $('#glassOn');
  if (glassOnEl) glassOnEl.addEventListener('change', e => {
    state.beautify.glassOn = e.target.checked;
    persist();
    applyBeautify();
  });
  const glassRange = $('#glassOpacityRange');
  const glassNum = $('#glassOpacityNum');
  const applyGlassOpacity = raw => {
    const v = clamp(parseInt(raw, 10) || 0, 0, 100);
    state.beautify.glassOpacity = v;
    if (glassRange) glassRange.value = v;
    if (glassNum) glassNum.value = v;
    persist();
    applyBeautify();
  };
  if (glassRange) glassRange.addEventListener('input', () => applyGlassOpacity(glassRange.value));
  if (glassNum) glassNum.addEventListener('change', () => applyGlassOpacity(glassNum.value));

  const uploadWall = key => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    /* iOS Safari 必须把 input 放进文档里，程序化 click 才会弹出相册 */
    input.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;';
    document.body.appendChild(input);
    const cleanup = () => { try { input.remove(); } catch (e) {} };
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) { cleanup(); return; }
      const reader = new FileReader();
      reader.onload = () => {
        const raw = String(reader.result || '');
        const img = new Image();
        img.onload = () => {
          try {
            const max = 800;
            let w = img.width, h = img.height;
            if (w > max || h > max) {
              const ratio = Math.min(max / w, max / h);
              w = Math.round(w * ratio); h = Math.round(h * ratio);
            }
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            const data = canvas.toDataURL('image/jpeg', .7);
            if (data.length > 900000) { showToast('图片过大，换一张试试'); cleanup(); return; }
            setWallValue(key, data);
            showToast('壁纸已更新');
          } catch (e) {
            /* 压缩失败时直接用原图，保证一定能设置 */
            if (raw) { setWallValue(key, raw); showToast('壁纸已更新'); }
            else showToast('这张图片读取失败，换一张试试');
          }
          cleanup();
        };
        img.onerror = () => {
          /* 部分格式（如 HEIC）无法解码时，退回原始图片数据 */
          if (raw) { setWallValue(key, raw); showToast('壁纸已更新'); }
          else showToast('这张图片格式不支持，请换 JPG / PNG');
          cleanup();
        };
        img.src = raw;
      };
      reader.onerror = () => { showToast('读取图片失败，换一张试试'); cleanup(); };
      reader.readAsDataURL(file);
    });
    input.click();
  };

  [['#uploadDesk', 'deskWall'], ['#uploadChat', 'chatWallByRole'], ['#uploadSpace', 'spaceWall']].forEach(([sel, key]) => {
    const btn = $(sel);
    if (btn) btn.addEventListener('click', () => uploadWall(key));
  });

  const urlWall = key => {
    promptDialog('图片链接', '粘贴一张图片的 https 链接', '').then(v => {
      if (v === null) return;
      const url = v.trim();
      if (!url) return;
      setWallValue(key, url);
      showToast('壁纸已更新');
    });
  };
  [['#urlDesk', 'deskWall'], ['#urlChat', 'chatWallByRole'], ['#urlSpace', 'spaceWall']].forEach(([sel, key]) => {
    const btn = $(sel);
    if (btn) btn.addEventListener('click', () => urlWall(key));
  });

  $('#beautyReset').addEventListener('click', async () => {
    const ok = await confirmDialog('恢复默认外观', '将清除所有壁纸与图标主题设置。', '恢复', true);
    if (!ok) return;
    state.beautify = { deskWall: '', chatWallGlobal: '', chatWallByRole: {}, spaceWall: '', iconTheme: 'blue', glassOn: false, glassOpacity: 80,
      /* 自定义样式一并清空，但保留用户保存的预设 */
      customStyle: { tab: 'font', applied: { font: '', bubble: '' }, presets: (state.beautify.customStyle && state.beautify.customStyle.presets) || [] } };
    persist();
    applyBeautify();
    renderBeautifyPage();
    showToast('已恢复默认');
  });

  /* 样式自定义：分类切换、复制模板、上传字体、实时预览、应用 / 预设 */
  bindCustomStyleEvents();
}

/* =========================================================
 * 十二·六、转账（双向：我转给TA / TA转给我）
 * ========================================================= */
function openRedPacketComposer(roleId) {
  const role = roleById(roleId);
  if (!role) return;
  showModal({
    title: '转账给 ' + role.name,
    body: `
      <div class="field"><label>金额（元，单笔最高 50000）</label><input class="input" id="rpAmount" type="number" min="0.01" max="50000" step="0.01" placeholder="例如 8.88" value="8.88"></div>
      <div class="field"><label>备注（可选）</label><input class="input" id="rpBlessing" placeholder="转账" maxlength="40"></div>
      <div class="muted" style="font-size:12px;line-height:1.6">单笔转账最高 50000 元；金额仅作记录，不涉及真实支付。</div>`,
    actions: [
      { label: '取消' },
      {
        label: '转账', kind: 'primary', onClick: el => {
          const amount = Math.round((parseFloat($('#rpAmount', el).value) || 0) * 100) / 100;
          if (!(amount > 0)) { showToast('请输入正确的金额'); return false; }
          if (amount > 50000) { showToast('单笔转账最高 50000 元'); return false; }
          const blessing = $('#rpBlessing', el).value.trim() || '转账';
          sendRedPacket(roleId, amount, blessing, 1);
          return true;
        }
      }
    ]
  });
}

/* 聊天页【+】→ 送礼物：礼物列表、余额与价格、备注，确认后扣款并生成送礼卡片 */
function openGiftComposer(roleId) {
  const role = roleById(roleId);
  if (!role) return;
  if (!state.gifts.length) { showToast('还没有礼物，先去「送礼物」页添加'); return; }
  const gifts = state.gifts.slice();
  const priceOf = g => Math.max(0, Math.round((Number(g.price) || 0) * 100) / 100);
  let selectedId = gifts[0].id;
  const body = `
    <div class="gift-pick-grid">
      ${gifts.map(g => `
        <button class="gift-pick${g.id === selectedId ? ' active' : ''}" data-gift-pick="${g.id}">
          <span class="gp-icon">${esc(g.emoji || '🎁')}</span>
          <span class="gp-name">${esc(g.name)}</span>
          <span class="gp-price">${priceOf(g) > 0 ? money(priceOf(g)) : '免费'}</span>
        </button>`).join('')}
    </div>
    <div class="gift-pay-line">
      <span>钱包余额 <b>${money(walletBalance())}</b></span>
      <span>礼物价格 <b id="giftPayPrice">${priceOf(gifts[0]) > 0 ? money(priceOf(gifts[0])) : '免费'}</b></span>
    </div>
    <div class="field" style="margin-top:10px"><label>备注（可选）</label><input class="input" id="giftNote" placeholder="写一句想说的话" maxlength="40"></div>`;
  showModal({
    title: '送礼物给 ' + role.name,
    body,
    onMount: (el) => {
      const priceEl = $('#giftPayPrice', el);
      $$('[data-gift-pick]', el).forEach(btn => btn.addEventListener('click', () => {
        selectedId = btn.dataset.giftPick;
        $$('[data-gift-pick]', el).forEach(x => x.classList.toggle('active', x === btn));
        const g = gifts.find(x => x.id === selectedId);
        if (priceEl) priceEl.textContent = g && priceOf(g) > 0 ? money(priceOf(g)) : '免费';
      }));
    },
    actions: [
      { label: '取消' },
      {
        label: '送出', kind: 'primary', onClick: (el) => {
          const g = gifts.find(x => x.id === selectedId);
          if (!g) { showToast('请选择礼物'); return false; }
          if (priceOf(g) > walletBalance()) { showToast('钱包余额不足'); return false; }
          const note = ($('#giftNote', el).value || '').trim();
          sendGift(roleId, g.id, note);
          return true;
        }
      }
    ]
  });
}

/* 接收方在自己的气泡侧新增一张浅色「已接收」卡片；同一笔只补一张 */
function pushReceivedCard(roleId, kind, recordId, sender, payload) {
  const msgs = chatOf(roleId);
  const idKey = kind === 'redpacket' ? 'redPacketId' : 'giftRecordId';
  if (msgs.some(m => m.receivedCard === true && m.type === kind && m[idKey] === recordId)) return;
  const card = Object.assign({
    id: uid(), role: sender === 'ta' ? 'dream' : 'user', sender,
    type: kind, receivedCard: true, claimed: true,
    ts: Date.now(), read: true
  }, { [idKey]: recordId }, payload);
  msgs.push(card);
}

function sendRedPacket(roleId, amount, blessing, count) {
  const role = roleById(roleId);
  if (!role) return;
  /* 单笔转账统一封顶 50000 元（用户输入与任何调用入口的兜底校验） */
  if (amount > 50000) { showToast('单笔转账最高 50000 元'); return; }
  /* 钱包是转账的资金来源：余额不足直接中止，不产生记录与消息 */
  if (!walletSpend(amount, '转账给 ' + role.name, blessing, role)) {
    renderChatIf(roleId);
    return;
  }
  const rec = {
    id: uid(), roleId, roleName: role.name,
    amount, blessing, count, direction: 'out', status: 'pending', claimed: false,
    createTime: Date.now(), ts: Date.now()
  };
  state.redPackets.unshift(rec);
  const msg = {
    id: uid(), role: 'user', sender: 'user', type: 'redpacket', redPacketId: rec.id, direction: 'out',
    amount, blessing, count, claimed: false, ts: Date.now(), read: true
  };
  chatOf(roleId).push(msg);
  persist();
  renderChatIf(roleId);
  if (currentRoute.page === 'sub' && currentRoute.name === 'wallet') renderWalletPage();
  showToast('转账已发出');

  const chance = Number(state.settings.redPacketClaimChance ?? 80);
  setTimeout(() => {
    if (Math.random() * 100 >= chance) {
      persist();
      renderChatIf(roleId);
      return;
    }
    rec.status = 'claimed';
    rec.claimed = true;
    rec.claimedAt = Date.now();
    msg.claimed = true;
    /* 第二步：TA 在 TA 那一侧新增一张浅色已收款卡片 */
    pushReceivedCard(roleId, 'redpacket', rec.id, 'ta', { amount, blessing, count: 1 });
    persist();
    renderChatIf(roleId);
    sendTaBurst(roleId, {
      makeText: prev => composeUniqueReply(roleId, prev),
      fallback: '谢谢你，转账我收下啦。'
    });
  }, randInt(1400, 3000));
}

function claimRedPacket(roleId, msgId) {
  const msgs = chatOf(roleId);
  const msg = msgs.find(m => m.id === msgId);
  /* 已退回的卡片不可再收款 */
  if (!msg || msg.type !== 'redpacket' || msg.direction !== 'in' || msg.claimed || msg.returned) return;
  msg.claimed = true;
  const rec = state.redPackets.find(r => r.id === msg.redPacketId);
  if (rec) {
    if (rec.status === 'returned') return;
    rec.status = 'claimed'; rec.claimed = true; rec.claimedAt = Date.now();
  }
  /* 收款入钱包 */
  const claimRole = roleById(roleId);
  walletEarn(msg.amount, '来自 ' + (claimRole ? claimRole.name : taName()) + ' 的转账', '', claimRole);
  /* 第二步：我在我那一侧新增一张浅色已收款卡片；原卡片留在 TA 一侧并已变浅 */
  pushReceivedCard(roleId, 'redpacket', msg.redPacketId, 'user', {
    amount: msg.amount, blessing: msg.blessing || '转账', count: 1
  });
  persist();
  renderChatIf(roleId);
  if (currentRoute.page === 'sub' && currentRoute.name === 'wallet') renderWalletPage();
  showToast('已收款 ¥' + Number(msg.amount || 0).toFixed(2));
}

/* TA 主动转账：固定间隔 30~90 分钟判定一次，命中后随机梦角转来 */
function nextTaRedPacketDelay() {
  return randInt(30, 90) * 60 * 1000;
}

/* TA 主动转账金额：按权重分三档，封顶 50000 元，避免纯随机出天文数字。
   50% 日常消费（5~520 整数）、35% 特殊意义数字、15% 大额/节日红包（5000~50000 整数）。
   只作用于 TA 主动转账；用户自己发起转账填多少就是多少，不走这里。 */
const TA_SPECIAL_AMOUNTS = [5.20, 13.14, 52.0, 99.99, 131.4, 520, 999, 1314, 1999, 2000, 3344, 5200];
function generateTaTransferAmount() {
  const roll = Math.random() * 100;
  let amount;
  if (roll < 50) {
    /* 日常消费金额：5 ~ 520 的普通整数 */
    amount = randInt(5, 520);
  } else if (roll < 85) {
    /* 有特殊意义的数字：从预设数组随机抽取 */
    amount = TA_SPECIAL_AMOUNTS[randInt(0, TA_SPECIAL_AMOUNTS.length - 1)];
  } else {
    /* 较大额 / 节日红包：5000 ~ 50000 的整数 */
    amount = randInt(5000, 50000);
  }
  /* 小数点后最多保留两位 */
  return Math.round(Number(amount) * 100) / 100;
}

function taSendRedPacket(roleId) {
  const role = roleById(roleId);
  if (!role) return;
  const amount = generateTaTransferAmount();
  const blessing = composeCardText(roleId) || '一点心意，收下吧';
  const rec = {
    id: uid(), roleId, roleName: role.name,
    amount, blessing, count: 1, direction: 'in', status: 'pending', claimed: false,
    createTime: Date.now(), ts: Date.now()
  };
  state.redPackets.unshift(rec);
  chatOf(roleId).push({
    id: uid(), role: 'dream', sender: 'ta', type: 'redpacket', redPacketId: rec.id, direction: 'in',
    amount, blessing, count: 1, claimed: false, ts: Date.now(), read: false
  });
  persist();
  renderChatIf(roleId);
  if (currentRoute.page === 'sub' && currentRoute.name === 'wallet') renderWalletPage();
  showToast(taName(role.id) + ' 给你转来一笔转账');
}

function checkTaRedPackets() {
  if (!state) return;
  const now = Date.now();
  if (!state.nextTaRedPacketAt) {
    state.nextTaRedPacketAt = now + nextTaRedPacketDelay();
    persist();
    return;
  }
  if (now < state.nextTaRedPacketAt) return;
  state.nextTaRedPacketAt = now + nextTaRedPacketDelay();
  persist();
  if (Math.random() * 100 >= Number(state.settings.taRedPacketChance ?? 15)) return;
  const pool = state.roles.filter(r => chatOf(r.id).length > 0);
  if (!pool.length) return;
  const roleId = pickOne(pool).id;
  const delay = replyDelayMs();
  if (delay > 0) setTimeout(() => { if (roleById(roleId)) taSendRedPacket(roleId); }, delay);
  else taSendRedPacket(roleId);
}

/* =========================================================
 * 钱包
 * ========================================================= */
function walletBalance() {
  return Number(state.wallet && state.wallet.balance) || 0;
}
function walletTransactions() {
  return (state.wallet && Array.isArray(state.wallet.transactions)) ? state.wallet.transactions : [];
}
function money(v) {
  const n = Math.round((Number(v) || 0) * 100) / 100;
  return '¥' + n.toFixed(2);
}
/* 记一笔交易（不改余额，由调用方先扣/加） */
function walletLog(type, amount, title, note, role) {
  state.wallet.transactions.unshift({
    id: uid(), type, amount: Math.round(Number(amount) * 100) / 100,
    title: String(title || ''), note: String(note || ''),
    roleId: role ? role.id : '', roleName: role ? role.name : '',
    ts: Date.now()
  });
  if (state.wallet.transactions.length > 500) state.wallet.transactions.length = 500;
}
/* 支出：余额不足直接提示并中止操作 */
function walletSpend(amount, title, note, role) {
  const amt = Math.round(Number(amount) * 100) / 100;
  if (!(amt > 0)) return false;
  if (walletBalance() < amt) { showToast('钱包余额不足'); return false; }
  state.wallet.balance = Math.round((walletBalance() - amt) * 100) / 100;
  walletLog('out', amt, title, note, role);
  return true;
}
/* 收入 */
function walletEarn(amount, title, note, role) {
  const amt = Math.round(Number(amount) * 100) / 100;
  if (!(amt > 0)) return;
  state.wallet.balance = Math.round((walletBalance() + amt) * 100) / 100;
  walletLog('in', amt, title, note, role);
}

/* ===== 24小时未领取自动退回：转账与礼物 =====
   触发时机：boot（DOMContentLoaded）+ 每 15 秒轮询（与 checkTaRedPackets 等同组）。
   规则：我发出未领取 → 金额退回我的钱包并记一笔「退回」流水；TA 发来未领取 → 仅改状态不动钱包 */
const TX_EXPIRE_MS = 24 * 60 * 60 * 1000;
function checkExpiredTransactions() {
  if (!state) return;
  /* 外层兜底：本函数出现任何异常都不允许影响页面加载、渲染与点击绑定 */
  try {
    const now = Date.now();
    const touchedRoles = new Set();
    let returnedCount = 0, refundCount = 0;

    /* 把聊天里引用该记录的原卡片标记为已退回（不影响已接收的浅色补卡） */
    const markMsgsReturned = (roleId, idKey, recordId) => {
      const msgs = state.chats[roleId];
      if (!Array.isArray(msgs)) return;
      msgs.forEach(m => {
        if (m && m[idKey] === recordId && !m.receivedCard) { m.returned = true; m.read = true; }
      });
    };

    /* 时间戳严格容错：无有效 createTime/ts 的记录直接跳过，绝不参与运算 */
    const expiredAt = rec => {
      const t0 = rec && (Number(rec.createTime) || Number(rec.ts) || 0);
      if (!(t0 > 0)) return false;              /* createTime 缺失/非法 → 不算超时 */
      return (now - t0) > TX_EXPIRE_MS;
    };

    /* 转账：仅处理仍为待收款且超时的记录；单条异常跳过，不影响其它记录 */
    (Array.isArray(state.redPackets) ? state.redPackets : []).forEach(r => {
      try {
        if (!r || r.status !== 'pending') return;
        if (!expiredAt(r)) return;
        r.status = 'returned'; r.claimed = false; r.returnedAt = now;
        if (r.direction === 'out') {
          walletEarn(r.amount, '转账退回', r.blessing || '转账', roleById(r.roleId));
          refundCount++;
        }
        markMsgsReturned(r.roleId, 'redPacketId', r.id);
        touchedRoles.add(r.roleId);
        returnedCount++;
      } catch (err) { /* 单条数据异常：跳过 */ }
    });

    /* 礼物：未收下且超时的记录（status/claimed 双字段，任一已终态即跳过） */
    (Array.isArray(state.giftHistory) ? state.giftHistory : []).forEach(g => {
      try {
        if (!g || g.claimed === true || g.status === 'claimed' || g.status === 'returned') return;
        if (!expiredAt(g)) return;
        g.status = 'returned'; g.returnedAt = now;
        if (g.direction === 'out' && Number(g.price) > 0) {
          walletEarn(g.price, '礼物退回：' + g.giftName, '', roleById(g.roleId));
          refundCount++;
        }
        markMsgsReturned(g.roleId, 'giftRecordId', g.id);
        touchedRoles.add(g.roleId);
        returnedCount++;
      } catch (err) { /* 单条数据异常：跳过 */ }
    });

    if (!returnedCount) return;
    persist();
    /* 只做局部更新：相关聊天页重渲染 + 当前停留的钱包/礼物页重渲染，不触发全量 render */
    touchedRoles.forEach(rid => { try { renderChatIf(rid); } catch (err) { /* 忽略 */ } });
    if (currentRoute.page === 'sub' && currentRoute.name === 'wallet') renderWalletPage();
    if (currentRoute.page === 'sub' && currentRoute.name === 'gifts') renderGiftPage();
    showToast(refundCount > 0 ? '有转账/礼物超时未领取，已退回你的钱包' : '有一笔转账/礼物已超时退回');
  } catch (err) { /* 兜底：任何异常静默，保证 UI 与交互不受影响 */ }
}

function renderWalletPage() {
  const dn = taName();
  /* 合并资金流水：转账记录（state.redPackets，方向 in/out）+ 钱包收支（礼物扣款等）。
     「转账给 X」「来自 X 的转账」这类钱包流水与 redPackets 是同一笔钱的两个记录，
     此处跳过只保留 redPackets 一条，避免明细重复与统计翻倍。 */
  const flows = state.redPackets.map(r => ({
    kind: 'rp', id: r.id,
    direction: r.direction === 'in' ? 'in' : 'out',
    amount: Number(r.amount || 0),
    note: r.blessing || '',
    status: r.status === 'claimed' ? '已收款' : (r.status === 'returned' ? '已退回' : '待收款'),
    roleName: r.roleName || dn,
    ts: Number(r.ts || 0)
  })).concat(walletTransactions()
    .filter(t => !(t.title || '').includes('转账'))
    .map(t => ({
      kind: 'tx', id: t.id,
      direction: t.type === 'in' ? 'in' : 'out',
      amount: Number(t.amount || 0),
      note: t.title || (t.type === 'in' ? '收入' : '支出'),
      sub: t.note || '',
      status: t.type === 'in' ? '已到账' : '已支付',
      roleName: t.roleName || '',
      ts: Number(t.ts || 0)
    })))
    .sort((a, b) => b.ts - a.ts);
  const outTotal = flows.filter(f => f.direction === 'out').reduce((n, f) => n + f.amount, 0);
  const inTotal = flows.filter(f => f.direction === 'in').reduce((n, f) => n + f.amount, 0);
  const pending = flows.filter(f => f.kind === 'rp' && f.status === '待收款').length;

  subShell('钱包', `
    <div class="wallet-hero">
      <div class="wallet-label">当前余额</div>
      <div class="wallet-amount" id="walletBal">${money(walletBalance())}</div>
      <div class="wallet-actions">
        <button class="btn-sm" id="walletEdit">修改余额</button>
      </div>
    </div>
    <div class="panel">
      <div class="panel-title">收支统计</div>
      <div class="stat-grid">
        <div class="stat-cell"><div class="num" style="color:#FF3B30">${money(outTotal)}</div><div class="lbl">我转出/送出总额</div></div>
        <div class="stat-cell"><div class="num" style="color:#34C759">${money(inTotal)}</div><div class="lbl">${esc(dn)}转入/送入总额</div></div>
        <div class="stat-cell"><div class="num">${pending}</div><div class="lbl">待收款</div></div>
      </div>
      <div class="muted" style="font-size:12px;line-height:1.6;margin-top:8px">转账与送礼物都从钱包余额扣除，余额不足时操作会被中止；新产生的转账与礼物扣款会实时出现在下方明细里。</div>
    </div>
    <div class="panel">
      <div class="panel-title">交易明细</div>
      ${flows.length ? flows.map(f => {
        const incoming = f.direction === 'in';
        const title = f.kind === 'rp'
          ? (incoming ? esc(f.roleName) + ' 转给我' : '我转给 ' + esc(f.roleName))
          : esc(f.note || (incoming ? '收入' : '支出'));
        const sub = f.kind === 'rp' ? esc(f.note || '') : esc(f.sub || '');
        return `
        <div class="list-row" style="display:flex;align-items:center;gap:10px;padding:11px 2px">
          <div style="font-size:18px">${incoming ? '📥' : '📤'}</div>
          <div class="grow" style="min-width:0">
            <div style="font-size:13.5px;font-weight:600">${title}</div>
            ${sub ? `<div class="muted" style="font-size:11.5px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${sub}</div>` : ''}
            <div class="muted" style="font-size:11px;margin-top:2px">${fmtMsgTime(f.ts)}${f.roleName ? ' · ' + esc(f.roleName) : ''} · ${f.status}</div>
          </div>
          <div style="text-align:right;flex-shrink:0">
            <div style="font-size:14px;font-weight:600;color:${incoming ? '#34C759' : '#FF3B30'}">${incoming ? '+' : '-'}${money(f.amount).replace('¥', '')}</div>
            <button class="btn-sm" data-wdel="${f.kind}:${f.id}" style="margin-top:4px">删除</button>
          </div>
        </div>`;
      }).join('') : '<div class="empty-hint">还没有资金流水，转账、收转账或送礼物后会出现在这里</div>'}
    </div>`);

  $('#walletEdit').addEventListener('click', () => {
    showModal({
      title: '修改余额',
      body: `<div class="field"><label>当前余额（元）</label><input class="input" id="walletNewBal" type="number" min="0" step="0.01" value="${walletBalance()}"></div>
        <div class="muted" style="font-size:12px">直接调整余额，用于补早期数据；不会写入交易记录。</div>`,
      actions: [
        { label: '取消' },
        {
          label: '保存', kind: 'primary', onClick: el => {
            const v = parseFloat($('#walletNewBal', el).value);
            if (!Number.isFinite(v) || v < 0) { showToast('请输入有效余额'); return false; }
            state.wallet.balance = Math.round(v * 100) / 100;
            persist();
            renderWalletPage();
            showToast('余额已更新');
            return true;
          }
        }
      ]
    });
  });

  /* 删除单条流水：转账删 redPackets，礼物扣款等删 wallet.transactions；
     只删记录本身，不影响钱包余额与聊天里的转账卡片 */
  $$('[data-wdel]').forEach(btn => btn.addEventListener('click', async () => {
    const sep = btn.dataset.wdel.indexOf(':');
    const kind = btn.dataset.wdel.slice(0, sep);
    const id = btn.dataset.wdel.slice(sep + 1);
    const ok = await confirmDialog('删除流水记录', '删除后记录不可恢复（钱包余额与聊天里的转账卡片均不受影响）。', '删除', true);
    if (!ok) return;
    if (kind === 'rp') state.redPackets = state.redPackets.filter(r => r.id !== id);
    else state.wallet.transactions = walletTransactions().filter(t => t.id !== id);
    persist();
    renderWalletPage();
    showToast('已删除');
  }));
}

/* 旧【转账记录】页面已并入钱包（renderWalletPage 的交易明细区），数据结构 state.redPackets 保持不变 */

/* =========================================================
 * 十二·七、报备式记账
 * ========================================================= */
/* 解析记账语句：type 缺省为支出（兼容旧调用）
 * 支出：「买奶茶花了15」「打车花了32块」
 * 收入：「今天xxx收入了xxx块」「打工赚了200元」「发工资收入5000」 */
function parseLedgerText(text, type) {
  const t = String(text || '').trim();
  if (!t) return null;
  const income = type === 'income';
  const re = /(\d+(?:\.\d{1,2})?)\s*(元|块钱|块)?/g;
  let m, last = null;
  while ((m = re.exec(t))) { if (m[0].trim()) last = m; }
  if (!last) return null;
  const amount = parseFloat(last[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  let item = t.replace(re, '');
  item = item
    .replace(/今天|昨天|刚刚|刚才|今早|今晚|早上|中午|晚上|上午|下午/g, '')
    .replace(income
      ? /收入了|收入|赚到了|赚到|赚了|赚|挣了|挣|领到了|领到|领了|领|到账|入账|进账|收到|收了|收|发了|发/g
      : /花了|花|用了|用|买了|买|支付了|支付|付了|付|消费了|消费|支出|给/g, '')
    .replace(/[，,。.！!~～、\s]+/g, ' ')
    .trim();
  if (!item) item = income ? '其他收入' : '日常支出';
  return { amount, item, type: income ? 'income' : 'expense' };
}

/* 点【+】→【记账】：先选记支出还是记收入，再进输入框 */
function enterLedgerMode(roleId) {
  const role = roleById(roleId);
  if (!role) return;
  showModal({
    title: '记一笔账',
    body: `
      <div class="ledger-pick">
        <button data-ltype="expense">记支出<span class="lg-sub">花了多少</span></button>
        <button data-ltype="income">记收入<span class="lg-sub">进账多少</span></button>
      </div>`,
    actions: [{ label: '取消' }],
    onMount: (el, close) => {
      $$('[data-ltype]', el).forEach(btn => btn.addEventListener('click', () => {
        const type = btn.dataset.ltype;
        close();
        /* 等选择面板的关闭动画结束，再弹输入框 */
        setTimeout(() => enterLedgerInput(roleId, type), 200);
      }));
    }
  });
}

function enterLedgerInput(roleId, type) {
  const role = roleById(roleId);
  if (!role) return;
  const income = type === 'income';
  showModal({
    title: income ? '记一笔收入' : '记一笔支出',
    body: `
      <div class="field">
        <label>用一句话告诉我${income ? '你进账了什么' : '你花了什么'}</label>
        <input class="input" id="ledgerInput" placeholder="${income ? '例如：今天打工赚了200块' : '例如：今天买奶茶花了15'}">
      </div>
      <div class="muted" style="font-size:12px;line-height:1.7">${income
        ? '支持「发工资收入5000」「打工赚了200元」这类说法，金额与事项会自动解析。'
        : '支持「打车花了32块」「买书用了56元」这类说法，金额与事项会自动解析。'}</div>`,
    actions: [
      { label: '取消' },
      {
        label: '记下', kind: 'primary', onClick: el => {
          const raw = $('#ledgerInput', el).value.trim();
          const parsed = parseLedgerText(raw, type);
          if (!parsed) { showToast(income ? '没听出收入金额，换个说法试试～' : '没听懂这句话，换个说法试试～'); return false; }
          const rec = {
            id: uid(), roleId, roleName: role.name,
            item: parsed.item, amount: parsed.amount, type: parsed.type, note: raw, ts: Date.now()
          };
          state.ledger.unshift(rec);
          persist();
          const reply = `已帮你记下：${income ? '收入 +' : '支出 -'} ${parsed.item} ${parsed.amount.toFixed(2)} 元`;
          /* 记账回执 + 后面的字卡回复属于同一轮：共享同一组心声 */
          const ledgerTags = makeHeartTags();
          pushDreamMessage(roleId, { type: 'text', content: reply, heartTags: ledgerTags });
          /* 稍后追加字卡回复（按连发规则，每条独立延迟与正在输入） */
          setTimeout(() => {
            if (!roleById(roleId)) return;
            sendTaBurst(roleId, {
              heartTags: ledgerTags,
              makeText: prev => composeUniqueReply(roleId, prev),
              fallback: income ? '进账啦，辛苦啦' : '记下啦，别乱花钱哦'
            });
          }, 900);
          showToast(income ? '已记一笔收入' : '已记一笔支出');
          return true;
        }
      }
    ]
  });
  setTimeout(() => { const i = $('#ledgerInput'); if (i) i.focus({ preventScroll: true }); }, 80);
}

function renderLedgerPage() {
  const now = new Date();
  const list = state.ledger.slice().sort((a, b) => b.ts - a.ts);
  /* 旧记录没有 type 字段，一律按支出处理 */
  const typeOf = r => (r.type === 'income' ? 'income' : 'expense');
  const sumOf = rows => rows.reduce((n, r) => n + Number(r.amount || 0), 0);
  const incomeTotal = sumOf(list.filter(r => typeOf(r) === 'income'));
  const expenseTotal = sumOf(list.filter(r => typeOf(r) === 'expense'));
  const balance = Math.round((incomeTotal - expenseTotal) * 100) / 100;
  const dayExpense = sumOf(list.filter(r => typeOf(r) === 'expense' && isSameDay(r.ts, now.getTime())));
  const monthExpense = sumOf(list.filter(r => {
    const d = new Date(r.ts);
    return typeOf(r) === 'expense' && d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  }));

  subShell('记账本', `
    <div class="panel">
      <div class="panel-title">收支总览</div>
      <div class="stat-grid">
        <div class="stat-cell"><div class="num" style="color:#34C759">+¥${incomeTotal.toFixed(2)}</div><div class="lbl">总收入</div></div>
        <div class="stat-cell"><div class="num" style="color:#FF3B30">-¥${expenseTotal.toFixed(2)}</div><div class="lbl">总支出</div></div>
        <div class="stat-cell"><div class="num" style="color:${balance < 0 ? '#FF3B30' : '#34C759'}">${balance < 0 ? '-¥' : '¥'}${Math.abs(balance).toFixed(2)}</div><div class="lbl">总结余</div></div>
      </div>
      <div class="muted" style="font-size:12px;text-align:center;margin-top:8px">今日支出 ¥${dayExpense.toFixed(2)} · 本月支出 ¥${monthExpense.toFixed(2)}</div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn ghost" id="ledgerExport" style="flex:1">导出账本</button>
      </div>
    </div>
    <div class="panel">
      <div class="panel-title">记录</div>
      ${list.length ? list.map(r => {
        const t = typeOf(r);
        const income = t === 'income';
        return `
        <div class="list-row" style="display:flex;align-items:center;gap:10px;padding:11px 2px">
          <div class="grow" style="min-width:0">
            <div style="display:flex;align-items:center;gap:6px;font-size:14px;font-weight:600">
              <span class="ledger-tag ${t}">${income ? '收入' : '支出'}</span>
              <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.item || '')}</span>
            </div>
            <div class="muted" style="font-size:11px;margin-top:2px">${fmtMsgTime(r.ts)} · ${esc(r.roleName || taName())}</div>
          </div>
          <div style="font-size:15px;font-weight:600;color:${income ? '#34C759' : '#FF3B30'}">${income ? '+' : '-'}¥${Number(r.amount || 0).toFixed(2)}</div>
          <button class="btn-sm" data-ledit="${r.id}">编辑</button>
          <button class="btn-sm" data-ldel="${r.id}">删除</button>
        </div>`;
      }).join('') : '<div class="empty-hint">还没有记账，聊天页点 + 记一笔</div>'}
    </div>`, `<button class="btn-sm" id="ledgerExportTop">导出</button>`);

  const exportLedger = () => {
    downloadJSON({ appName: state.appName, exportedAt: Date.now(), ledger: state.ledger }, 'ledger-' + Date.now() + '.json');
  };
  const top = $('#ledgerExportTop');
  if (top) top.addEventListener('click', exportLedger);
  const btn = $('#ledgerExport');
  if (btn) btn.addEventListener('click', exportLedger);

  $$('[data-ldel]').forEach(b => b.addEventListener('click', async () => {
    const ok = await confirmDialog('删除记录', '确定删除这条记账记录吗？', '删除', true);
    if (!ok) return;
    state.ledger = state.ledger.filter(r => r.id !== b.dataset.ldel);
    persist();
    renderLedgerPage();
  }));
  $$('[data-ledit]').forEach(b => b.addEventListener('click', () => {
    const rec = state.ledger.find(r => r.id === b.dataset.ledit);
    if (!rec) return;
    const recIncome = (rec.type === 'income');
    showModal({
      title: '编辑记录',
      body: `
        <div class="field"><label>类型</label>
          <select class="select" id="leType">
            <option value="expense"${recIncome ? '' : ' selected'}>支出</option>
            <option value="income"${recIncome ? ' selected' : ''}>收入</option>
          </select>
        </div>
        <div class="field"><label>事项</label><input class="input" id="leItem" value="${esc(rec.item)}" maxlength="30"></div>
        <div class="field"><label>金额（元）</label><input class="input" id="leAmount" type="number" min="0.01" step="0.01" value="${rec.amount}"></div>
        <div class="field"><label>备注</label><input class="input" id="leNote" value="${esc(rec.note || '')}" maxlength="80"></div>`,
      actions: [
        { label: '取消' },
        {
          label: '保存', kind: 'primary', onClick: el => {
            const amount = Math.round((parseFloat($('#leAmount', el).value) || 0) * 100) / 100;
            if (!(amount > 0)) { showToast('金额不正确'); return false; }
            const type = $('#leType', el).value === 'income' ? 'income' : 'expense';
            rec.type = type;
            rec.item = $('#leItem', el).value.trim() || (type === 'income' ? '其他收入' : '日常支出');
            rec.amount = amount;
            rec.note = $('#leNote', el).value.trim();
            persist();
            renderLedgerPage();
            showToast('已保存');
            return true;
          }
        }
      ]
    });
  }));
}

/* =========================================================
 * 十二·八、纪念日
 * ========================================================= */
function openAnniversaryEditor(id) {
  const rec = id ? state.anniversaries.find(a => a.id === id) : null;
  const d = rec ? anniversaryDateOf(rec) : new Date();
  const dateVal = rec ? String(rec.date) : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  showModal({
    title: rec ? '编辑纪念日' : '新增纪念日',
    body: `
      <div class="field"><label>名称</label><input class="input" id="annName" value="${esc(rec ? rec.name : '')}" placeholder="例如：我们第一次说话" maxlength="30"></div>
      <div class="field"><label>日期</label><input class="input" id="annDate" type="date" value="${dateVal}"></div>
      <div class="field"><label>类型</label>
        <select class="select" id="annType">
          <option value="yearly"${!rec || rec.type !== 'once' ? ' selected' : ''}>每年</option>
          <option value="once"${rec && rec.type === 'once' ? ' selected' : ''}>一次性</option>
        </select>
      </div>
      <div class="field"><label>备注</label><input class="input" id="annNote" value="${esc(rec ? rec.note || '' : '')}" placeholder="可选" maxlength="60"></div>
      <div class="field"><label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:400;text-transform:none;letter-spacing:0"><input type="checkbox" id="annLove"${rec && rec.loveStart ? ' checked' : ''} style="width:18px;height:18px;flex-shrink:0"> 设为相恋起点<span class="muted" style="font-size:12px">（桌面「情侣空间」按此日期自动计天数，全局唯一）</span></label></div>`,
    actions: [
      { label: '取消' },
      {
        label: '保存', kind: 'primary', onClick: el => {
          const name = $('#annName', el).value.trim();
          const date = $('#annDate', el).value;
          if (!name) { showToast('请填写名称'); return false; }
          if (!date) { showToast('请选择日期'); return false; }
          const payload = { name, date, type: $('#annType', el).value === 'once' ? 'once' : 'yearly', note: $('#annNote', el).value.trim(), loveStart: $('#annLove', el).checked, ts: Date.now() };
          if (rec) Object.assign(rec, payload);
          else state.anniversaries.push(Object.assign({ id: uid() }, payload));
          /* 相恋起点全局唯一：本次设为起点时，清掉其它纪念日的标记 */
          if (payload.loveStart) {
            const keepId = rec ? rec.id : state.anniversaries[state.anniversaries.length - 1].id;
            state.anniversaries.forEach(a => { a.loveStart = a.id === keepId; });
          }
          persist();
          renderAnniversaryPage();
          renderHomePage();
          showToast(rec ? '已保存' : '纪念日已添加');
          return true;
        }
      }
    ]
  });
}

function renderAnniversaryPage() {
  const list = state.anniversaries.slice().sort((a, b) => {
    const da = anniversaryDateOf(a), db = anniversaryDateOf(b);
    return (da ? da.getTime() : 0) - (db ? db.getTime() : 0);
  });
  subShell('纪念日', `
    <div class="panel">
      <button class="btn primary block" id="annAdd">＋ 新增纪念日</button>
    </div>
    <div class="panel">
      <div class="panel-title">全部纪念日</div>
      ${list.length ? list.map(a => `
        <div class="list-row" style="display:flex;align-items:center;gap:10px;padding:11px 2px">
          <div style="font-size:20px">🎗</div>
          <div class="grow" style="min-width:0">
            <div style="font-size:14px;font-weight:600">${esc(a.name)}</div>
            <div class="muted" style="font-size:12px;margin-top:2px">${esc(String(a.date))} · ${a.type === 'once' ? '一次性' : '每年'}${a.note ? ' · ' + esc(a.note) : ''}</div>
            <div class="chip blue" style="margin-top:4px">${anniversaryDaysText(a)}</div>
            ${a.loveStart ? '<span class="chip" style="margin-top:4px;color:#FF3B30;background:rgba(255,59,48,.10)">❤️ 相恋起点</span>' : ''}
          </div>
          <button class="btn-sm" data-annedit="${a.id}">编辑</button>
          <button class="btn-sm" data-anndel="${a.id}">删除</button>
        </div>`).join('') : '<div class="empty-hint">还没有纪念日，添加一个吧</div>'}
    </div>`);
  $('#annAdd').addEventListener('click', () => openAnniversaryEditor(null));
  $$('[data-annedit]').forEach(b => b.addEventListener('click', () => openAnniversaryEditor(b.dataset.annedit)));
  $$('[data-anndel]').forEach(b => b.addEventListener('click', async () => {
    const ok = await confirmDialog('删除纪念日', '确定删除这个纪念日吗？', '删除', true);
    if (!ok) return;
    state.anniversaries = state.anniversaries.filter(a => a.id !== b.dataset.anndel);
    persist();
    renderAnniversaryPage();
    renderHomePage();
  }));
}

/* =========================================================
 * 十二·九、留影时刻
 * ========================================================= */
function snapshotItemsFrom(msgs) {
  /* 已撤回的消息不进入留影：原消息本体在撤回后不可再出现在任何地方 */
  return msgs.filter(m => !m.recalled && (m.role !== 'system' || m.type === 'call')).map(m => ({
    role: m.role,
    type: m.type || 'text',
    content: m.type === 'redpacket' ? (m.blessing || '') : (m.content || ''),
    image: m.image || '',
    ts: m.ts || Date.now()
  }));
}

function randomSnapshotItems(roleId) {
  const n = clamp(Number(state.settings.snapshotCount) || 5, 3, 20);
  const pool = chatOf(roleId).filter(m => m.role !== 'system').slice(-40);
  const picked = pickMany(pool, Math.min(n, pool.length)).sort((a, b) => a.ts - b.ts);
  return snapshotItemsFrom(picked);
}

function snapshotItemsOf(roleId) {
  return randomSnapshotItems(roleId);
}

function saveSnapshot(roleId, items, by) {
  const role = roleById(roleId);
  if (!role || !items || !items.length) return false;
  const rec = {
    id: uid(), roleId, roleName: role.name,
    items, ts: Date.now(), by: by === '我' ? '我' : 'TA'
  };
  state.snapshots.unshift(rec);
  if (state.snapshots.length > 300) state.snapshots.length = 300;
  persist();
  return true;
}

function takeSnapshot(roleId, auto) {
  const role = roleById(roleId);
  if (!role) return;
  const items = snapshotItemsOf(roleId);
  if (!items.length) {
    if (!auto) showToast('聊天记录太少，暂时无法留影');
    return;
  }
  saveSnapshot(roleId, items, auto ? 'TA' : '我');
  if (auto) {
    chatOf(roleId).push({
      id: uid(), role: 'system', type: 'tip',
      content: role.name + '截屏留存了这段对话', ts: Date.now(), read: true
    });
    persist();
    renderChatIf(roleId);
  } else {
    showToast('已留影这一刻');
  }
  if (currentRoute.page === 'sub' && currentRoute.name === 'snapshots') renderSnapshotsPage();
}

function nextAutoSnapshotDelay() {
  const m = clamp(Number(state.settings.autoSnapshotInterval) || 180, 30, 720);
  return m * 60 * 1000;
}

function checkAutoSnapshots() {
  if (!state) return;
  const now = Date.now();
  if (!state.nextAutoSnapshotAt) {
    state.nextAutoSnapshotAt = now + nextAutoSnapshotDelay();
    persist();
    return;
  }
  if (now < state.nextAutoSnapshotAt) return;
  state.nextAutoSnapshotAt = now + nextAutoSnapshotDelay();
  persist();
  if (!state.settings.autoSnapshotEnabled) return;
  if (Math.random() * 100 >= Number(state.settings.autoSnapshotChance ?? 20)) return;
  const pool = state.roles.filter(r => chatOf(r.id).length > 0);
  if (!pool.length) return;
  const role = pickOne(pool);
  const items = snapshotItemsOf(role.id);
  if (!items.length) return;
  saveSnapshot(role.id, items, 'TA');
  chatOf(role.id).push({
    id: uid(), role: 'system', type: 'tip',
    content: role.name + '截屏留存了这段对话', ts: Date.now(), read: true
  });
  persist();
  renderChatIf(role.id);
  if (currentRoute.page === 'sub' && currentRoute.name === 'snapshots') renderSnapshotsPage();
}

function snapshotHTML(rec, showFoot = true) {
  return `
    <div class="snapshot-card">
      <div class="snap-head">
        <div class="snap-title">${esc(rec.roleName)} · 留影</div>
        <div class="snap-time">${fmtMsgTime(rec.ts)}</div>
      </div>
      <div class="snap-body">
        ${rec.items.map(it => {
          if (it.type === 'sticker') return `<div class="snap-line ${it.role === 'user' ? 'me' : ''}"><span>[表情]</span></div>`;
          if (it.type === 'call') return `<div class="snap-line sys"><span>通话</span></div>`;
          const text = it.type === 'redpacket' ? '[转账] ' + (it.content || '') : (it.content || '');
          return `<div class="snap-line ${it.role === 'user' ? 'me' : 'ta'}"><span>${esc(text)}</span></div>`;
        }).join('')}
      </div>
      <div class="snap-by">截屏人：${rec.by === '我' ? '我' : esc(taName(rec.roleId))}</div>
      ${showFoot ? `<div class="snap-foot">
        <button class="btn-sm" data-snapview="${rec.id}">查看</button>
        <button class="btn-sm" data-snapexport="${rec.id}">导出</button>
        <button class="btn-sm" data-snapdel="${rec.id}">删除</button>
      </div>` : ''}
    </div>`;
}

/* 把留影卡片绘制成 PNG 图片的 DataURL（Canvas 绘制，不依赖 html2canvas） */
function snapshotToDataURL(rec) {
  try {
    const dpr = 2;
    const PAD = 28, GAP = 10, BODY_PAD = 16, BPAD_X = 18, BPAD_Y = 12;
    const W = 720;
    const BODY_W = W - PAD * 2;
    const BUBBLE_MAX = Math.round((BODY_W - BODY_PAD * 2) * 0.84);
    const FAMILY = '-apple-system,BlinkMacSystemFont,"SF Pro SC","PingFang SC","Helvetica Neue",Arial,sans-serif';
    const F_TITLE = `600 26px ${FAMILY}`;
    const F_TIME = `400 21px ${FAMILY}`;
    const F_BUBBLE = `400 24px ${FAMILY}`;
    const F_SYS = `400 21px ${FAMILY}`;
    const F_BY = `400 19px ${FAMILY}`;
    const primary = (getComputedStyle(document.documentElement).getPropertyValue('--primary') || '#007AFF').trim() || '#007AFF';

    /* 文本按字符宽度折行（兼容中英文混排） */
    const wrapText = (ctx, text, maxW) => {
      const out = [];
      let cur = '';
      Array.from(String(text == null ? '' : text)).forEach(ch => {
        if (ch === '\n') { out.push(cur); cur = ''; return; }
        const t = cur + ch;
        if (cur && ctx.measureText(t).width > maxW) { out.push(cur); cur = ch; }
        else cur = t;
      });
      out.push(cur);
      return out.length ? out : [''];
    };

    /* 规划每条消息：sys 居中灰字，me 右侧主题色气泡，ta 左侧白气泡 */
    const rows = (rec.items || []).map(it => {
      if (it.type === 'call') return { kind: 'sys', text: '通话' };
      if (it.type === 'sticker') return { kind: it.role === 'user' ? 'me' : 'ta', text: '[表情]' };
      const text = it.type === 'redpacket' ? '[转账] ' + (it.content || '') : (it.content || '');
      return { kind: it.role === 'user' ? 'me' : 'ta', text };
    });

    const meas = document.createElement('canvas').getContext('2d');
    meas.font = F_BUBBLE;
    rows.forEach(r => {
      if (r.kind === 'sys') {
        meas.font = F_SYS;
        r.lines = [r.text];
        r.w = Math.ceil(meas.measureText(r.text).width);
        r.h = 30;
      } else {
        meas.font = F_BUBBLE;
        r.lines = wrapText(meas, r.text, BUBBLE_MAX - BPAD_X * 2);
        r.w = Math.min(BUBBLE_MAX, Math.max.apply(null, r.lines.map(l => meas.measureText(l).width)) + BPAD_X * 2);
        r.w = Math.max(56, Math.ceil(r.w));
        r.h = r.lines.length * 36 + BPAD_Y * 2;
      }
    });

    const bodyH = BODY_PAD * 2 + rows.reduce((s, r) => s + r.h, 0) + GAP * Math.max(0, rows.length - 1);
    const HEAD_H = 32, BY_H = 24;
    const H = PAD + HEAD_H + 14 + bodyH + 10 + BY_H + PAD;

    const canvas = document.createElement('canvas');
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const rr = (x, y, w, h, r) => {
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
      else {
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
      }
    };

    /* 卡片底 */
    ctx.fillStyle = '#FFFFFF';
    rr(1, 1, W - 2, H - 2, 28); ctx.fill();
    ctx.strokeStyle = 'rgba(60,60,67,.12)'; ctx.lineWidth = 2;
    rr(1, 1, W - 2, H - 2, 28); ctx.stroke();

    /* 头部：标题 + 时间 */
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#3C3C43'; ctx.font = F_TITLE;
    ctx.textAlign = 'left';
    ctx.fillText(`${rec.roleName || ''} · 留影`, PAD, PAD + HEAD_H / 2);
    ctx.fillStyle = '#8E8E93'; ctx.font = F_TIME;
    ctx.textAlign = 'right';
    ctx.fillText(fmtMsgTime(rec.ts), W - PAD, PAD + HEAD_H / 2);

    /* 消息区 */
    const bodyY = PAD + HEAD_H + 14;
    ctx.fillStyle = '#F2F2F7';
    rr(PAD, bodyY, BODY_W, bodyH, 24); ctx.fill();

    let y = bodyY + BODY_PAD;
    rows.forEach(r => {
      if (r.kind === 'sys') {
        ctx.fillStyle = '#8E8E93'; ctx.font = F_SYS; ctx.textAlign = 'center';
        ctx.fillText(r.text, W / 2, y + r.h / 2);
      } else {
        const innerX = PAD + BODY_PAD;
        const innerW = BODY_W - BODY_PAD * 2;
        const x = r.kind === 'me' ? innerX + innerW - r.w : innerX;
        if (r.kind === 'me') { ctx.fillStyle = primary; } else { ctx.fillStyle = '#FFFFFF'; }
        rr(x, y, r.w, r.h, 18); ctx.fill();
        ctx.font = F_BUBBLE; ctx.textAlign = 'left';
        ctx.fillStyle = r.kind === 'me' ? '#FFFFFF' : '#1C1C1E';
        r.lines.forEach((line, i) => {
          ctx.fillText(line, x + BPAD_X, y + BPAD_Y + i * 36 + 18);
        });
      }
      y += r.h + GAP;
    });

    /* 截屏人 */
    ctx.fillStyle = '#8E8E93'; ctx.font = F_BY; ctx.textAlign = 'right';
    ctx.fillText(`截屏人：${rec.by === '我' ? '我' : taName(rec.roleId)}`, W - PAD, bodyY + bodyH + 10 + BY_H / 2);

    return canvas.toDataURL('image/png');
  } catch (e) {
    console.error('snapshot export failed', e);
    showToast('生成图片失败，请重试');
    return '';
  }
}

/* 留影图片全屏预览（Lightbox）：不直接触发下载，用户长按图片调起系统「存储图像」菜单。
 * 关键：图片节点不能带 pointer-events:none / -webkit-touch-callout:none，否则长按无反应。 */
function openSnapshotPreview(dataUrl) {
  if (!dataUrl) return;
  const box = document.createElement('div');
  box.className = 'snap-preview';
  box.innerHTML = `
    <button class="sp-close" aria-label="关闭">✕</button>
    <img class="sp-img" src="${dataUrl}" alt="留影">
    <div class="sp-tip">长按图片即可保存到手机相册</div>`;
  document.body.appendChild(box);
  const close = () => { box.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  box.querySelector('.sp-close').addEventListener('click', e => { e.stopPropagation(); close(); });
  /* 只有点击图片外的黑色空白区才关闭，点图片本身留给长按保存 */
  box.addEventListener('click', e => { if (e.target === box) close(); });
}

let snapFilterRole = '';
let snapFilterBy = '';

function renderSnapshotsPage() {
  subShell('留影时刻', `
    <div class="panel">
      <div class="panel-title">说明</div>
      <div class="muted" style="font-size:12px;line-height:1.7">在聊天页点「＋ → 留影」可勾选消息或随机选 ${clamp(Number(state.settings.snapshotCount) || 5, 3, 20)} 条，保存成一张留影卡片。${esc(taName())} 也可能自动截屏留存，可在「概率与行为」里调整。</div>
    </div>
    <div class="snap-filter">
      <select id="snapFilterRole" style="flex:1;padding:9px 10px;border-radius:10px;border:.5px solid rgba(60,60,67,.15);background:#fff;font-size:13px">
        <option value="">全部梦角</option>
        ${state.roles.map(r => `<option value="${r.id}" ${snapFilterRole === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}
      </select>
      <select id="snapFilterBy" style="padding:9px 10px;border-radius:10px;border:.5px solid rgba(60,60,67,.15);background:#fff;font-size:13px">
        <option value="">全部截图人</option>
        <option value="我" ${snapFilterBy === '我' ? 'selected' : ''}>我</option>
        <option value="TA" ${snapFilterBy === 'TA' ? 'selected' : ''}>${esc(taName())}</option>
      </select>
    </div>
    <div id="snapList">
      ${(() => {
        const list = state.snapshots
          .filter(s => !snapFilterRole || s.roleId === snapFilterRole)
          .filter(s => !snapFilterBy || (s.by === '我' ? '我' : 'TA') === snapFilterBy)
          .sort((a, b) => b.ts - a.ts);
        return list.length ? list.map(s => snapshotHTML(s)).join('') : '<div class="empty-hint">还没有留影，去聊天页截一张吧</div>';
      })()}
    </div>`, `<button class="btn-sm" id="snapExportAll">备份</button>`);

  const roleSel = $('#snapFilterRole');
  if (roleSel) roleSel.addEventListener('change', e => { snapFilterRole = e.target.value; renderSnapshotsPage(); });
  const bySel = $('#snapFilterBy');
  if (bySel) bySel.addEventListener('change', e => { snapFilterBy = e.target.value; renderSnapshotsPage(); });

  const top = $('#snapExportAll');
  if (top) top.addEventListener('click', () => {
    if (!state.snapshots.length) { showToast('还没有留影'); return; }
    downloadJSON({ appName: state.appName, exportedAt: Date.now(), snapshots: state.snapshots }, 'snapshots-' + Date.now() + '.json');
  });
  $$('[data-snapview]').forEach(b => b.addEventListener('click', () => {
    const rec = state.snapshots.find(s => s.id === b.dataset.snapview);
    if (!rec) return;
    showModal({ title: '留影 · ' + rec.roleName, body: snapshotHTML(rec, false), wide: true, actions: [{ label: '关闭', kind: 'primary' }] });
  }));
  $$('[data-snapexport]').forEach(b => b.addEventListener('click', () => {
    const rec = state.snapshots.find(s => s.id === b.dataset.snapexport);
    if (!rec) return;
    openSnapshotPreview(snapshotToDataURL(rec));
  }));
  $$('[data-snapdel]').forEach(b => b.addEventListener('click', async () => {
    const ok = await confirmDialog('删除留影', '确定删除这张留影卡片吗？', '删除', true);
    if (!ok) return;
    state.snapshots = state.snapshots.filter(s => s.id !== b.dataset.snapdel);
    persist();
    renderSnapshotsPage();
  }));
}

/* =========================================================
 * 十二·十、决策（抛硬币）
 * ========================================================= */
let coinResult = '';

function renderCoinPage() {
  const list = state.coinHistory.slice(0, 100);
  subShell('决策', `
    <div class="panel" style="text-align:center">
      <div class="panel-title" style="justify-content:center">抛硬币</div>
      <div class="coin-wrap"><div class="coin" id="coinEl">${coinResult || '？'}</div></div>
      <button class="btn primary block" id="coinBtn" style="margin-top:16px">抛硬币</button>
      <div class="muted" style="font-size:12px;margin-top:8px">交给运气，也是一种决定</div>
    </div>
    <div class="panel">
      <div class="panel-title row-between"><span>历史记录</span><button class="btn-sm" id="coinClear">清空</button></div>
      <div id="coinHistoryList">
        ${list.length ? list.map(h => `
          <div class="list-row" style="display:flex;align-items:center;gap:10px;padding:10px 2px">
            <div style="font-size:18px">${h.result === '正面' ? '🌕' : '🌑'}</div>
            <div class="grow" style="font-size:14px">${esc(h.result)}</div>
            <div class="muted" style="font-size:11px">${fmtMsgTime(h.ts)}</div>
          </div>`).join('') : '<div class="empty-hint">还没有抛过硬币</div>'}
      </div>
    </div>`);

  $('#coinBtn').addEventListener('click', () => {
    const el = $('#coinEl');
    const btn = $('#coinBtn');
    if (!el || el.classList.contains('flip')) return;
    btn.disabled = true;
    el.classList.add('flip');
    const result = Math.random() < .5 ? '正面' : '反面';
    setTimeout(() => {
      el.classList.remove('flip');
      el.textContent = result;
      coinResult = result;
      state.coinHistory.unshift({ id: uid(), result, ts: Date.now() });
      state.coinHistory = state.coinHistory.slice(0, 300);
      persist();
      showToast('结果：' + result);
      renderCoinPage();
    }, 950);
  });
  $('#coinClear').addEventListener('click', async () => {
    if (!state.coinHistory.length) return;
    const ok = await confirmDialog('清空历史', '确定清空所有抛硬币记录吗？', '清空', true);
    if (!ok) return;
    state.coinHistory = [];
    coinResult = '';
    persist();
    renderCoinPage();
    showToast('已清空');
  });
}

/* =========================================================
 * 十二·十一、链接测试
 * ========================================================= */
function linkLevelOf(correct, total) {
  if (!total) return '连接微弱';
  if (correct === total) return '灵魂共鸣';
  const pct = correct / total * 100;
  if (pct >= 80) return '默契十足';
  if (pct >= 60) return '心有灵犀';
  if (pct >= 40) return '还在靠近';
  return '连接微弱';
}

function linkStatusDesc(level) {
  return {
    '灵魂共鸣': '你们的答案几乎完全重合，像共享同一段心事。',
    '默契十足': '大部分问题都答对了，你们的连接很稳。',
    '心有灵犀': '有不少重合的地方，' + taName() + '在认真记住你。',
    '还在靠近': '有些地方还需要慢慢了解彼此。',
    '连接微弱': '别急，连接是可以一点点建立起来的。'
  }[level] || '';
}

/* 题库编辑器：我出题 + 若干选项（2~6 个）+ 唯一正确选项（radio 标记）。
 * 选项行可动态增删；保存时校验问题非空、选项≥2 且恰好一个正确答案。 */
function openLinkQuestionEditor(id) {
  const rec = id ? state.linkBank.find(q => q.id === id) : null;
  let options = rec ? rec.options.slice() : ['', ''];
  let correct = rec ? rec.correct : 0;
  const optRowHTML = (val, i) => `
    <div class="lk-opt" style="display:flex;align-items:center;gap:8px;margin-top:8px">
      <input type="radio" name="lkCorrect" ${i === correct ? 'checked' : ''} style="flex-shrink:0;width:17px;height:17px;accent-color:var(--primary)">
      <input class="input lk-opt-input" style="flex:1" value="${esc(val || '')}" placeholder="选项内容" maxlength="60">
      <button class="btn-sm lk-opt-del" style="flex-shrink:0">×</button>
    </div>`;
  showModal({
    title: rec ? '编辑题目' : '新增题目',
    body: `
      <div class="field"><label>问题</label><input class="input" id="lkQ" value="${esc(rec ? rec.q : '')}" placeholder="只有你们彼此才知道的问题" maxlength="80"></div>
      <div class="field"><label>选项（2~6 个，圆圈标记正确答案）</label>
        <div id="lkOpts">${options.map((o, i) => optRowHTML(o, i)).join('')}</div>
        <button class="btn ghost block" id="lkOptAdd" style="margin-top:8px">＋ 添加选项</button>
      </div>`,
    actions: [
      { label: '取消' },
      {
        label: '保存', kind: 'primary', onClick: el => {
          const q = $('#lkQ', el).value.trim();
          const rows = $$('.lk-opt', el);
          const opts = [];
          let corr = 0;
          rows.forEach((row, i) => {
            const v = $('.lk-opt-input', row).value.trim();
            if (!v) return;
            if ($('input[type=radio]', row).checked) corr = opts.length;
            opts.push(v);
          });
          if (!q) { showToast('请填写问题'); return false; }
          if (opts.length < 2) { showToast('至少需要 2 个选项'); return false; }
          if (rec) { rec.q = q; rec.options = opts; rec.correct = corr; }
          else state.linkBank.push({ id: uid(), q, options: opts, correct: corr, ts: Date.now() });
          persist();
          renderLinkTestPage();
          showToast('已保存');
          return true;
        }
      }
    ],
    onMount: el => {
      const wrap = $('#lkOpts', el);
      /* 统一重绑：按当前 DOM 顺序刷新 radio 选中态与删除按钮索引 */
      const rebind = () => {
        $$('.lk-opt', wrap).forEach((row, i) => {
          const radio = $('input[type=radio]', row);
          radio.name = 'lkCorrect';
          radio.checked = i === correct;
          radio.onchange = () => { correct = i; rebind(); };
          $('.lk-opt-del', row).onclick = () => {
            if ($$('.lk-opt', wrap).length <= 2) { showToast('至少保留 2 个选项'); return; }
            row.remove();
            if (correct === i) correct = 0;
            else if (correct > i) correct--;
            rebind();
          };
        });
      };
      $('#lkOptAdd', el).addEventListener('click', () => {
        if ($$('.lk-opt', wrap).length >= 6) { showToast('最多 6 个选项'); return; }
        wrap.insertAdjacentHTML('beforeend', optRowHTML('', -1));
        rebind();
      });
      rebind();
    }
  });
}

function stepModal(title, bodyHTML, label) {
  return new Promise(resolve => {
    showModal({
      title,
      body: bodyHTML,
      actions: [{ label: label || '继续', kind: 'primary', onClick: () => resolve(true) }]
    });
  });
}

/* TA 逐题作答：从该题选项中完全随机选一个（不做任何正确率偏向），
 * 选中项与正确选项一致即答对，最终按答对比例判定链接等级。
 * 旧题库选项不足 2 个时，从其他题的正确答案借干扰项补足；记录带 roleId 按梦角独立。 */
async function runLinkTest(roleId, count) {
  const role = roleById(roleId);
  if (!role) { showToast('请选择梦角'); return; }
  if (state.linkBank.length < count) { showToast('题目不够，请先添加题目'); return; }
  const qs = pickMany(state.linkBank, count);
  const details = [];
  const startBtn = $('#lkStart');
  if (startBtn) { startBtn.disabled = true; startBtn.textContent = `正在测试 ${role.name}…`; }
  for (let qi = 0; qi < qs.length; qi++) {
    const q = qs[qi];
    const disp = q.options.slice();
    if (disp.length < 2) {
      const pool = [];
      state.linkBank.forEach(x => (x.options || []).forEach(o => {
        if (o && !disp.includes(o) && !pool.includes(o)) pool.push(o);
      }));
      while (disp.length < 2) disp.push(pool.length ? pool.shift() : '保密，先不告诉你');
    }
    const correctText = disp[q.correct] != null ? disp[q.correct] : disp[0];
    /* 打乱选项顺序，重新定位正确项下标 */
    for (let i = disp.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = disp[i]; disp[i] = disp[j]; disp[j] = tmp;
    }
    const correctIdx = Math.max(0, disp.indexOf(correctText));
    /* TA 的选择：均匀随机，概率 1/选项数，不受任何设置影响 */
    const taIdx = Math.floor(Math.random() * disp.length);
    const ok = taIdx === correctIdx;
    details.push({ q: q.q, options: disp, correct: correctIdx, ta: taIdx, ok });
    await stepModal(`链接测试 · 正在测试 ${role.name}（${qi + 1}/${qs.length}）`, `
      <div style="font-size:15px;font-weight:600;line-height:1.5">${esc(q.q)}</div>
      <div style="margin-top:10px;display:flex;flex-direction:column;gap:6px">
        ${disp.map((o, i) => `
          <div style="font-size:13px;padding:7px 10px;border-radius:9px;${i === taIdx ? 'background:rgba(var(--primary-rgb),.1);border:1px solid rgba(var(--primary-rgb),.4);' : 'background:rgba(120,120,128,.08);'}">
            ${'ABCDEF'.charAt(i)}. ${esc(o)} ${i === taIdx ? '👈 ' + esc(taName()) + '的选择' : ''}
          </div>`).join('')}
      </div>
      <div class="muted" style="margin-top:8px;font-size:12px">正确选项：${'ABCDEF'.charAt(correctIdx)}. ${esc(disp[correctIdx])}</div>`);
  }
  const correct = details.filter(d => d.ok).length;
  const total = details.length;
  const level = linkLevelOf(correct, total);
  const rec = {
    id: uid(), roleId, roleName: role.name, ts: Date.now(),
    total, correct, level, details
  };
  state.linkTests.unshift(rec);
  if (state.linkTests.length > 100) state.linkTests.length = 100;
  persist();
  /* 结果按回复时间参数延迟出现，与其他 TA 消息一致 */
  const resultDelay = replyDelayMs();
  if (resultDelay > 0) await new Promise(r => setTimeout(r, resultDelay));
  showModal({
    title: '链接测试结果',
    body: `
      <div style="text-align:center;padding:6px 0 10px">
        <div style="font-size:34px;font-weight:700;color:var(--primary)">${correct}/${total}</div>
        <div style="font-size:17px;font-weight:600;margin-top:6px">${esc(level)}</div>
        <div class="muted" style="font-size:12px;line-height:1.7;margin-top:8px">${esc(linkStatusDesc(level))}</div>
      </div>
      ${details.map((d, i) => `
        <div style="font-size:12px;line-height:1.7;padding:8px 0;border-top:.5px solid rgba(60,60,67,.14)">
          <div style="font-weight:600">${i + 1}. ${esc(d.q)}</div>
          <div style="color:${d.ok ? '#34C759' : '#FF3B30'}">${esc(taName())}选择了：${esc(d.options[d.ta])} ${d.ok ? '✅' : '❌'}</div>
          ${d.ok ? '' : `<div class="muted">正确选项：${esc(d.options[d.correct])}</div>`}
        </div>`).join('')}`,
    wide: true,
    actions: [{ label: '完成', kind: 'primary' }]
  });
  if (currentRoute.page === 'sub' && currentRoute.name === 'linktest') renderLinkTestPage();
}

/* 历史记录查看范围：false=只看当前梦角，true=全部梦角（切换梦角时重置） */
let linkShowAll = false;

/* 记录详情的兼容读取：新格式 options+correct/ta 下标，旧格式 a/ta 文本 */
function linkDetailTexts(d) {
  if (d && Array.isArray(d.options) && d.options.length) {
    return {
      correct: d.options[d.correct] != null ? d.options[d.correct] : '',
      ta: d.options[d.ta] != null ? d.options[d.ta] : ''
    };
  }
  return {
    correct: String((d && (d.correctText || d.a)) || ''),
    ta: String((d && (typeof d.ta === 'string' ? d.ta : d.taText)) || '')
  };
}

function renderLinkTestPage() {
  let role = roleById(state.linkRoleId) || state.roles[0];
  if (!role) { subShell('链接测试', '<div class="list-tip">还没有梦角，先去联系人页添加一位吧。</div>'); return; }
  if (role.id !== state.linkRoleId) { state.linkRoleId = role.id; persist(); }
  const latest = state.linkTests.find(t => t.roleId === role.id);
  const tests = state.linkTests.filter(t => linkShowAll || t.roleId === role.id).slice(0, 50);

  subShell('链接测试', `
    ${roleStripHTML(role.id)}
    <div class="panel">
      <div class="panel-title">与 ${esc(role.name)} 的连接</div>
      ${latest ? `
        <div style="display:flex;align-items:center;gap:12px;padding:2px 2px 8px">
          <div style="font-size:26px;font-weight:700;color:var(--primary)">${latest.correct}/${latest.total}</div>
          <div class="grow" style="min-width:0">
            <div style="font-size:14px;font-weight:600">${esc(latest.level)}</div>
            <div class="muted" style="font-size:11.5px;line-height:1.5;margin-top:2px">${esc(linkStatusDesc(latest.level))}</div>
          </div>
        </div>` : '<div class="empty-hint">还没有和' + esc(taName(role.id)) + '测试过，添加题目后开始一次链接测试吧</div>'}
    </div>
    <div class="panel">
      <div class="panel-title">题库管理（全局共用）</div>
      <div class="btn-row">
        <button class="btn primary" id="lkAdd" style="flex:1">＋ 新增题目</button>
        <button class="btn ghost" id="lkImport" style="flex:1">批量导入</button>
      </div>
      <div style="margin-top:8px">
        ${state.linkBank.length ? state.linkBank.map(q => `
          <div class="list-row" style="display:flex;align-items:center;gap:8px;padding:10px 2px">
            <div class="grow" style="min-width:0">
              <div style="font-size:13px;font-weight:600">${esc(q.q)}</div>
              <div class="muted" style="font-size:12px;margin-top:2px">${(q.options || []).map((o, i) => `${i === q.correct ? '✓' : '·'} ${esc(o)}`).join('　')}</div>
            </div>
            <button class="btn-sm" data-lkqedit="${q.id}">编辑</button>
            <button class="btn-sm" data-lkqdel="${q.id}">删除</button>
          </div>`).join('') : '<div class="empty-hint">题库还是空的，先添加几个只有你们知道的题目</div>'}
      </div>
    </div>
    <div class="panel">
      <div class="panel-title">开始测试</div>
      <div class="field"><label>题量</label>
        <select class="select" id="lkCount">
          ${[3, 5, 8, 10].map(n => `<option value="${n}"${n === 5 ? ' selected' : ''}>${n} 题</option>`).join('')}
        </select>
      </div>
      <button class="btn primary block" id="lkStart">开始测试 ${esc(role.name)}</button>
      <div class="muted" style="font-size:11px;margin-top:6px;line-height:1.6">${esc(taName(role.id))} 会逐题在你的选项里完全随机作答，答对比例越高，链接越稳固。</div>
    </div>
    <div class="panel">
      <div class="panel-title" style="display:flex;align-items:center;justify-content:space-between">
        <span>历史测试</span>
        <button class="btn-sm" id="lkScope">${linkShowAll ? '全部梦角 ▾' : '仅当前梦角 ▾'}</button>
      </div>
      ${tests.length ? tests.map(t => `
        <div class="list-row" style="display:flex;align-items:center;gap:8px;padding:10px 2px">
          <div class="grow" style="min-width:0">
            <div style="font-size:13px;font-weight:600">${esc(t.roleName)} · ${esc(t.level)}</div>
            <div class="muted" style="font-size:11px;margin-top:2px">${t.correct}/${t.total} 题 · ${fmtMsgTime(t.ts)}</div>
          </div>
          <button class="btn-sm" data-lkview="${t.id}">查看</button>
          <button class="btn-sm" data-lkdel="${t.id}">删除</button>
        </div>`).join('') : `<div class="empty-hint">${linkShowAll ? '还没有任何测试记录' : esc(taName(role.id)) + ' 还没有测试记录'}</div>`}
    </div>`);

  $$('.role-strip [data-rspick]').forEach(btn => btn.addEventListener('click', () => {
    if (btn.dataset.rspick === state.linkRoleId) return;
    state.linkRoleId = btn.dataset.rspick;
    linkShowAll = false;
    persist();
    renderLinkTestPage();
  }));
  $('#lkScope').addEventListener('click', () => {
    linkShowAll = !linkShowAll;
    renderLinkTestPage();
  });

  $('#lkAdd').addEventListener('click', () => openLinkQuestionEditor(null));
  $('#lkImport').addEventListener('click', () => {
    showModal({
      title: '批量导入题库',
      body: `
        <div class="field"><label>每行一题，格式：问题|正确选项|其他选项…（至少一个选项）</label>
          <textarea class="textarea" id="lkImportText" rows="6" placeholder="我最喜欢的颜色|蓝色|红色|绿色&#10;我睡前会做什么|听歌|看书|刷视频"></textarea>
        </div>`,
      actions: [
        { label: '取消' },
        {
          label: '导入', kind: 'primary', onClick: el => {
            const lines = $('#lkImportText', el).value.split('\n').map(s => s.trim()).filter(Boolean);
            let added = 0;
            lines.forEach(line => {
              const parts = line.split('|').map(s => s.trim()).filter(Boolean);
              if (parts.length < 2) return;
              state.linkBank.push({ id: uid(), q: parts[0], options: parts.slice(1), correct: 0, ts: Date.now() });
              added++;
            });
            if (!added) { showToast('没有可导入的内容，检查格式'); return false; }
            persist();
            renderLinkTestPage();
            showToast('已导入 ' + added + ' 题');
            return true;
          }
        }
      ]
    });
  });
  $$('[data-lkqedit]').forEach(b => b.addEventListener('click', () => openLinkQuestionEditor(b.dataset.lkqedit)));
  $$('[data-lkqdel]').forEach(b => b.addEventListener('click', async () => {
    const ok = await confirmDialog('删除题目', '确定删除这道题目吗？', '删除', true);
    if (!ok) return;
    state.linkBank = state.linkBank.filter(q => q.id !== b.dataset.lkqdel);
    persist();
    renderLinkTestPage();
  }));
  $('#lkStart').addEventListener('click', () => {
    const count = parseInt($('#lkCount').value, 10) || 5;
    runLinkTest(role.id, count);
  });
  $$('[data-lkview]').forEach(b => b.addEventListener('click', () => {
    const t = state.linkTests.find(x => x.id === b.dataset.lkview);
    if (!t) return;
    showModal({
      title: '测试 · ' + t.roleName,
      body: `
        <div style="text-align:center;padding:4px 0 10px">
          <div style="font-size:26px;font-weight:700;color:var(--primary)">${t.correct}/${t.total}</div>
          <div style="font-size:15px;font-weight:600;margin-top:4px">${esc(t.level)}</div>
        </div>
        ${(t.details || []).map((d, i) => {
          const tx = linkDetailTexts(d);
          return `
          <div style="font-size:12px;line-height:1.7;padding:8px 0;border-top:.5px solid rgba(60,60,67,.14)">
            <div style="font-weight:600">${i + 1}. ${esc(d.q)}</div>
            <div style="color:${d.ok ? '#34C759' : '#FF3B30'}">${esc(taName())}选择了：${esc(tx.ta)} ${d.ok ? '✅' : '❌'}</div>
            ${d.ok ? '' : `<div class="muted">正确选项：${esc(tx.correct)}</div>`}
          </div>`;
        }).join('')}`,
      wide: true,
      actions: [{ label: '关闭', kind: 'primary' }]
    });
  }));
  $$('[data-lkdel]').forEach(b => b.addEventListener('click', async () => {
    const ok = await confirmDialog('删除记录', '确定删除这条测试记录吗？', '删除', true);
    if (!ok) return;
    state.linkTests = state.linkTests.filter(x => x.id !== b.dataset.lkdel);
    persist();
    renderLinkTestPage();
  }));
}

/* =========================================================
 * 十二·十二、送礼物
 * ========================================================= */
function openGiftEditor(id) {
  const rec = id ? state.gifts.find(g => g.id === id) : null;
  showModal({
    title: rec ? '编辑礼物' : '新增礼物',
    body: `
      <div class="field"><label>礼物名称</label><input class="input" id="giftName" value="${esc(rec ? rec.name : '')}" placeholder="例如：一杯热奶茶" maxlength="20"></div>
      <div class="field"><label>图标 emoji</label><input class="input" id="giftEmoji" value="${esc(rec ? rec.emoji : '🎁')}" placeholder="🎁" maxlength="4"></div>
      <div class="field"><label>价格（元，0 为免费）</label><input class="input" id="giftPrice" type="number" min="0" max="99999" step="0.01" value="${rec ? (Number(rec.price) || 0) : 20}"></div>`,
    actions: [
      { label: '取消' },
      {
        label: '保存', kind: 'primary', onClick: el => {
          const name = $('#giftName', el).value.trim();
          const emoji = $('#giftEmoji', el).value.trim() || '🎁';
          const price = clamp(Number(parseFloat($('#giftPrice', el).value)) || 0, 0, 99999);
          if (!name) { showToast('请填写礼物名称'); return false; }
          if (rec) Object.assign(rec, { name, emoji, price: Math.round(price * 100) / 100 });
          else state.gifts.push({ id: uid(), name, emoji, price: Math.round(price * 100) / 100, ts: Date.now() });
          persist();
          renderGiftPage();
          showToast('已保存');
          return true;
        }
      }
    ]
  });
}

function sendGift(roleId, giftId, note) {
  const role = roleById(roleId);
  const gift = state.gifts.find(g => g.id === giftId);
  if (!role || !gift) { showToast('请选择梦角和礼物'); return; }
  /* 送礼物先从钱包扣款，余额不足则中止；0 元礼物视为免费不扣款 */
  const price = Math.max(0, Math.round((Number(gift.price) || 0) * 100) / 100);
  if (price > 0 && !walletSpend(price, '送礼物：' + gift.name, '', role)) {
    showToast('钱包余额不足，送礼物失败');
    return;
  }
  const rec = {
    id: uid(), roleId, roleName: role.name,
    giftName: gift.name, emoji: gift.emoji || '🎁', price,
    direction: 'out', status: 'pending', claimed: false, note: String(note || ''),
    createTime: Date.now(), ts: Date.now()
  };
  state.giftHistory.unshift(rec);
  if (state.giftHistory.length > 300) state.giftHistory.length = 300;
  /* 我送出的礼物先生成深色送出卡片（待 TA 收下） */
  const msg = {
    id: uid(), role: 'user', sender: 'user', type: 'gift', giftRecordId: rec.id,
    giftName: rec.giftName, emoji: rec.emoji, price, note: rec.note,
    direction: 'out', claimed: false, ts: rec.ts, read: true
  };
  chatOf(roleId).push(msg);
  persist();
  renderChatIf(roleId);
  if (currentRoute.page === 'sub' && currentRoute.name === 'gifts') renderGiftPage();

  /* TA 稍后收下：卡片变浅色，再按连发规则从字卡库回感谢语 */
  setTimeout(() => {
    if (!roleById(roleId)) return;
    msg.claimed = true;
    const r = state.giftHistory.find(g => g.id === rec.id);
    if (r) { r.claimed = true; r.claimedAt = Date.now(); r.status = 'claimed'; }
    /* 第二步：TA 在 TA 那一侧新增一张浅色已收下卡片 */
    pushReceivedCard(roleId, 'gift', rec.id, 'ta', {
      giftName: rec.giftName, emoji: rec.emoji, price: rec.price, note: rec.note
    });
    persist();
    renderChatIf(roleId);
    if (currentRoute.page === 'sub' && currentRoute.name === 'gifts') renderGiftPage();
    sendTaBurst(roleId, {
      makeText: prev => composeUniqueReply(roleId, prev),
      fallback: '谢谢你，我很喜欢这份礼物。'
    });
  }, randInt(1400, 3200));

  showToast('已送出 ' + rec.emoji + ' ' + gift.name);
}

/* TA 主动送礼：固定间隔 4~8 小时判定一次 */
function nextTaGiftDelay() {
  return randInt(240, 480) * 60 * 1000;
}

/* ===== TA 内置私藏礼物库（纯实体 / 购买类，与自创词库区分开） =====
 * TA 主动送礼采用双轨制：50% 从这里抽一件实体礼物，50% 走自创拼接逻辑；
 * 两条轨道都不扣用户钱包，价格恒为 0 */
const builtInGifts = [
  { name: "一束红玫瑰", emoji: "🌹" }, { name: "一杯热奶茶", emoji: "🧋" },
  { name: "一盒巧克力", emoji: "🍫" }, { name: "一条纯银项链", emoji: "📿" },
  { name: "一个毛绒小熊", emoji: "🧸" }, { name: "一盒精美糖果", emoji: "🍬" },
  { name: "一台拍立得", emoji: "📸" }, { name: "一块草莓蛋糕", emoji: "🍰" },
  { name: "两张电影票", emoji: "🎟️" }, { name: "一杯热美式", emoji: "☕" },
  { name: "一条羊绒围巾", emoji: "🧣" }, { name: "一顿烛光晚餐", emoji: "🍱" },
  { name: "一枚戒指", emoji: "💍" }, { name: "一副降噪耳机", emoji: "🎧" },
  { name: "一个精美盲盒", emoji: "🎁" }, { name: "一束彩色气球", emoji: "🎈" },
  { name: "一张游乐园门票", emoji: "🎫" }, { name: "一瓶香水", emoji: "🧴" },
  { name: "一本装帧精美的书", emoji: "📖" }, { name: "一盒乐高积木", emoji: "🧱" }
];

/* ===== TA 自创礼物词库（通用，任何梦角人设都能代入） ===== */
const customGiftPrefix = ["亲手折的", "特意为你定制的", "攒了很久买的", "藏在口袋里带过来的", "熬夜为你做的", "逛街时一眼看中的", "偷偷捡回来的", "从很远的远方带回来的", "用体温焐热的", "路边摘的", "自己录制的", "不好意思拿出手的", "准备了很久的", "下雨天捡到的", "用心写的", "小心翼翼包好的", "跑了好远去买的", "一直收藏着的", "悄悄塞进你包里的", "第一次做给你的"];
const customGiftItems = [
  { name: "一朵路边的小花", emoji: "🌸" }, { name: "手写情书", emoji: "💌" },
  { name: "平安符", emoji: "🧿" }, { name: "千纸鹤", emoji: "🕊️" },
  { name: "折纸小星星", emoji: "⭐" }, { name: "一片秋天的落叶", emoji: "🍂" },
  { name: "一个紧紧的拥抱", emoji: "🫂" }, { name: "一个晚安吻", emoji: "💋" },
  { name: "他的外套", emoji: "🧥" }, { name: "他随身的围巾", emoji: "🧣" },
  { name: "一枚许愿硬币", emoji: "🪙" }, { name: "满天星辰", emoji: "🌌" },
  { name: "他唱的一首歌", emoji: "🎵" }, { name: "一段专属录音", emoji: "🎙️" },
  { name: "一个永远有效的承诺", emoji: "🤙" }, { name: "他的一缕发丝", emoji: "🪮" },
  { name: "他的钥匙扣", emoji: "🔑" }, { name: "一本写满你的日记", emoji: "📔" },
  { name: "一片红色的枫叶", emoji: "🍁" }, { name: "一根月老红线", emoji: "🧵" },
  { name: "他的护身符", emoji: "📿" }, { name: "一个专属树洞", emoji: "🌳" },
  { name: "陪你的一整天", emoji: "🌞" }, { name: "他珍贵的徽章", emoji: "🎖️" },
  { name: "一张写满字的便利贴", emoji: "📝" }, { name: "一场专属烟花", emoji: "🎆" },
  { name: "他的一个背影", emoji: "🚶" }, { name: "一根他的皮筋", emoji: "🎀" }
];
/* 从词库随机拼接，返回 { name, emoji } */
function generateCustomGift() {
  const prefix = pickOne(customGiftPrefix);
  const item = pickOne(customGiftItems);
  return { name: prefix + ' ' + item.name, emoji: item.emoji };
}

function taSendGift(roleId) {
  const role = roleById(roleId);
  if (!role) return;

  /* 双轨制：随机数 < 0.5 送内置私藏礼物，>= 0.5 送自创专属礼物，各占 50%；
   * 两条轨道价格恒为 0，TA 送礼不涉及用户钱包扣款 */
  const useCustom = Math.random() >= 0.5;
  let giftName, emoji, isCustom;
  if (useCustom) {
    const cg = generateCustomGift();
    giftName = cg.name;
    emoji = cg.emoji;
    isCustom = true;
  } else {
    const gift = pickOne(builtInGifts);
    if (!gift) return;
    giftName = gift.name;
    emoji = gift.emoji || '🎁';
    isCustom = false;
  }
  const price = 0;   /* 无论内置还是自创，都不扣用户钱包 */

  const rec = {
    id: uid(), roleId, roleName: role.name,
    giftName, emoji, price,
    direction: 'in', status: 'pending', claimed: false, note: '',
    createTime: Date.now(), ts: Date.now(),
    isCustom                          /* 标记是否为 TA 自创礼物 */
  };
  state.giftHistory.unshift(rec);
  if (state.giftHistory.length > 300) state.giftHistory.length = 300;
  persist();
  /* 礼物 + 两句话属于同一轮连发：心声只抽一次，三条消息共用 */
  const giftTags = makeHeartTags();
  /* 第一张：礼物卡片（名称 + Emoji），样式与普通礼物完全一致 */
  pushDreamMessage(roleId, {
    sender: 'ta', type: 'gift', giftRecordId: rec.id, giftName,
    emoji, price, note: '', direction: 'in', claimed: false, heartTags: giftTags
  });
  showToast(taName(role.id) + ' 送了你一份礼物');
  if (currentRoute.page === 'sub' && currentRoute.name === 'gifts') renderGiftPage();

  /* 第二条：文本气泡（自创 / 内置各有一套文案） */
  const secondLine = isCustom
    ? pickOne(['这是我自己做的，希望你喜欢。', '没花钱，但是心意是真的。'])
    : pickOne(['路过看到，觉得很适合你。', '知道你喜欢这个，就买啦。']);
  setTimeout(() => {
    if (!roleById(roleId)) return;
    pushDreamMessage(roleId, { sender: 'ta', type: 'text', content: secondLine, heartTags: giftTags });

    /* 第三条：约 1 秒后，从主字卡库随机抽一句感谢语 */
    setTimeout(() => {
      if (!roleById(roleId)) return;
      const thanks = composeUniqueReply(roleId, '') || '谢谢你收下。';
      pushDreamMessage(roleId, { sender: 'ta', type: 'text', content: thanks, heartTags: giftTags });
    }, 1000);
  }, 400);
}

/* 我收下 TA 送来的礼物：卡片变浅色，状态更新为已收下 */
function claimGift(roleId, msgId) {
  const msgs = chatOf(roleId);
  const msg = msgs.find(m => m.id === msgId);
  /* 已退回的卡片不可再收下 */
  if (!msg || msg.type !== 'gift' || msg.direction !== 'in' || msg.claimed || msg.returned) return;
  msg.claimed = true;
  msg.read = true;
  const rec = state.giftHistory.find(g => g.id === msg.giftRecordId);
  if (rec) {
    if (rec.status === 'returned') return;
    rec.claimed = true; rec.claimedAt = Date.now(); rec.status = 'claimed';
  }
  /* 第二步：我在我那一侧新增一张浅色已收下卡片；原卡片留在 TA 一侧并已变浅 */
  pushReceivedCard(roleId, 'gift', msg.giftRecordId, 'user', {
    giftName: msg.giftName, emoji: msg.emoji, price: msg.price, note: msg.note
  });
  persist();
  renderChatIf(roleId);
  if (currentRoute.page === 'sub' && currentRoute.name === 'gifts') renderGiftPage();
  showToast('已收下 ' + (msg.giftName || '礼物'));
}

function checkTaGifts() {
  if (!state) return;
  const now = Date.now();
  if (!state.nextTaGiftAt) {
    state.nextTaGiftAt = now + nextTaGiftDelay();
    persist();
    return;
  }
  if (now < state.nextTaGiftAt) return;
  state.nextTaGiftAt = now + nextTaGiftDelay();
  persist();
  if (Math.random() * 100 >= Number(state.settings.taGiftChance ?? 20)) return;
  if (!state.roles.length) return;
  taSendGift(pickOne(state.roles).id);
}

function renderGiftPage() {
  const dn = taName();
  const outCount = state.giftHistory.filter(g => g.direction !== 'in').length;
  const inCount = state.giftHistory.filter(g => g.direction === 'in').length;
  const roles = state.roles;
  subShell('送礼物', `
    <div class="panel">
      <div class="panel-title">统计</div>
      <div class="stat-grid">
        <div class="stat-cell"><div class="num">${outCount}</div><div class="lbl">我送次数</div></div>
        <div class="stat-cell"><div class="num">${inCount}</div><div class="lbl">${esc(dn)}送次数</div></div>
      </div>
      <div class="muted" style="font-size:12px;margin-top:8px">${esc(dn)} 也会按概率主动送你礼物，可在「概率与行为」里调整。</div>
    </div>
    <div class="panel">
      <div class="panel-title">送出礼物</div>
      <div class="field"><label>选择梦角</label>
        <select class="select" id="giftRole">${roles.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select>
      </div>
      <div class="field"><label>选择礼物</label>
        <select class="select" id="giftPick">${state.gifts.map(g => `<option value="${g.id}">${esc(g.emoji + ' ' + g.name)}</option>`).join('')}</select>
      </div>
      <button class="btn primary block" id="giftSend">送出</button>
    </div>
    <div class="panel">
      <div class="panel-title row-between"><span>礼物列表</span><button class="btn-sm" id="giftAdd">新增</button></div>
      ${state.gifts.length ? state.gifts.map(g => `
        <div class="list-row" style="display:flex;align-items:center;gap:10px;padding:10px 2px">
          <div style="font-size:22px">${esc(g.emoji)}</div>
          <div class="grow" style="min-width:0">
            <div style="font-size:14px;font-weight:600">${esc(g.name)}</div>
            <div class="muted" style="font-size:11px;margin-top:2px">${Number(g.price) > 0 ? money(g.price) : '免费'}</div>
          </div>
          <button class="btn-sm" data-giftedit="${g.id}">编辑</button>
          <button class="btn-sm" data-giftdel="${g.id}">删除</button>
        </div>`).join('') : '<div class="empty-hint">还没有礼物，先新增一个吧</div>'}
    </div>
    <div class="panel">
      <div class="panel-title">送礼历史</div>
      ${state.giftHistory.length ? state.giftHistory.slice(0, 60).map(h => {
        const incoming = h.direction === 'in';
        return `
        <div class="list-row" style="display:flex;align-items:center;gap:10px;padding:10px 2px">
          <div style="font-size:20px">${esc(h.emoji || '🎁')}</div>
          <div class="grow" style="min-width:0">
            <div style="font-size:13px;font-weight:600">${incoming ? esc(h.roleName) + ' 送给你 ' + esc(h.giftName) : esc(h.giftName) + ' → ' + esc(h.roleName)}${h.isCustom ? ' <span class="custom-gift-tag">✨ TA自创</span>' : ''}</div>
            <div class="muted" style="font-size:11px;margin-top:2px">${incoming ? esc(dn) + '送我' : '我送' + esc(dn)} · ${fmtMsgTime(h.ts)}</div>
          </div>
        </div>`;
      }).join('') : '<div class="empty-hint">还没有送过礼物</div>'}
    </div>`);

  $('#giftAdd').addEventListener('click', () => openGiftEditor(null));
  { const btn = $('#giftSend'); if (btn) btn.addEventListener('click', () => sendGift($('#giftRole').value, $('#giftPick').value)); }
  $$('[data-giftedit]').forEach(b => b.addEventListener('click', () => openGiftEditor(b.dataset.giftedit)));
  $$('[data-giftdel]').forEach(b => b.addEventListener('click', async () => {
    const ok = await confirmDialog('删除礼物', '确定删除这个礼物吗？历史记录会保留。', '删除', true);
    if (!ok) return;
    state.gifts = state.gifts.filter(g => g.id !== b.dataset.giftdel);
    persist();
    renderGiftPage();
  }));
}

/* =========================================================
 * 十三、子页面框架
 * ========================================================= */
function subShell(title, bodyHTML, rightHTML = '') {
  const page = $('#page-sub');
  page.innerHTML = `
    <div class="sub-nav">
      <button class="back-btn" data-back>‹</button>
      <div class="sub-title">${esc(title)}</div>
      <div class="sub-right">${rightHTML}</div>
    </div>
    <div class="sub-body" id="subBody">${bodyHTML}</div>`;
  $('[data-back]', page).addEventListener('click', goBack);
  return $('#subBody');
}

function renderSub(name) {
  switch (name) {
    case 'cards': return renderCardsPage();
    case 'stickers': return renderStickersPage();
    case 'letters': return renderLettersPage();
    case 'letter-new': return renderLetterNewPage();
    case 'quizzes': return renderQuizzesPage();
    case 'quiz-new': return renderQuizNewPage();
    case 'pomodoro': return renderPomodoroPage();
    case 'location': return renderLocationPage();
    case 'storage': return renderStoragePage();
    case 'probability': return renderProbabilityPage();
    case 'settings': return renderSettingsPage();
    case 'beautify': return renderBeautifyPage();
    case 'wallet': return renderWalletPage();
    case 'todo': return renderTodoPage();
    case 'ledger': return renderLedgerPage();
    case 'anniversary': return renderAnniversaryPage();
    case 'snapshots': return renderSnapshotsPage();
    case 'coin': return renderCoinPage();
    case 'linktest': return renderLinkTestPage();
    case 'gifts': return renderGiftPage();
    case 'pat': return renderPatPage();
    case 'pet': return renderPetPage();
    case 'wordcloud': return renderWordCloudPage();  /* 互动词云：聊天页快捷菜单进入 */
    case 'play': return renderPlayPage();            /* 一起玩：一起做 → 一起玩 → 五子棋 的二级页 */
    case 'games': return renderPlayPage();           /* 旧路由兜底：桌面小游戏已并入【一起玩】 */
    case 'readtogether': return renderReadTogetherPage();
    case 'listen': return renderListenPage();
    case 'jar': return renderJarPage();
    case 'reading': return renderReadingPage();
    case 'readingroom': return renderReadingRoomPage();
    case 'gomoku': return renderGomokuPage();
    case 'reminder': return renderReminderPage();
    default: return renderSettingsPage();
  }
}

/* =========================================================
 * 十三·三、互动词云（聊天页右上角快捷菜单进入）
 * 纯前端轻量词频统计，无后端分词：
 * ① 只用超级正则 split 切分（空白 + 全部中英文标点与特殊符号），全程无 while 循环
 * ② 2~6 字的纯中文片段全部计入频次，不做任何数量截断（全量统计）
 * ③ 只按显式停用词表过滤；统计后把「好好 / 好好好」这类叠词按完整词合并频次
 * ④ 频次降序排序，仅在最终渲染阶段取前 10 名交给 wordcloud2.js 与排行榜
 * ========================================================= */
let wcTimeTab = 'week';   /* today 今日 / week 本周 / all 全部，默认本周 */
let wcWhoTab = 'ta';      /* ta TA说的 / me 我说的，默认 TA 说的 */
let wcRoleId = null;      /* 进入词云页时锁定的梦角 id，切换筛选时保持不变 */
let wcRenderSeq = 0;      /* 渲染序号：快速切换筛选时，旧的延迟渲染任务自动作废，避免重复叠画卡死 */

/* ===== 词云分词（最简方案）：全程只用 split + forEach，没有任何 while 循环，结构上不可能死循环 ===== */
/* 分割线：空白 + 全部中英文标点 + 常见特殊符号，作为最高优先级的切分依据 */
const WC_SPLIT_RE = /[\s，。！？、,.!?;；:："'“”‘’（）()\[\]【】《》<>~～\-—_+*=&#@￥$%^…]+/;

/* 停用词：无意义单字 / 虚词 / 语气词，命中即整段丢弃 */
const WC_STOP_WORDS = new Set([
  '的', '了', '吗', '呢', '啊', '在', '是', '我', '你', '他', '她', '它',
  '这', '那', '就', '不', '也', '都', '还', '和', '跟', '与', '或', '但', '而',
  '呀', '吧', '嘛', '么', '哦', '嗯', '很', '太', '最', '更', '之', '着', '过',
  '们', '个', '于', '把', '被', '让', '给', '对', '向', '从', '又', '再', '只',
  '已', '为', '且', '即', '却', '若', '虽', '及', '并', '所', '如', '同', '比',
  '等', '每', '各', '别', '另', '您', '咱', '啥'
]);
/* 停用词表补充：常见无实义的双字组合，避免「我们、那个、就是」这类词占榜；
 * 其余 2~6 字纯汉字片段一律参与统计，不再做「整词由虚词组成」的过度过滤 */
['我们', '你们', '他们', '这个', '那个', '什么', '怎么', '就是', '还有', '可以',
 '因为', '所以', '但是', '如果', '时候', '现在', '一下', '这样', '那样', '不要']
  .forEach(w => WC_STOP_WORDS.add(w));

/* 显示上限：统计阶段一律全量累加，只有传给 WordCloud 与排行榜时才截取前 10 名；
 * 不设置任何「总字符 / 总消息条数 / 单条字数」预算，当前梦角的聊天记录会全部遍历 */
const WC_TOP_N = 10;

/* 原生中文分词器（现代浏览器均支持）：用于把超过 6 字的长句拆成有意义的词。
 * 不可用时自动退化为 3 字一组切块，保证不会整句被丢弃 */
const WC_SEGMENTER = (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function')
  ? new Intl.Segmenter('zh', { granularity: 'word' })
  : null;

/* 停用词判断：只按专门的停用词表过滤 */
function wcIsStopWord(w) {
  return WC_STOP_WORDS.has(w);
}

/* 片段清洗：只保留汉字（纯数字、纯字母、emoji、符号会被清成空串，后续自然丢弃） */
function wcCleanFragment(frag) {
  return String(frag == null ? '' : frag).replace(/[^\u4e00-\u9fa5]/g, '');
}

/* 超长片段兜底切块：按 3 字一组切开，末尾不足 2 字的丢弃；
 * 纯 for 循环、不递归，保证长句也有词可统计 */
function wcChunkLong(clean, out) {
  const res = out || [];
  for (let i = 0; i < clean.length; i += 3) {
    const piece = clean.slice(i, i + 3);
    if (piece.length >= 2 && !wcIsStopWord(piece)) res.push(piece);
  }
  return res;
}

/* 把一个切分片段转成有效词数组：
 * ≤6 字整段保留（「讨厌你」不会被拆开）；
 * >6 字先用 Intl.Segmenter 做中文分词，失败时退化为 3 字切块；
 * 这样聊天里没有标点的长句不会再被整段吞掉 */
function wcSplitFragment(piece) {
  const clean = wcCleanFragment(piece);
  if (clean.length < 2) return [];
  if (clean.length <= 6) return [clean];
  const out = [];
  if (WC_SEGMENTER) {
    for (const seg of WC_SEGMENTER.segment(clean)) {
      if (!seg.isWordLike) continue;
      const w = wcCleanFragment(seg.segment);
      if (w.length > 6) {
        wcChunkLong(w, out);
      } else if (w.length >= 2 && !wcIsStopWord(w)) {
        out.push(w);
      }
    }
  }
  if (out.length) return out;
  return wcChunkLong(clean);
}

/* 消息时间戳归一化为毫秒：
 * 兼容 ts / timestamp / time 三种字段名，也支持 Date 对象 / 秒级时间戳 / 数字字符串；
 * 字符串先按 "2026-10-31 15:00" 这类本地格式解析，再兜底解析 ISO（带 T / Z）；
 * 一律返回数字时间戳用于比对，绝不做字符串比较 */
function wcMsgTs(m) {
  let raw = m.ts != null ? m.ts : (m.timestamp != null ? m.timestamp : m.time);
  if (raw instanceof Date) {
    const t = raw.getTime();
    return Number.isFinite(t) ? t : 0;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw < 1e11 ? raw * 1000 : raw;
  if (typeof raw === 'string' && raw.trim()) {
    const s = raw.trim();
    const n = Number(s);
    if (Number.isFinite(n) && n > 0) return n < 1e11 ? n * 1000 : n;
    const t1 = new Date(s.replace(/-/g, '/')).getTime();   /* iOS 不支持 "yyyy-mm-dd hh:mm"，换成斜杠 */
    if (Number.isFinite(t1)) return t1;
    const t2 = new Date(s).getTime();                      /* 兜底：ISO 带 T / Z 的写法 */
    if (Number.isFinite(t2)) return t2;
  }
  return 0;
}

/* 消息发送方归一化：兼容 role / sender / isUser / who 多种写法
 * 聊天里真正落库的是 role:'user' / 'dream'，sender 只有转账、礼物等类型才带，
 * 所以我发的消息必须能用 role:'user'、isUser:true、sender:'user' 任意一种匹配到 */
function wcMsgSender(m) {
  if (!m) return '';
  if (m.isUser === true || m.mine === true) return 'user';
  if (m.isUser === false) return 'ta';
  if (m.sender === 'ta' || m.sender === 'dream' || m.sender === 'assistant') return 'ta';
  if (m.sender === 'user' || m.sender === 'me') return 'user';
  if (m.who === 'me' || m.who === 'user') return 'user';
  if (m.who === 'ta' || m.who === 'dream') return 'ta';
  if (m.role === 'user' || m.role === 'me') return 'user';
  if (m.role === 'dream' || m.role === 'ta' || m.role === 'assistant') return 'ta';
  if (m.role === 'system') return '';        /* 系统提示不参与统计 */
  return 'ta';
}

/* 取消息正文：兼容 text / content / msg / message / body，字符串或 {text} 对象；
 * 逐个候选字段取第一个「非空」的文本，避免某个字段存了空串就把整条消息判成无正文；
 * 图片 / 表情包等非文字内容（没有文本字段）返回空串，后续直接被跳过 */
function wcMsgText(m) {
  if (!m) return '';
  const candidates = [m.text, m.content, m.msg, m.message, m.body];
  for (const raw of candidates) {
    if (raw == null) continue;
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
    if (typeof raw === 'object' && typeof raw.text === 'string' && raw.text.trim()) return raw.text.trim();
  }
  return '';
}

/* 按时间维度 + 对象维度，取出当前梦角聊天记录里的纯文字内容
 * 关键：全量遍历，没有 slice(-xx) / splice / 条数上限 / 字符预算，一条都不会少
 * 同时输出【词云排查】日志：先看总条数，再逐项看被哪种条件过滤掉 */
function wcCollectTexts(roleId, timeTab, whoTab) {
  /* ① 定位梦角：roleId 取不到时退回当前会话角色，避免读到 undefined 直接变成 0 条 */
  let rid = roleId;
  if (!rid || !state.chats || !Array.isArray(state.chats[rid])) rid = state.activeRoleId;
  const allMessages = (state.chats && Array.isArray(state.chats[rid])) ? state.chats[rid] : [];

  /* ② 用户要求的排查日志：先确认「到底读到了多少条、时间跨度是多少」 */
  console.log("【词云排查】当前梦角总消息数:", allMessages.length);
  console.log("【词云排查】第一条消息时间:", allMessages[0] && allMessages[0].time, "最后一条:", allMessages[allMessages.length - 1] && allMessages[allMessages.length - 1].time);
  /* 补一条原始时间字段日志：部分旧记录用的是 ts，方便看清真实存储的时间格式 */
  const rawTime = m => {
    if (!m) return undefined;
    if (m.time !== undefined) return m.time;
    if (m.ts !== undefined) return m.ts;
    return m.timestamp;
  };
  console.log("【词云排查】原始时间字段（首/尾）:", rawTime(allMessages[0]), '/', rawTime(allMessages[allMessages.length - 1]));
  /* 一条都没读到时，把所有梦角的条数打出来，判断是不是梦角 id 取错了 */
  if (!allMessages.length) {
    const perRole = Object.keys(state.chats || {}).map(id => {
      const r = roleById(id);
      return (r ? r.name : id) + ':' + ((state.chats[id] || []).length);
    });
    console.log("【词云排查】当前梦角 ID:", rid, "各梦角消息条数 →", perRole.join(' / ') || '（无任何聊天记录）');
  }

  /* ③ 时间起点：今日/本周用本地 0 点整计算；全部模式不做任何时间比对 */
  const nowDate = new Date();
  const now = nowDate.getTime();
  const isAll = timeTab === 'all';
  let start = 0;
  if (timeTab === 'today') {
    /* 今日：今天 00:00:00 起 */
    start = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate(), 0, 0, 0, 0).getTime();
  } else if (timeTab === 'week') {
    /* 本周：本周一 00:00:00 起（getDay() 周日是 0，要回退 6 天而不是 1 天） */
    const day = nowDate.getDay();
    const back = day === 0 ? 6 : day - 1;
    start = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - back, 0, 0, 0, 0).getTime();
  }
  console.log("【词云排查】时间范围:", isAll ? '全部（跳过时间过滤）' : new Date(start).toLocaleString('zh-CN'));

  const wantSender = whoTab === 'ta' ? 'ta' : 'user';

  /* ④ 先统计整体分布（类型 / 发送方），再逐条过滤并计数，过滤原因一目了然 */
  const typeMap = Object.create(null);
  const senderMap = Object.create(null);
  allMessages.forEach(m => {
    if (!m) return;
    const t = m.type || 'text';
    typeMap[t] = (typeMap[t] || 0) + 1;
    const s = wcMsgSender(m) || 'other';
    senderMap[s] = (senderMap[s] || 0) + 1;
  });
  console.log("【词云排查】消息类型分布:", typeMap);
  console.log("【词云排查】发送方分布:", senderMap);

  const stats = { recalled: 0, nonText: 0, sender: 0, emptyText: 0, badTime: 0, ok: 0 };
  const texts = [];

  allMessages.forEach(m => {
    if (!m) return;
    if (m.recalled) { stats.recalled++; return; }                 /* 已撤回的不统计 */
    const type = m.type || 'text';
    if (type !== 'text') { stats.nonText++; return; }              /* 图片/表情/转账/礼物/通话等非纯文字 */
    if (wcMsgSender(m) !== wantSender) { stats.sender++; return; } /* 发送方不匹配 */
    const text = wcMsgText(m);
    if (!text) { stats.emptyText++; return; }                      /* 没有文本正文 */
    if (!isAll) {
      const ts = wcMsgTs(m);
      /* 时间统一转成毫秒数字后再比较；允许 1 分钟时钟误差 */
      if (!(ts > 0) || ts < start || ts > now + 60 * 1000) { stats.badTime++; return; }
    }
    stats.ok++;
    texts.push(text);                                              /* 全量收集，不截断条数 */
  });

  console.log("【词云排查】过滤明细:", stats);
  console.log("【词云排查】过滤后参与统计的有效文本数:", texts.length);
  return texts;
}

/* 叠词折叠键：把连续重复的字压成一个（好好好→好、开开心心→开心），
 * 只用于识别「同一个词的不同重复写法」，不改变最终保留的词形 */
function wcRepeatKey(w) {
  return String(w).replace(/(.)\1+/g, '$1');
}

/* 强制合并重复词：折叠键相同的多个写法（好好 / 好好好）以「最长的完整词」为准，
 * 把所有频次累加到它、删除其它写法；只合并叠词变体，
 * 不会把「讨厌 / 讨厌你」这类语义不同的词强行合并 */
function wcMergeRepeatWords(freq) {
  const groups = Object.create(null);
  Object.keys(freq).forEach(w => {
    const key = wcRepeatKey(w);
    if (!groups[key]) groups[key] = [];
    groups[key].push(w);
  });
  Object.keys(groups).forEach(key => {
    const variants = groups[key];
    if (variants.length < 2) return;
    /* 保留最长的写法；长度相同则保留频次更高者，保证「完整的词」留存 */
    let keep = variants[0];
    variants.forEach(w => {
      if (w.length > keep.length || (w.length === keep.length && freq[w] > freq[keep])) keep = w;
    });
    let total = 0;
    variants.forEach(w => {
      total += freq[w];
      if (w !== keep) delete freq[w];
    });
    freq[keep] = total;
  });
}

/* 词频统计：产出 [['想你', 25], ['开心', 18], ['晚安', 15], ...] 格式
 * 全程只有 split + forEach，没有任何 while 循环，结构上不可能死循环
 * 规则：超级正则切分 → 2~6 字片段整段保留；超过 6 字的长句交给 wcSplitFragment
 * （优先原生分词、兜底 3 字切块）→ 停用词过滤；
 * 不设任何总字符预算，所有消息文本都参与统计；截取前 10 名留给渲染阶段 */
function wcBuildList(texts) {
  const freq = Object.create(null);

  texts.forEach(t => {
    let raw = String(t || '');
    /* 空格、换行、制表符、全部中英文标点与特殊符号一律作为分割线 */
    raw.split(WC_SPLIT_RE).forEach(piece => {
      wcSplitFragment(piece).forEach(clean => {
        if (wcIsStopWord(clean)) return;                       /* 只按停用词表过滤 */
        freq[clean] = (freq[clean] || 0) + 1;                  /* 全量累加，不设词数上限 */
      });
    });
  });

  /* 强制合并「好好 / 好好好」这类重复写法，以完整词为准累加频次 */
  wcMergeRepeatWords(freq);

  /* 转为数组后按频次降序排序（同频时长词优先），此处不截断 */
  return Object.keys(freq)
    .map(w => [w, freq[w]])
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
}

/* 渲染前数据清洗（词云库与排行榜共用）：
 * 只接受 [['词语', 正数频次], ...] 的数组格式，剔除空词、NaN / undefined / null / 非正数频次，
 * 按频次降序排序；不截断，由调用方在真正渲染时取前 10 */
function wcSanitizeList(list) {
  const out = [];
  (Array.isArray(list) ? list : []).forEach(item => {
    if (!Array.isArray(item) || item.length < 2) return;
    const word = typeof item[0] === 'string' ? item[0].trim() : '';
    const count = Number(item[1]);
    if (!word) return;
    if (!Number.isFinite(count) || count <= 0) return;
    out.push([word, count]);
  });
  out.sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
  return out;
}

/* 切换筛选时的过渡态：立刻清空旧画布并显示「正在统计…」，
 * 让点击反馈瞬间可见，真正的计算与重绘放到下一个任务里执行 */
function wcShowLoading() {
  const canvas = $('#wordcloud-canvas');
  if (canvas) {
    canvas.style.display = 'block';
    try { canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height); } catch (err) { /* 忽略 */ }
  }
  const emptyEl = $('#wcEmpty');
  if (emptyEl) { emptyEl.textContent = '正在统计…'; emptyEl.classList.remove('hidden'); }
  const rankEl = $('#wcRank');
  if (rankEl) { rankEl.classList.add('hidden'); rankEl.innerHTML = ''; }
}

/* 词云页：返回键 + 标题 + 双筛选标签 + canvas 容器 */
function renderWordCloudPage() {
  /* 每次从快捷菜单进入都恢复默认筛选：本周 + TA说的 */
  wcTimeTab = 'week';
  wcWhoTab = 'ta';
  /* 词云统计的梦角：优先取来源聊天页的角色（返回栈栈顶就是聊天页路由），
     兜底才用当前会话角色，避免多梦角时统计到别人的聊天记录 */
  const back = routeStack.length ? routeStack[routeStack.length - 1] : null;
  wcRoleId = (back && back.roleId) || state.activeRoleId;
  const roleId = wcRoleId;
  const dn = taName(roleId);
  const body = subShell('互动词云', `
    <div class="wc-tabs">
      <button class="wc-tab ${wcTimeTab === 'today' ? 'active' : ''}" data-wctime="today">今日</button>
      <button class="wc-tab ${wcTimeTab === 'week' ? 'active' : ''}" data-wctime="week">本周</button>
      <button class="wc-tab ${wcTimeTab === 'all' ? 'active' : ''}" data-wctime="all">全部</button>
    </div>
    <div class="wc-tabs">
      <button class="wc-tab ${wcWhoTab === 'ta' ? 'active' : ''}" data-wcwho="ta">${esc(dn)}说的</button>
      <button class="wc-tab ${wcWhoTab === 'me' ? 'active' : ''}" data-wcwho="me">我说的</button>
    </div>
    <div class="wc-stage">
      <canvas id="wordcloud-canvas"></canvas>
      <div class="wc-empty hidden" id="wcEmpty"></div>
    </div>
    <div class="wc-rank hidden" id="wcRank"></div>
    <div class="wc-tip muted">统计与 ${esc(dn)} 的聊天文字内容，已自动过滤标点与常用虚词</div>
  `);
  $$('[data-wctime]', body).forEach(btn => btn.addEventListener('click', () => {
    if (wcTimeTab === btn.dataset.wctime) return;
    wcTimeTab = btn.dataset.wctime;
    /* 先同步更新选中态，点击立刻有反馈 */
    $$('[data-wctime]', body).forEach(b => b.classList.toggle('active', b === btn));
    /* 再清空旧图并显示「正在统计…」，把重算与重绘推迟到下一个任务，避免阻塞点击 */
    wcShowLoading();
    setTimeout(() => drawWordCloud(), 50);
  }));
  $$('[data-wcwho]', body).forEach(btn => btn.addEventListener('click', () => {
    if (wcWhoTab === btn.dataset.wcwho) return;
    wcWhoTab = btn.dataset.wcwho;
    $$('[data-wcwho]', body).forEach(b => b.classList.toggle('active', b === btn));
    wcShowLoading();
    setTimeout(() => drawWordCloud(), 50);
  }));
  /* 等布局稳定后再量 canvas 实际宽度，避免 backing store 拉伸模糊 */
  requestAnimationFrame(() => drawWordCloud());
}

/* 取数 → 统计 → 调用 wordcloud2.js 绘制 */
function drawWordCloud() {
  const canvas = $('#wordcloud-canvas');
  if (!canvas) return;
  const seq = ++wcRenderSeq;   /* 每次调用递增，100ms 延迟任务据此判断是否已过期 */
  const emptyEl = $('#wcEmpty');
  const dn = taName(wcRoleId || state.activeRoleId);
  const rankEl = $('#wcRank');
  const showEmpty = msg => {
    canvas.style.display = 'none';
    if (emptyEl) { emptyEl.textContent = msg; emptyEl.classList.remove('hidden'); }
    if (rankEl) { rankEl.classList.add('hidden'); rankEl.innerHTML = ''; }
  };

  /* 有数据时的显隐切换：先恢复可见，再量尺寸，最后绘制 */
  const showCanvas = () => {
    canvas.style.display = 'block';
    if (emptyEl) emptyEl.classList.add('hidden');
  };

  /* ① 库兜底：wordcloud2.js 未加载成功时给出友好提示 */
  if (typeof WordCloud !== 'function') {
    showEmpty('词云组件加载失败，请检查网络后重新进入');
    return;
  }

  /* ② 取数 + 全量词频统计 → 严格清洗成 [['词语', 频次], ...] 完整列表（此阶段不截断） */
  const texts = wcCollectTexts(wcRoleId || state.activeRoleId, wcTimeTab, wcWhoTab);
  const fullList = wcSanitizeList(wcBuildList(texts));
  /* 排查日志：确认统计阶段产出了多少词条，再对比最终只渲染 Top 10 */
  console.log("【词云排查】分词后词条总数:", fullList.length, "｜渲染数量:", Math.min(fullList.length, WC_TOP_N));
  if (!fullList.length) {
    const scope = wcTimeTab === 'all' ? '全部聊天记录' : '这段时间';
    showEmpty(texts.length
      ? scope + '的文字内容太少，暂时提取不出关键词，再多聊几句试试'
      : scope + '还没有可统计的聊天文字，先去和 ' + dn + ' 说说话吧');
    return;
  }

  /* ③ 只有最终渲染才截取前 10 名：词云与排行榜共用同一份 Top 10，统计结果本身是完整的 */
  const list = fullList.slice(0, WC_TOP_N);

  /* ④ 渲染前保证 canvas 可见（隐藏时宽高为 0，画出来会是空白） */
  showCanvas();
  /* 布局尚未完成（宽高为 0）时直接中止，避免词云库在内部空转 */
  if (!canvas.offsetWidth || !canvas.offsetHeight) {
    showEmpty('页面布局还没有准备好，请稍后再进入词云看看');
    return;
  }

  /* ⑤ 动态字号区间：取 Top 10 里的最大 / 最小频次，把频次线性映射到 16px ~ 55px，
   * 让最高频的词尽量撑满画布，最低频的词也保持可读（数据已按频次降序，首位即最大值） */
  const maxCount = list[0][1];
  const minCount = list[list.length - 1][1];

  /* 底部排行榜：与词云共用同一份 Top 10 数组 */
  if (rankEl) {
    const top = list;
    rankEl.innerHTML = `<div class="wc-rank-title">高频词 TOP ${top.length}</div>`
      + top.map(([w, n], i) => `<div class="wc-rank-row">
          <span class="wc-rank-no">${i + 1}</span>
          <span class="wc-rank-word">${esc(w)}</span>
          <span class="wc-rank-count">${n} 次</span>
        </div>`).join('');
    rankEl.classList.remove('hidden');
  }

  /* ⑥ 延迟 200ms 再画：等 DOM 完全渲染、父容器尺寸稳定后，再强制写入真实像素尺寸 */
  setTimeout(() => {
    /* 过期任务直接作废；canvas 不在文档中（已返回/切页）也放弃本次渲染 */
    if (seq !== wcRenderSeq || !canvas.isConnected) return;
    try {
      /* 强制绝对像素：直接量父容器真实宽度（兜底 300），高度固定 350，
       * 避免移动端按 CSS 百分比自动缩放，把整块词云压成一团 */
      const parentWidth = Math.round(canvas.parentElement.getBoundingClientRect().width) || 300;
      canvas.width = Math.max(200, parentWidth);
      canvas.height = 350;
      /* 重设 width/height 会清空画布，这里再显式清一次，确保上一次绘制不残留叠加 */
      try { canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height); } catch (clearErr) { /* 忽略 */ }

      WordCloud(canvas, {
        list,
        gridSize: 10,        /* 网格从 16 缩小到 10：排布更紧凑，更容易填满画布空隙 */
        weightFactor: function (count) {
          /* 频次全相同就没有区间可言，统一给中间大字号 */
          if (maxCount === minCount) return 40;
          /* 线性映射：最低频 16px，最高频约 55px，让 Top 词明显放大、撑满画布 */
          const size = 16 + ((count - minCount) / (maxCount - minCount)) * 39;
          return Math.min(55, Math.max(16, size));   /* 再夹一次，防极端数据越界 */
        },
        fontFamily: 'sans-serif',
        fontWeight: 600,
        color: function () {
          /* 主题蓝 + 低饱和糖果色随机 */
          const colors = ['#007AFF', '#FF6B81', '#A29BFE', '#55E6C1', '#FDCB6E'];
          return colors[Math.floor(Math.random() * colors.length)];
        },
        backgroundColor: 'transparent',
        rotateRatio: 0.3,       /* 少量词允许旋转，排版更活泼 */
        shuffle: false,         /* 高频词优先落在中心 */
        drawOutOfBound: false,
        shrinkToFit: true
      });
    } catch (err) {
      /* 库内部异常只打印并提示，绝不向上抛，避免整页卡死 */
      console.error('[互动词云] 渲染失败：', err);
      showEmpty('词云渲染出错了，换个筛选条件再试试');
    }
  }, 200);   /* 至少 200ms，确保移动端 DOM 与容器尺寸都已稳定 */
}

/* =========================================================
 * 十二·六、提醒应用（日历 + 经期 + 日常闹钟）
 * ========================================================= */
/* 选中日期 / 小日历当前月（与桌面大日历 homeCalMonth 独立，互不干扰） */
let remSelDate = '';  /* YYYY-MM-DD */
let remCalMonth = { y: new Date().getFullYear(), m: new Date().getMonth() };
/* 提醒类型元数据：图标 + 颜色 + 中文名 + 桌面标记点 class */
const REMINDER_TYPES = {
  water:     { label: '喝水', icon: '💧', color: '#007AFF', dotCls: 'rdot-blue' },
  medicine:  { label: '吃药', icon: '💊', color: '#F59E0B', dotCls: 'rdot-yellow' },
  exercise:  { label: '运动', icon: '🏃', color: '#22C55E', dotCls: 'rdot-green' }
};

/* 格式化日期为 YYYY-MM-DD（月日补零） */
function remFmtDate(y, m, d) { return y + '-' + pad2(m + 1) + '-' + pad2(d); }
/* 日期字符串 → Date（月从 0 起） */
function remParseDate(s) {
  const p = String(s || '').split('-').map(Number);
  if (p.length !== 3 || p.some(n => !Number.isFinite(n))) return null;
  return new Date(p[0], p[1] - 1, p[2]);
}
/* 日期字符串 + N 天 → 新日期字符串（N 可以是负数） */
function remAddDays(dateStr, n) {
  const d = remParseDate(dateStr);
  if (!d) return '';
  d.setDate(d.getDate() + n);
  return remFmtDate(d.getFullYear(), d.getMonth(), d.getDate());
}

/* 判断某天是否在某个经期区间内（含端点；end=null 视为进行中，一直成立） */
function isDayInPeriod(dateStr, period) {
  if (!period || !period.start) return false;
  if (period.end == null) return dateStr >= period.start;
  return dateStr >= period.start && dateStr <= period.end;
}
/* 经期持续天数（只对已结束的返回） */
function periodDuration(period) {
  if (!period || !period.start || !period.end) return 0;
  const s = remParseDate(period.start), e = remParseDate(period.end);
  if (!s || !e) return 0;
  return Math.round((e.getTime() - s.getTime()) / 86400000) + 1;
}

/* 取出当前进行中的经期（end=null）；没有返回 null */
function ongoingPeriod() {
  return (state.periods || []).find(p => p && p.start && p.end == null) || null;
}
/* 找到最近一次已结束的经期（按 start 降序取第一条有 end 的） */
function lastFinishedPeriod() {
  const finished = (state.periods || []).filter(p => p && p.start && p.end);
  if (!finished.length) return null;
  finished.sort((a, b) => String(b.start).localeCompare(String(a.start)));
  return finished[0];
}
/* 预测下一次经期区间：返回 { predictedStart, predictedEnd, duration }；没有历史记录返回 null */
function predictNextPeriod() {
  const last = lastFinishedPeriod();
  if (!last) return null;
  const duration = periodDuration(last) || 5;
  const predictedStart = remAddDays(last.start, 28);
  const predictedEnd = remAddDays(predictedStart, duration - 1);
  return { predictedStart, predictedEnd, duration };
}

/* 取出某一天的经期记录；返回 { period, dayIndex, isOngoing, isPredicted, predictedRange } 或 null
   优先级：历史区间 → 进行中 → 预测区间（历史区间和进行中同一时间不会冲突，因为 ongoing 记录有 end=null） */
function periodAt(dateStr) {
  /* 1. 历史区间（start 和 end 都存在） */
  for (const p of (state.periods || [])) {
    if (p.start && p.end && dateStr >= p.start && dateStr <= p.end) {
      const startTs = remParseDate(p.start).getTime();
      const dayTs = remParseDate(dateStr).getTime();
      return { period: p, dayIndex: Math.round((dayTs - startTs) / 86400000) + 1, isOngoing: false };
    }
  }
  /* 2. 进行中（end=null，dateStr >= start） */
  const ongoing = ongoingPeriod();
  if (ongoing && dateStr >= ongoing.start) {
    const startTs = remParseDate(ongoing.start).getTime();
    const dayTs = remParseDate(dateStr).getTime();
    return { period: ongoing, dayIndex: Math.round((dayTs - startTs) / 86400000) + 1, isOngoing: true };
  }
  /* 3. 预测区间 */
  const pred = predictNextPeriod();
  if (pred && dateStr >= pred.predictedStart && dateStr <= pred.predictedEnd) {
    const startTs = remParseDate(pred.predictedStart).getTime();
    const dayTs = remParseDate(dateStr).getTime();
    const dayIndex = Math.round((dayTs - startTs) / 86400000) + 1;
    return { period: { id: '__predict__', start: pred.predictedStart, end: pred.predictedEnd }, dayIndex, isPredicted: true };
  }
  return null;
}

/* 判断某条日常提醒在指定日期是否生效：
   · 单次提醒（isLongTerm 为假）：date === dateStr
   · 长期提醒：dateStr >= startDate 且（无截止 endDate === '' 或 dateStr <= endDate） */
function reminderActiveOn(r, dateStr) {
  if (!r) return false;
  if (r.isLongTerm) {
    const s = r.startDate || r.date || '';
    const e = r.endDate || '';               /* 空字符串 = 长期/每天，无截止 */
    if (!s) return false;
    if (dateStr < s) return false;
    if (e && dateStr > e) return false;
    return true;
  }
  return r.date === dateStr;
}

/* 取出某天的所有日常提醒（含当天有效的长期提醒，按时间排序） */
function remindersOn(dateStr) {
  return (state.dailyReminders || [])
    .filter(r => reminderActiveOn(r, dateStr))
    .sort((a, b) => String(a.time).localeCompare(String(b.time)));
}

/* ===== 渲染提醒主界面 ===== */
function renderReminderPage() {
  /* 选中日期默认今天 */
  if (!remSelDate) {
    remSelDate = remFmtDate(remCalMonth.y, remCalMonth.m, new Date().getDate());
  }
  const sub = subShell('提醒', '');
  sub.classList.add('rem-page');

  const now = new Date();
  const ym = remCalMonth;
  const weekNames = ['日', '一', '二', '三', '四', '五', '六'];
  const startDow = new Date(ym.y, ym.m, 1).getDay();
  const daysInMonth = new Date(ym.y, ym.m + 1, 0).getDate();
  const prevDays = new Date(ym.y, ym.m, 0).getDate();

  let cells = '';
  for (let i = 0; i < startDow; i++) cells += `<div class="rem-day dim">${prevDays - startDow + 1 + i}</div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const key = remFmtDate(ym.y, ym.m, d);
    const isToday = ym.y === now.getFullYear() && ym.m === now.getMonth() && d === now.getDate();
    const isSel = remSelDate === key;
    const pInfo = periodAt(key);
    const rems = remindersOn(key);
    /* 经期标记：历史/进行中 → 红条；预测区间 → 浅红空心点 */
    let marksHtml = '';
    if (pInfo && !pInfo.isPredicted) marksHtml += '<span class="rem-bar"></span>';
    else if (pInfo && pInfo.isPredicted) marksHtml += '<span class="rem-pred-dot"></span>';
    const typeCounts = {};
    rems.forEach(r => { typeCounts[r.type] = (typeCounts[r.type] || 0) + 1; });
    Object.keys(typeCounts).forEach(t => {
      const meta = REMINDER_TYPES[t];
      if (meta) marksHtml += `<span class="rem-dot ${meta.dotCls}"></span>`;
    });
    cells += `<div class="rem-day${isToday ? ' today' : ''}${isSel ? ' sel' : ''}" data-key="${key}">${d}${marksHtml}</div>`;
  }
  const tail = (7 - (startDow + daysInMonth) % 7) % 7;
  for (let i = 1; i <= tail; i++) cells += `<div class="rem-day dim">${i}</div>`;

  sub.innerHTML = `
    <!-- 上半：小日历 -->
    <div class="rem-cal-card">
      <div class="rem-cal-head">
        <button class="rem-nav" id="remPrev">‹</button>
        <div class="rem-ym">${ym.y} 年 ${ym.m + 1} 月</div>
        <button class="rem-nav" id="remNext">›</button>
      </div>
      <div class="rem-week">${weekNames.map(w => `<div>${w}</div>`).join('')}</div>
      <div class="rem-grid">${cells}</div>
    </div>

    <!-- 下半：详情面板 -->
    <div class="rem-detail-card">
      <div class="rem-detail-title">${remSelDate.replace(/-/g, '/')} 提醒详情</div>

      <!-- 区块 A：经期管理 -->
      <div class="rem-block">
        <div class="rem-block-title">🩸 经期管理</div>
        ${renderPeriodBlock(remSelDate)}
      </div>

      <!-- 区块 B：日常提醒 -->
      <div class="rem-block">
        <div class="rem-block-title">⏰ 日常提醒</div>
        ${renderDailyBlock(remSelDate)}
      </div>
    </div>
  `;

  /* 日历翻月 */
  $('#remPrev').addEventListener('click', () => {
    remCalMonth = { y: ym.m === 0 ? ym.y - 1 : ym.y, m: ym.m === 0 ? 11 : ym.m - 1 };
    renderReminderPage();
  });
  $('#remNext').addEventListener('click', () => {
    remCalMonth = { y: ym.m === 11 ? ym.y + 1 : ym.y, m: ym.m === 11 ? 0 : ym.m + 1 };
    renderReminderPage();
  });
  /* 选日 */
  $$('.rem-day[data-key]', sub).forEach(el => el.addEventListener('click', () => {
    remSelDate = el.dataset.key;
    renderReminderPage();
  }));

  /* 绑定详情区按钮事件（在 innerHTML 之后） */
  bindReminderDetailEvents();
}

/* 渲染经期区块（打卡模式） */
function renderPeriodBlock(dateStr) {
  const pInfo = periodAt(dateStr);
  if (pInfo && pInfo.isPredicted) {
    /* 状态：选中了预测区间的某天 */
    return `<div class="rem-period-active rem-period-predicted">
      <div class="rem-period-text">📅 预测经期　（${esc(pInfo.period.start)} ~ ${esc(pInfo.period.end)}）</div>
      <button class="btn-sm" data-period-start="${dateStr}">标记为第一天</button>
    </div>`;
  }
  const ongoing = ongoingPeriod();
  if (pInfo && !pInfo.isOngoing) {
    /* 状态 C：历史记录区间 */
    return `<div class="rem-period-active">
      <div class="rem-period-text">经期第 <b>${pInfo.dayIndex}</b> 天　（${esc(pInfo.period.start)} ~ ${esc(pInfo.period.end)}）</div>
      <button class="btn-sm danger" data-period-del="${pInfo.period.id}">删除</button>
    </div>`;
  }
  if (ongoing) {
    /* 状态 B：进行中 */
    const pIndex = dateStr >= ongoing.start
      ? Math.round((remParseDate(dateStr).getTime() - remParseDate(ongoing.start).getTime()) / 86400000) + 1
      : null;
    return `<div class="rem-period-active rem-period-ongoing">
      <div class="rem-period-text">
        🩸 经期进行中${pIndex ? `　今天是第 <b>${pIndex}</b> 天` : ''}
        <div style="opacity:.6;font-size:11px;margin-top:2px">起始日：${esc(ongoing.start)}</div>
      </div>
      <button class="btn-sm primary" id="remPeriodEnd">记录经期最后一天</button>
    </div>`;
  }
  /* 状态 A：无进行中，今天打卡第一天 */
  return `<button class="btn primary rem-period-add" id="remPeriodAdd">记录经期第一天</button>`;
}

/* 渲染日常提醒区块 */
function renderDailyBlock(dateStr) {
  const list = remindersOn(dateStr);
  let html = '';
  if (!list.length) {
    html = `<div class="rem-empty">当天暂无日常提醒</div>`;
  } else {
    html = list.map(r => {
      const meta = REMINDER_TYPES[r.type] || { icon: '⏰', dotCls: '', color: '#8b909a' };
      return `<div class="rem-item" style="border-left-color:${meta.color}">
        <div class="rem-item-left">
          <div class="rem-item-icon">${meta.icon}</div>
          <div class="rem-item-main">
            <div class="rem-item-time">${esc(r.time)}</div>
            <div class="rem-item-type">${esc(r.typeLabel || meta.label || r.type)}${r.isLongTerm ? '（长期）' : ''}</div>
          </div>
        </div>
        <button class="rem-del" data-rem-del="${r.id}" title="删除">✕</button>
      </div>`;
    }).join('');
  }
  html += `<button class="btn-sm primary rem-add-btn" id="remAddBtn">＋ 添加日常提醒</button>`;
  return html;
}

/* =========================================================
 * 日常提醒：结构化添加表单（overlay + 类型选择 + time input）
 * ========================================================= */
let remFormOpen = false;
function openReminderForm() {
  if (remFormOpen) return;
  remFormOpen = true;
  const overlay = document.createElement('div');
  overlay.className = 'rem-form-overlay';
  overlay.innerHTML = `
    <div class="rem-form" role="dialog" aria-modal="true">
      <div class="rem-form-head">
        <div class="rem-form-title">添加日常提醒</div>
        <button class="rem-form-close" data-rf-close>✕</button>
      </div>
      <div class="rem-form-body">
        <div class="rem-form-field">
          <label>栏目一 · 类型</label>
          <div class="rem-type-chips">
            ${Object.entries(REMINDER_TYPES).map(([k, m]) =>
              `<button class="rem-chip" data-rt="${k}">${m.icon} ${m.label}</button>`
            ).join('')}
            <button class="rem-chip rem-chip-custom" data-rt="__custom">✏️ 自定义</button>
          </div>
          <div class="rem-custom-wrap" data-rc-wrap style="display:none">
            <input class="rem-custom-input" data-rc-input type="text" placeholder="输入自定义名称，例如「给猫喂药」" maxlength="12">
          </div>
        </div>
        <div class="rem-form-field">
          <label>栏目二 · 时间</label>
          <input class="rem-time-input" data-rt-input type="time" value="08:00">
        </div>
        <!-- 栏目三 · 长期提醒开关 -->
        <div class="rem-form-field">
          <div class="rem-lt-row">
            <label class="rem-lt-label">栏目三 · 长期提醒</label>
            <span class="rem-switch">
              <input type="checkbox" data-rl-toggle>
              <i class="rem-switch-track"></i>
            </span>
          </div>
          <div class="rem-lt-hint">开启后按日期范围每天提醒，可不设截止日期</div>
        </div>
        <!-- 单次日期（长期关闭时显示） -->
        <div class="rem-form-field" data-rs-single>
          <label>日期</label>
          <input class="rem-time-input" data-rd-single type="date" value="${remSelDate}">
        </div>
        <!-- 日期范围（长期开启时显示） -->
        <div class="rem-form-field rem-lt-range" data-rs-range style="display:none">
          <label>开始日期</label>
          <input class="rem-time-input" data-rd-start type="date" value="${remSelDate}">
          <label class="rem-lt-sub">截止日期</label>
          <input class="rem-time-input" data-rd-end type="date">
          <label class="rem-noend-row">
            <input type="checkbox" data-rd-noend>
            <span>长期 / 每天（无截止）</span>
          </label>
        </div>
      </div>
      <div class="rem-form-foot">
        <button class="btn primary" data-rt-save disabled>保存</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  let selectedType = 'water';
  let customLabel = '';

  const $q = sel => $(sel, overlay);

  const selectChip = key => {
    selectedType = key;
    $$('.rem-chip', overlay).forEach(c => c.classList.toggle('active', c.dataset.rt === key));
    const customWrap = $q('[data-rc-wrap]');
    if (customWrap) customWrap.style.display = key === '__custom' ? 'block' : 'none';
    updateSaveBtn();
  };
  const isLongTermOn = () => !!($q('[data-rl-toggle]') && $q('[data-rl-toggle]').checked);
  const isNoEndOn = () => !!($q('[data-rd-noend]') && $q('[data-rd-noend]').checked);
  const isReady = () => {
    const time = ($q('[data-rt-input]').value || '').trim();
    if (!/^\d{1,2}:\d{2}$/.test(time)) return false;
    if (selectedType === '__custom' && !customLabel.trim()) return false;
    if (!selectedType) return false;
    /* 日期校验 */
    if (isLongTermOn()) {
      const s = ($q('[data-rd-start]').value || '').trim();
      if (!s) return false;
      if (!isNoEndOn()) {
        const e = ($q('[data-rd-end]').value || '').trim();
        if (!e || e < s) return false;   /* 截止不能早于开始 */
      }
    } else {
      if (!($q('[data-rd-single]').value || '').trim()) return false;
    }
    return true;
  };
  const updateSaveBtn = () => {
    const save = $q('[data-rt-save]');
    if (save) save.disabled = !isReady();
  };
  /* 长期开关联动：开 → 隐藏单次日期、显示范围；关 → 反之 */
  const syncLongTermUI = () => {
    const on = isLongTermOn();
    $q('[data-rs-single]').style.display = on ? 'none' : 'block';
    $q('[data-rs-range]').style.display = on ? 'block' : 'none';
    updateSaveBtn();
  };
  /* 无截止勾选联动：勾选 → 禁用截止日期输入 */
  const syncNoEndUI = () => {
    const end = $q('[data-rd-end]');
    if (end) end.disabled = isNoEndOn();
    updateSaveBtn();
  };

  $$('.rem-chip', overlay).forEach(btn => btn.addEventListener('click', () => selectChip(btn.dataset.rt)));
  const customInput = $q('[data-rc-input]');
  if (customInput) customInput.addEventListener('input', () => { customLabel = customInput.value; updateSaveBtn(); });
  $q('[data-rt-input]').addEventListener('input', updateSaveBtn);
  $q('[data-rl-toggle]').addEventListener('change', syncLongTermUI);
  $q('[data-rd-noend]').addEventListener('change', syncNoEndUI);
  ['[data-rd-single]', '[data-rd-start]', '[data-rd-end]'].forEach(sel => {
    const el = $q(sel);
    if (el) el.addEventListener('input', updateSaveBtn);
  });

  /* 取消：点遮罩 / ✕ / ESC */
  const close = () => { if (!remFormOpen) return; remFormOpen = false; overlay.remove(); };
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  $('[data-rf-close]', overlay).addEventListener('click', close);
  document.addEventListener('keydown', onKey, { once: true });
  function onKey(e) { if (e.key === 'Escape') close(); }

  /* 保存：单次 → startDate = endDate = 单次日期；长期 → 保存范围（无截止存 ''） */
  $('[data-rt-save]', overlay).addEventListener('click', () => {
    if (!isReady()) return;
    const time = ($q('[data-rt-input]').value || '').trim();
    let type, typeLabel;
    if (selectedType === '__custom') {
      type = '__custom__';                          /* 特殊标记，渲染时用自定义文字 */
      typeLabel = customLabel.trim();
    } else {
      type = selectedType;
      typeLabel = REMINDER_TYPES[selectedType].label;
    }
    let isLongTerm, startDate, endDate, date;
    if (isLongTermOn()) {
      isLongTerm = true;
      startDate = ($q('[data-rd-start]').value || '').trim();
      endDate = isNoEndOn() ? '' : ($q('[data-rd-end]').value || '').trim();
      date = startDate;                             /* 兼容旧字段：首发生日 */
    } else {
      isLongTerm = false;
      startDate = ($q('[data-rd-single]').value || '').trim();
      endDate = startDate;
      date = startDate;
    }
    state.dailyReminders = state.dailyReminders || [];
    state.dailyReminders.push({
      id: uid(),
      type,
      typeLabel,
      date,
      time,
      isLongTerm,
      startDate,
      endDate,
      ts: Date.now()
    });
    persist();
    close();
    showToast('已添加');
    renderReminderPage();
  });

  selectChip('water');  /* 默认选中 water */
  syncLongTermUI();     /* 初始化日期区显示 */
}

/* 绑定详情区按钮的事件（动态渲染后调用） */
function bindReminderDetailEvents() {
  /* 经期：打卡第一天 —— end=null（进行中） */
  const addDay1 = $('#remPeriodAdd');
  if (addDay1) addDay1.addEventListener('click', () => {
    /* 如果选中日期比今天晚 → 提示；如果比今天早 → 从那天开始 */
    const p = { id: uid(), start: remSelDate, end: null, ts: Date.now() };
    state.periods = state.periods || [];
    state.periods.push(p);
    persist();
    showToast('已记录第一天，记得最后一天再打一次卡哦');
    renderReminderPage();
  });
  /* 经期：标记最后一天 —— 把进行中的 period.end 设为选中日期 */
  const endDay = $('#remPeriodEnd');
  if (endDay) endDay.addEventListener('click', () => {
    const ongoing = ongoingPeriod();
    if (!ongoing) return;
    if (remSelDate < ongoing.start) { showToast('最后一天不能比第一天早哦'); return; }
    ongoing.end = remSelDate;
    persist();
    showToast('好的，已记录这次经期结束');
    renderReminderPage();
  });
  /* 从预测区点击"标记为第一天"：相当于在那天开始一个新的经期 */
  $$('[data-period-start]').forEach(btn => btn.addEventListener('click', () => {
    const start = btn.dataset.periodStart;
    const p = { id: uid(), start, end: null, ts: Date.now() };
    state.periods = state.periods || [];
    state.periods.push(p);
    persist();
    showToast('已从这天开始，等你记录最后一天');
    renderReminderPage();
  }));
  /* 删除经期（历史区间才会有这个按钮，进行中的要先 mark end 才能删，或直接全删） */
  $$('[data-period-del]').forEach(btn => btn.addEventListener('click', () => {
    const id = btn.dataset.periodDel;
    state.periods = (state.periods || []).filter(p => p.id !== id);
    persist();
    renderReminderPage();
  }));

  /* 添加日常提醒 → 打开结构化表单 */
  const addBtn = $('#remAddBtn');
  if (addBtn) addBtn.addEventListener('click', openReminderForm);

  /* 删除日常提醒 */
  $$('[data-rem-del]').forEach(btn => btn.addEventListener('click', () => {
    const id = btn.dataset.remDel;
    state.dailyReminders = (state.dailyReminders || []).filter(r => r.id !== id);
    persist();
    renderReminderPage();
  }));
}

/* =========================================================
 * 桌面大日历标记扩展（在 anniversariesOn / todosOn 之外叠加 periods + dailyReminders）
 * 下面这几个函数会在 renderHomePage 渲染日历格时被调用
 * ========================================================= */
/* 旧函数 anniversariesOn / todosOn 保持原样不动，新增： */
/* periodsOn 返回 { periods: [...], predicted: true/false }，供桌面大日历区分红条 vs 预测空心点 */
function periodsOn(y, m, d) {
  const key = remFmtDate(y, m, d);
  const periods = (state.periods || []).filter(p => isDayInPeriod(key, p));
  let predicted = false;
  if (!periods.length) {
    const pred = predictNextPeriod();
    if (pred && key >= pred.predictedStart && key <= pred.predictedEnd) predicted = true;
  }
  return { periods, predicted };
}
function dailyRemindersOn(y, m, d) {
  return remindersOn(remFmtDate(y, m, d));
}

/* =========================================================
 * 闹钟轮询（每分钟检查一次，匹配到当前分钟触发 Notification）
 * 去重机制：state.remindersLastCheckAt 存上次检查的日期，每天只弹一次经期预警
 * ========================================================= */
let reminderPollTimer = null;
function startReminderPolling() {
  if (reminderPollTimer) return;
  const tick = () => {
    const now = new Date();
    const nowKey = remFmtDate(now.getFullYear(), now.getMonth(), now.getDate());
    const nowHM = pad2(now.getHours()) + ':' + pad2(now.getMinutes());

    /* 日常提醒（含长期提醒）：今天处于生效区间且时间精确匹配 HH:MM 才触发；
       去重 key 带 nowKey，长期提醒每天同一时间只弹一次 */
    (state.dailyReminders || []).forEach(r => {
      if (reminderActiveOn(r, nowKey) && r.time === nowHM) {
        const meta = REMINDER_TYPES[r.type] || { label: r.typeLabel || '提醒', icon: '⏰' };
        const label = r.typeLabel || meta.label;
        notifyNow(`${meta.icon} ${label}`, `${r.time} 到了，该${label}啦`, 'daily-' + r.id + '-' + nowKey + '-' + nowHM);
      }
    });

    /* 经期预警：同一天只弹一次（用 remindersLastCheckAt 存今天 key） */
    const lastKey = state.remindersLastCheckAt ? String(state.remindersLastCheckAt).slice(0, 10) : '';
    if (lastKey !== nowKey) {
      state.remindersLastCheckAt = nowKey;
      persist();
      /* 今天在经期内（历史/进行中均弹一次） */
      const todayPeriod = periodAt(nowKey);
      if (todayPeriod && !todayPeriod.isPredicted) {
        notifyNow('🩸 经期提醒', `今天是经期第 ${todayPeriod.dayIndex} 天，记得照顾自己哦`, 'period-today-' + nowKey);
      }
      /* 预测下次经期开始日 —— 用 predictNextPeriod() 代替手写逻辑（更准确：取最近已结束的、周期默认 28 天） */
      const pred = predictNextPeriod();
      if (pred) {
        const predictStartTs = remParseDate(pred.predictedStart).getTime();
        const diffDays = Math.round((predictStartTs - remParseDate(nowKey).getTime()) / 86400000);
        /* 恰好还有 2 天时弹完整预警文字（提前两天） */
        if (diffDays === 2) {
          notifyNow('🩸 经期预警：预计还有两天就要来例假了', '最近注意保暖，少吃凉的食物哦~', 'period-warn2-' + nowKey);
        }
      }
    }
  };
  tick();  /* 启动时立即检查一次 */
  reminderPollTimer = setInterval(tick, 60 * 1000);
}

/* 轻量通知：优先用 Notification API，回退 showToast */
let notifiedKeys = new Set();
function notifyNow(title, body, uniqueKey) {
  if (uniqueKey && notifiedKeys.has(uniqueKey)) return;  /* 同次渲染去重 */
  if (uniqueKey) notifiedKeys.add(uniqueKey);
  setTimeout(() => { if (uniqueKey) notifiedKeys.delete(uniqueKey); }, 30 * 1000);  /* 30 秒后允许重弹 */
  try {
    if ('Notification' in window) {
      if (Notification.permission === 'granted') {
        new Notification(title, { body, silent: false });
      } else if (Notification.permission !== 'denied') {
        Notification.requestPermission().then(p => {
          if (p === 'granted') new Notification(title, { body, silent: false });
        });
      }
    }
  } catch (e) { /* Notification 不可用忽略 */ }
  showToast(`${title} — ${body}`);
}

/* ===================== 拍一拍字卡库（我的 / TA 的） ===================== */
let patTab = 'user';
let patSearch = '';

function normalizePatCard(c) {
  const o = (c && typeof c === 'object') ? c : { content: String(c || '') };
  return {
    id: o.id || uid(),
    content: String(o.content || o.text || '').trim(),
    enabled: o.enabled !== false,
    ts: o.ts || Date.now()
  };
}

function renderPatPage() {
  const body = subShell('拍一拍', `
    <div class="pat-tabs">
      <button class="pat-tab ${patTab === 'user' ? 'active' : ''}" data-pattab="user">我的字卡</button>
      <button class="pat-tab ${patTab === 'ta' ? 'active' : ''}" data-pattab="ta">${esc(taName())}的字卡</button>
    </div>
    <div class="pat-desc muted">我的字卡：双击聊天页${esc(taName())}的头像（顶部头像或${esc(taName())}消息气泡旁的头像）拍${esc(taName())}时使用；${esc(taName())}的字卡：${esc(taName())}主动拍你时使用。拍一拍固定随机显示一张字卡，不参与字卡拼接，也不参与连发条数。</div>
    <div id="patLibBox"></div>
  `);
  $$('[data-pattab]', body).forEach(btn => btn.addEventListener('click', () => {
    patTab = btn.dataset.pattab;
    renderPatPage();
  }));
  renderPatLibBox();
}

function renderPatLibBox() {
  const box = $('#patLibBox');
  if (!box) return;
  const lib = patLib(patTab);
  const kw = (patSearch || '').trim().toLowerCase();
  const list = lib.filter(c => !kw || c.content.toLowerCase().includes(kw));
  const enabledCount = lib.filter(c => c.enabled !== false).length;
  box.innerHTML = `
    <div class="pat-lib-head">
      <div class="pat-lib-stat"><b>${lib.length}</b><span>共 ${enabledCount} 条启用</span></div>
      <div class="pat-lib-btns">
        <button class="mini-btn" data-pat-add>＋ 添加</button>
        <button class="mini-btn" data-pat-import>导入</button>
        <button class="mini-btn" data-pat-export>导出</button>
        <button class="mini-btn" data-pat-dedupe>查重</button>
        <button class="mini-btn danger" data-pat-clear>清空${patTab === 'user' ? '我的' : ''}${patTab === 'ta' ? taName() + '的' : ''}字卡</button>
      </div>
    </div>
    <div class="pat-search-row"><input class="input" id="patSearchInput" placeholder="搜索拍一拍字卡…" value="${esc(patSearch || '')}"></div>
    ${list.length ? `<div class="pat-card-list">${list.map(c => `
      <div class="pat-card-item ${c.enabled === false ? 'off' : ''}">
        <div class="pat-card-text">${esc(c.content)}</div>
        <div class="pat-card-ops">
          <button class="mini-btn" data-pat-toggle="${c.id}">${c.enabled === false ? '启用' : '停用'}</button>
          <button class="mini-btn" data-pat-edit="${c.id}">编辑</button>
          <button class="mini-btn danger" data-pat-del="${c.id}">删除</button>
        </div>
      </div>`).join('')}</div>`
      : `<div class="pat-empty">${kw ? '没有匹配的字卡' : '这个字卡库还是空的，点「＋ 添加」或「导入」开始吧'}</div>`}
  `;
  const searchInput = $('#patSearchInput');
  if (searchInput) searchInput.addEventListener('input', () => {
    patSearch = searchInput.value;
    const pos = searchInput.selectionStart;
    renderPatLibBox();
    const next = $('#patSearchInput');
    if (next) { next.focus({ preventScroll: true }); try { next.setSelectionRange(pos, pos); } catch (e) {} }
  });
  const bindPat = (sel, fn) => { const el = $(sel, box); if (el) el.addEventListener('click', fn); };
  bindPat('[data-pat-add]', () => openPatAddModal());
  bindPat('[data-pat-import]', () => openPatImportModal());
  bindPat('[data-pat-export]', () => {
    downloadJSON(patLib(patTab), patTab === 'user' ? 'pat-cards-user.json' : 'pat-cards-ta.json');
    showToast('已导出拍一拍字卡');
  });
  bindPat('[data-pat-dedupe]', () => patDedupe());
  bindPat('[data-pat-clear]', async () => {
    const libArr = patLib(patTab);
    if (!libArr.length) { showToast('当前分区已经是空的'); return; }
    const title = patTab === 'user' ? '清空我的拍一拍字卡' : `清空${taName()}的拍一拍字卡`;
    const tip = patTab === 'user'
      ? '确定要删除我的全部拍一拍字卡吗？此操作不可恢复。'
      : `确定要删除${taName()}的全部拍一拍字卡吗？此操作不可恢复。`;
    const ok = await confirmDialog(title, tip, '清空', true);
    if (!ok) return;
    libArr.length = 0;
    await persist(true);
    /* 清空后整个分区计数/空态都要更新，走完整 renderPatPage 比只 renderPatLibBox 更稳 */
    renderPatPage();
    showToast('已清空当前分区');
  });
  $$('[data-pat-toggle]', box).forEach(btn => btn.addEventListener('click', () => {
    const c = patLib(patTab).find(x => x.id === btn.dataset.patToggle);
    if (!c) return;
    c.enabled = c.enabled === false;
    persist();
    renderPatLibBox();
  }));
  $$('[data-pat-edit]', box).forEach(btn => btn.addEventListener('click', () => {
    const c = patLib(patTab).find(x => x.id === btn.dataset.patEdit);
    if (c) openPatEditModal(c);
  }));
  $$('[data-pat-del]', box).forEach(btn => btn.addEventListener('click', () => {
    const libArr = patLib(patTab);
    const idx = libArr.findIndex(x => x.id === btn.dataset.patDel);
    if (idx < 0) return;
    confirmDialog('删除字卡', '确定删除这条拍一拍字卡吗？', () => {
      libArr.splice(idx, 1);
      persist();
      renderPatLibBox();
      showToast('已删除');
    });
  }));
}

function patDedupe() {
  const libArr = patLib(patTab);
  const seen = new Map();
  libArr.forEach(c => {
    const k = c.content.trim();
    if (!seen.has(k)) seen.set(k, [c]);
    else seen.get(k).push(c);
  });
  const dupGroups = [];
  seen.forEach(g => { if (g.length > 1) dupGroups.push(g); });
  const dupCount = dupGroups.reduce((n, g) => n + g.length - 1, 0);
  if (!dupCount) { showToast('没有发现重复字卡'); return; }
  showModal({
    title: `发现 ${dupCount} 条重复`,
    body: `<div class="dedupe-list">${dupGroups.map(g => `
      <div class="dedupe-group">
        <div class="dedupe-text">${esc(g[0].content)}</div>
        <div class="muted">重复 ${g.length} 条，将保留 1 条</div>
      </div>`).join('')}</div>`,
    actions: [
      { label: '取消' },
      { label: '一键去重', kind: 'primary', onClick: () => {
          const keepIds = new Set(dupGroups.map(g => g[0].id));
          const libArr2 = patLib(patTab);
          for (let i = libArr2.length - 1; i >= 0; i--) {
            const k = libArr2[i].content.trim();
            let dupOf = null;
            for (const g of dupGroups) if (g[0].content.trim() === k) { dupOf = g[0]; break; }
            if (dupOf && libArr2[i].id !== dupOf.id) libArr2.splice(i, 1);
          }
          persist();
          renderPatLibBox();
          showToast(`已去除 ${dupCount} 条重复`);
          return true;
        } }
    ]
  });
}

function openPatAddModal() {
  showModal({
    title: '添加拍一拍字卡',
    body: `<div class="field"><label>字卡内容（每行一条，可批量添加）</label><textarea class="input" id="patAddText" rows="5" placeholder="每行一条拍一拍文案…"></textarea></div>`,
    actions: [
      { label: '取消' },
      { label: '添加', kind: 'primary', onClick: () => {
          const lines = ($('#patAddText').value || '').split('\n').map(s => s.trim()).filter(Boolean);
          if (!lines.length) { showToast('请输入至少一条内容'); return false; }
          const libArr = patLib(patTab);
          const exist = new Set(libArr.map(c => c.content));
          let added = 0;
          lines.forEach(t => {
            if (exist.has(t)) return;
            exist.add(t);
            libArr.push(normalizePatCard({ content: t }));
            added++;
          });
          persist();
          renderPatLibBox();
          showToast(added ? `已添加 ${added} 条` : '内容已存在，未重复添加');
          return true;
        } }
    ]
  });
}

function openPatEditModal(card) {
  showModal({
    title: '编辑拍一拍字卡',
    body: `<div class="field"><label>字卡内容</label><textarea class="input" id="patEditText" rows="3">${esc(card.content)}</textarea></div>`,
    actions: [
      { label: '取消' },
      { label: '保存', kind: 'primary', onClick: () => {
          const v = ($('#patEditText').value || '').trim();
          if (!v) { showToast('内容不能为空'); return false; }
          card.content = v;
          persist();
          renderPatLibBox();
          showToast('已保存');
          return true;
        } }
    ]
  });
}

function openPatImportModal() {
  showModal({
    title: `导入到「${patTab === 'user' ? '我的' : esc(taName()) + '的'}字卡」`,
    body: `<div class="field"><label>支持两种格式：① 每行一条；② JSON 数组（字符串或含 content 字段的对象）</label><textarea class="input" id="patImportText" rows="7" placeholder='["想你了","抱抱"] 或每行一条…'></textarea></div>`,
    actions: [
      { label: '取消' },
      { label: '导入', kind: 'primary', onClick: () => {
          const raw = ($('#patImportText').value || '').trim();
          if (!raw) { showToast('请输入内容'); return false; }
          let items = [];
          try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) items = parsed.map(x => (x && typeof x === 'object') ? (x.content || x.text || '') : String(x));
          } catch (e) {
            items = raw.split(/\r?\n/);
          }
          items = items.map(s => String(s || '').trim()).filter(Boolean);
          if (!items.length) { showToast('没有可导入的内容'); return false; }
          const libArr = patLib(patTab);
          const exist = new Set(libArr.map(c => c.content));
          let added = 0, skipped = 0;
          items.forEach(t => {
            if (exist.has(t)) { skipped++; return; }
            exist.add(t);
            libArr.push(normalizePatCard({ content: t }));
            added++;
          });
          persist();
          renderPatLibBox();
          showToast(`导入 ${added} 条${skipped ? `，跳过重复 ${skipped} 条` : ''}`);
          return true;
        } }
    ]
  });
}

function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* =========================================================
 * 十四、字卡库（全局共享 + 自定义分组 + 查重）
 * ========================================================= */
let cardFilterGroup = 'all'; // 'all' | ''(未分组) | groupId
let cardSearch = '';
/* 字卡库性能参数：首屏只渲染 100 张，其余用「加载更多」追加；
   渲染走 setTimeout 延迟，先出页面框架再插 DOM，避免进入页面时白屏卡顿 */
const CARD_PAGE_SIZE = 100;
let cardRenderLimit = CARD_PAGE_SIZE;
let cardRenderTimer = null;

function cardGroupById(id) {
  return state.cardGroups.find(g => g.id === id) || null;
}
function cardGroupNameOf(card) {
  const g = cardGroupById(card.groupId);
  return g ? g.name : '未分组';
}
function groupOptionsHTML(selected) {
  return `<option value=""${selected === '' ? ' selected' : ''}>未分组</option>` +
    state.cardGroups.map(g => `<option value="${g.id}"${selected === g.id ? ' selected' : ''}>${esc(g.name)}</option>`).join('');
}

/* 查重用的内容归一化：去首尾空格、忽略大小写 */
function normalizeCardContent(text) {
  return String(text || '').trim().toLowerCase();
}
function findCardDuplicates() {
  const map = {};
  state.cards.forEach(c => {
    const k = normalizeCardContent(c.content);
    if (!k) return;
    (map[k] = map[k] || []).push(c);
  });
  return Object.values(map).filter(list => list.length > 1);
}

/* 简易输入弹窗：分组新建/重命名用；取消 resolve(null)，确定 resolve(trim 后的串) */
function promptDialog(title, placeholder, value = '') {
  return new Promise(resolve => {
    const modal = showModal({
      title,
      body: `<div class="field"><input class="input" id="promptInput" value="${esc(value)}" placeholder="${esc(placeholder)}" maxlength="30"></div>`,
      actions: [
        { label: '取消', onClick: () => resolve(null) },
        { label: '确定', kind: 'primary', onClick: el => resolve($('#promptInput', el).value.trim()) }
      ]
    });
    setTimeout(() => { const i = $('#promptInput', modal.el); if (i) { i.focus({ preventScroll: true }); i.select(); } }, 60);
  });
}

/* 分组 CRUD：名不能为空、不能重名；删除分组时组内字卡回到未分组 */
function createCardGroup(name) {
  const n = String(name || '').trim();
  if (!n) { showToast('分组名称不能为空'); return null; }
  if (state.cardGroups.some(g => g.name === n)) { showToast('已存在同名分组'); return null; }
  const g = { id: uid(), name: n, ts: Date.now() };
  state.cardGroups.push(g);
  persist();
  return g;
}
async function renameCardGroup(id) {
  const g = cardGroupById(id);
  if (!g) return;
  const n = await promptDialog('重命名分组', '输入新的分组名称', g.name);
  if (n === null) return;
  if (!n) { showToast('分组名称不能为空'); return; }
  if (state.cardGroups.some(x => x.id !== id && x.name === n)) { showToast('已存在同名分组'); return; }
  g.name = n;
  persist();
  renderCardsPage();
  showToast('分组已重命名');
}
async function deleteCardGroup(id) {
  const g = cardGroupById(id);
  if (!g) return;
  const count = state.cards.filter(c => c.groupId === id).length;
  const ok = await confirmDialog('删除分组', `删除分组会连同里面的字卡一并删除，此操作不可恢复，确定继续吗？（分组「${g.name}」共 ${count} 张字卡）`, '删除', true);
  if (!ok) return;
  /* 组内字卡随分组一并删除 */
  state.cards = state.cards.filter(c => c.groupId !== id);
  state.cardGroups = state.cardGroups.filter(x => x.id !== id);
  if (cardFilterGroup === id) cardFilterGroup = 'all';
  persist();
  renderCardsPage();
  showToast(count ? `分组及组内 ${count} 张字卡已删除` : '分组已删除');
}

function renderCardsPage() {
  /* 一次性统计：总数 / 启用 / 未分组 / 各分组。
     原来每个分组都要 filter 一遍全库，字卡上千 + 分组几十时会明显卡顿 */
  const groupMap = new Map(state.cardGroups.map(g => [g.id, g]));
  const groupCounts = new Map();
  let enabled = 0;
  let noneCount = 0;
  for (const c of state.cards) {
    if (c.enabled !== false) enabled++;
    if (c.groupId && groupMap.has(c.groupId)) {
      groupCounts.set(c.groupId, (groupCounts.get(c.groupId) || 0) + 1);
    } else {
      noneCount++;
    }
  }
  if (cardFilterGroup !== 'all' && cardFilterGroup !== '' && !groupMap.has(cardFilterGroup)) {
    cardFilterGroup = 'all';
  }
  /* 每次进入页面都从首屏上限重新渲染 */
  cardRenderLimit = CARD_PAGE_SIZE;

  const tabsHTML = [
    `<button class="group-tab ${cardFilterGroup === 'all' ? 'active' : ''}" data-gfilter="all">全部<span class="cnt">${state.cards.length}</span></button>`,
    `<button class="group-tab ${cardFilterGroup === '' ? 'active' : ''}" data-gfilter="">未分组<span class="cnt">${noneCount}</span></button>`,
    ...state.cardGroups.map(g =>
      `<button class="group-tab ${cardFilterGroup === g.id ? 'active' : ''}" data-gfilter="${g.id}">${esc(g.name)}<span class="cnt">${groupCounts.get(g.id) || 0}</span></button>`),
    `<button class="group-tab group-new" id="groupNew">＋ 新建分组</button>`
  ].join('');
  const activeGroup = (cardFilterGroup !== 'all' && cardFilterGroup !== '') ? cardGroupById(cardFilterGroup) : null;

  const body = subShell('字卡库', `
    <div class="top-stat">
      <span>总数 <b>${state.cards.length}</b></span>
      <span>启用 <b id="cardEnabledStat">${enabled}</b></span>
      <span>分组 <b>${state.cardGroups.length}</b></span>
    </div>
    <div class="panel">
      <div class="search-box" style="margin-bottom:8px">
        <span>🔍</span>
        <input id="cardSearch" placeholder="搜索字卡内容或分组名" value="${esc(cardSearch)}">
      </div>
      <div class="group-tabs">${tabsHTML}</div>
      ${activeGroup ? `<div class="group-mini-ops">
        <button id="groupRename">✎ 重命名「${esc(activeGroup.name)}」</button>
        <button class="danger" id="groupDel">删除该分组</button>
      </div>` : ''}
      <div class="btn-row">
        <button class="btn primary" id="cardAdd">＋ 新增字卡</button>
        <button class="btn" id="cardImport">⬆ 批量导入</button>
        <button class="btn" id="cardDedupe">🧹 查重</button>
        <button class="btn" id="cardExport">⬇ 导出</button>
      </div>
      <button class="btn danger block" id="cardClearAll" style="margin-top:10px">🗑 清空全部字卡</button>
      <div class="muted" style="margin-top:8px">抽取规则：从全部启用字卡中随机抽取（字卡全局共享，不再区分梦角与公共）；关闭的字卡不参与随机。</div>
    </div>
    <div id="cardList"></div>`);

  /* 搜索：60ms 防抖，避免每敲一个字就把整库过滤 + 重建 DOM */
  $('#cardSearch').addEventListener('input', e => {
    cardSearch = e.target.value;
    cardRenderLimit = CARD_PAGE_SIZE;
    scheduleCardList(60);
  });
  /* 分组标签：在容器上一次性委托，不再为每个分组按钮单独绑定 */
  const groupTabs = $('.group-tabs', body);
  if (groupTabs) groupTabs.addEventListener('click', e => {
    const btn = e.target.closest('[data-gfilter]');
    if (!btn) return;
    cardFilterGroup = btn.dataset.gfilter;
    renderCardsPage();
  });
  $('#groupNew').addEventListener('click', async () => {
    const name = await promptDialog('新建分组', '输入分组名称');
    if (name === null) return;
    const g = createCardGroup(name);
    if (g) { cardFilterGroup = g.id; renderCardsPage(); showToast(`分组「${g.name}」已创建`); }
  });
  if (activeGroup) {
    $('#groupRename').addEventListener('click', () => renameCardGroup(activeGroup.id));
    $('#groupDel').addEventListener('click', () => deleteCardGroup(activeGroup.id));
  }
  $('#cardAdd').addEventListener('click', () => openCardEditor(null));
  $('#cardImport').addEventListener('click', () => openCardImport());
  $('#cardDedupe').addEventListener('click', openCardDedupe);
  $('#cardExport').addEventListener('click', exportCards);
  /* 一键清空主字卡库：二次确认；只清 state.cards，不影响拍一拍字卡库 / 表情包 / 聊天记录等其它数据 */
  $('#cardClearAll').addEventListener('click', async () => {
    if (!state.cards.length) { showToast('字卡库已经是空的'); return; }
    const ok = await confirmDialog('清空全部字卡', '确定要删除全部字卡吗？此操作不可恢复。', '删除', true);
    if (!ok) return;
    state.cards = [];
    persist(true);
    renderCardsPage();
    showToast('已清空全部字卡');
  });
  bindCardListEvents();
  /* 页面框架先出现，50ms 后再插入字卡 DOM：进入页面不再被上千张字卡阻塞 */
  scheduleCardList(50);
}

function renderCardList() {
  const box = $('#cardList');
  if (!box) return;
  const q = cardSearch.trim().toLowerCase();
  /* 分组名一次建表，避免每张卡都去 state.cardGroups.find 一遍 */
  const groupNames = new Map(state.cardGroups.map(g => [g.id, g.name || '未分组']));
  const groupNameOf = c => (c.groupId && groupNames.has(c.groupId)) ? groupNames.get(c.groupId) : '未分组';

  const list = state.cards.filter(c => {
    if (cardFilterGroup !== 'all') {
      if (cardFilterGroup === '') {
        if (c.groupId && groupNames.has(c.groupId)) return false;
      } else if (c.groupId !== cardFilterGroup) return false;
    }
    if (!q) return true;
    const text = String(c.content || '').toLowerCase();
    return text.includes(q) || groupNameOf(c).toLowerCase().includes(q);
  }).sort((a, b) => (b.ts || 0) - (a.ts || 0));

  if (!list.length) {
    box.innerHTML = '<div class="empty">没有符合条件的字卡<br>新增或导入一些吧</div>';
    return;
  }

  /* 只渲染前 cardRenderLimit 张：卡片 DOM 保持扁平（去掉多余包裹层） */
  const shown = list.slice(0, cardRenderLimit);
  let html = shown.map(c => `
    <div class="card-item${c.enabled === false ? ' disabled' : ''}">
      <span class="chip card-tag">${esc(groupNameOf(c))}</span>
      <div class="card-text">${esc(c.content)}</div>
      <div class="card-ops">
        <label class="switch"><input type="checkbox" data-toggle="${c.id}"${c.enabled !== false ? ' checked' : ''}><span class="slider"></span></label>
        <span class="muted">启用</span>
        <span class="spacer"></span>
        <button class="btn-sm" data-edit="${c.id}">编辑</button>
        <button class="btn-sm" data-del="${c.id}">删除</button>
      </div>
    </div>`).join('');
  const rest = list.length - shown.length;
  if (rest > 0) {
    html += `<button class="btn block card-more" id="cardMoreBtn" type="button">加载更多（还有 ${rest} 张）</button>`;
  }
  box.innerHTML = html;
}

/* 列表事件委托：只在 #cardList 上绑一次 click / change，
   几百上千张字卡也只有两个监听器，不会再为每张卡片单独 addEventListener */
function bindCardListEvents() {
  const box = $('#cardList');
  if (!box) return;
  box.addEventListener('click', e => {
    const more = e.target.closest('#cardMoreBtn');
    if (more) {
      cardRenderLimit += CARD_PAGE_SIZE;
      renderCardList();
      return;
    }
    const editBtn = e.target.closest('[data-edit]');
    if (editBtn) { openCardEditor(editBtn.dataset.edit); return; }
    const delBtn = e.target.closest('[data-del]');
    if (delBtn) { deleteCardById(delBtn.dataset.del); return; }
  });
  /* change 会冒泡，开关同样只绑这一次 */
  box.addEventListener('change', e => {
    const input = e.target.closest('[data-toggle]');
    if (!input) return;
    const card = state.cards.find(c => c.id === input.dataset.toggle);
    if (!card) return;
    card.enabled = input.checked;
    /* 原地更新这一张卡，不再重建整个列表 */
    const item = input.closest('.card-item');
    if (item) item.classList.toggle('disabled', !input.checked);
    const stat = $('#cardEnabledStat');
    if (stat) stat.textContent = state.cards.filter(c => c.enabled !== false).length;
    persist();
  });
}

/* 删除确认抽成独立函数，避免每张字卡各生成一个闭包 */
async function deleteCardById(cardId) {
  const card = state.cards.find(c => c.id === cardId);
  if (!card) return;
  const ok = await confirmDialog('删除字卡', '确定删除这张字卡吗？', '删除', true);
  if (!ok) return;
  state.cards = state.cards.filter(c => c.id !== card.id);
  persist();
  renderCardsPage();
  showToast('已删除');
}

/* 异步渲染入口：先让页面框架出现，再插字卡 DOM；
   离开字卡库后 #cardList 不存在，直接放弃这次渲染 */
function scheduleCardList(delay = 50) {
  clearTimeout(cardRenderTimer);
  cardRenderTimer = setTimeout(() => {
    cardRenderTimer = null;
    if (!$('#cardList')) return;
    renderCardList();
  }, delay);
}

function openCardEditor(cardId) {
  const card = state.cards.find(c => c.id === cardId);
  const editing = !!card;
  const data = card || {
    content: '',
    groupId: (cardFilterGroup !== 'all') ? cardFilterGroup : '',
    enabled: true
  };
  const modal = showModal({
    title: editing ? '编辑字卡' : '新增字卡',
    wide: true,
    body: `
      <div class="field">
        <label>字卡内容</label>
        <textarea class="textarea" id="cardContent" style="min-height:100px" placeholder="写一句${esc(taName())}会说的话…">${esc(data.content)}</textarea>
      </div>
      <div class="field">
        <label>分组</label>
        <div style="display:flex;gap:8px">
          <select class="select" id="cardGroup" style="flex:1">${groupOptionsHTML(data.groupId || '')}</select>
          <button class="btn" id="cardGroupNew" style="flex-shrink:0">＋ 新建</button>
        </div>
      </div>
      <div class="field row-between">
        <label style="margin:0">启用这张字卡</label>
        <label class="switch"><input type="checkbox" id="cardEnabled" ${data.enabled !== false ? 'checked' : ''}><span class="slider"></span></label>
      </div>`,
    actions: [
      { label: '取消' },
      {
        label: '保存', kind: 'primary', onClick: el => {
          const content = $('#cardContent', el).value.trim();
          if (!content) { showToast('字卡内容不能为空'); return false; }
          const norm = normalizeCardContent(content);
          const dup = state.cards.find(c => c.id !== cardId && normalizeCardContent(c.content) === norm);
          if (dup) { showToast('已存在相同字卡，未重复添加'); return false; }
          const payload = {
            content,
            groupId: $('#cardGroup', el).value,
            enabled: $('#cardEnabled', el).checked
          };
          if (editing) Object.assign(card, payload);
          else state.cards.push(Object.assign({ id: uid(), ts: Date.now() }, payload));
          persist();
          renderCardsPage();
          showToast(editing ? '字卡已更新' : '字卡已添加');
          return true;
        }
      }
    ],
    onMount: el => {
      $('#cardGroupNew', el).addEventListener('click', async () => {
        const name = await promptDialog('新建分组', '输入分组名称');
        if (name === null) return;
        const g = createCardGroup(name);
        if (g) {
          $('#cardGroup', el).innerHTML = groupOptionsHTML(g.id);
          showToast(`分组「${g.name}」已创建`);
        }
      });
    }
  });
  setTimeout(() => { const ta = $('#cardContent', modal.el); if (ta) ta.focus({ preventScroll: true }); }, 60);
}

function openCardImport() {
  showModal({
    title: '批量导入字卡',
    wide: true,
    body: `
      <div class="field">
        <label>每行一张字卡（空行自动忽略）；也可粘贴 / 读取 JSON：数组、对象数组（支持 content / group / enabled 字段）、{&quot;cards&quot;:[…]}，以及回信库导出文件（含 customReplies / customReplyGroups）</label>
        <textarea class="textarea" id="impText" style="min-height:140px" placeholder="我在呢，慢慢说。&#10;今天也辛苦了。&#10;[{&quot;content&quot;:&quot;想你&quot;,&quot;group&quot;:&quot;心动&quot;}]"></textarea>
      </div>
      <div class="btn-row" style="margin-top:-2px">
        <button class="btn" id="impFile">📁 从文件读取（.txt / .json，支持 BOM）</button>
      </div>
      <div class="field">
        <label>导入到分组（JSON 中自带 group 时优先，分组不存在会自动创建）</label>
        <select class="select" id="impGroup">${groupOptionsHTML('')}</select>
      </div>
      <div class="field">
        <label>遇到重复字卡时（去首尾空格、忽略大小写判定）</label>
        <select class="select" id="impDupMode">
          <option value="skip" selected>跳过（保留已有字卡）</option>
          <option value="overwrite">覆盖（更新已有字卡的分组与启用状态）</option>
        </select>
      </div>
      <div class="imp-progress" id="impProgress"></div>`,
    actions: [
      { label: '取消' },
      {
        label: '开始导入', kind: 'primary', onClick: async el => {
          const progress = $('#impProgress', el);
          let items;
          try {
            items = parseCardImport($('#impText', el).value);
          } catch (e) {
            progress.innerHTML = `<span style="color:#ff5a5f">解析失败：${esc(e.message)}</span>`;
            showToast('导入失败：' + e.message);
            return false;
          }
          if (!items.length) {
            progress.innerHTML = '<span style="color:#ff5a5f">没有识别到可导入的内容</span>';
            showToast('没有识别到可导入的内容');
            return false;
          }
          progress.textContent = '准备导入…';
          const res = await runCardImport(items, $('#impGroup', el).value, $('#impDupMode', el).value, progress);
          persist();
          renderCardsPage();
          setTimeout(() => showImportResult(res), 220);
          return true;
        }
      }
    ],
    onMount: el => {
      $('#impFile', el).addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.txt,.json,text/plain,application/json';
        input.style.display = 'none';
        document.body.appendChild(input);
        input.addEventListener('change', async () => {
          const file = input.files && input.files[0];
          input.remove();
          if (!file) return;
          try {
            $('#impText', el).value = await file.text();
            showToast('文件已读取，请点「开始导入」');
          } catch (e) {
            showToast('读取文件失败');
          }
        });
        input.click();
      });
    }
  });
}

/* 解析导入文本：
 * 1) 先剥离 UTF-8 BOM（含开头和文中残留的 BOM 字符）；
 * 2) 以 [ 或 { 开头视为 JSON，严格解析，失败直接抛出明确错误（绝不静默、绝不回退成按行解析导致只导入一部分）；
 *    支持格式：字符串数组、对象数组、{"cards":[…]}、{"字卡":[…]}、{"list":[…]}、{"data":[…]}，以及单个对象；
 *    条目内容字段优先级：content → text → 内容；分组字段：group → 分组；无分组归入未分组；
 * 3) 其他文本按行分割（\r\n / \n / \r 均正确），空行忽略、每行首尾空格 trim。
 * 返回统一条目数组 {content, group, enabled}；无有效内容的对象条目带 __error，由 runCardImport 计入失败并标明序号。 */
function parseCardImport(text) {
  const raw = String(text == null ? '' : text).replace(/^\uFEFF/, '').replace(/\uFEFF/g, '').trim();
  if (!raw) return [];

  if (raw.startsWith('[') || raw.startsWith('{')) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      throw new Error('JSON 格式不正确，请检查是否为合法数组或对象数组');
    }
    let arr = null;
    if (Array.isArray(data)) {
      arr = data;
    } else if (data && typeof data === 'object') {
      if (Array.isArray(data.cards)) arr = data.cards;
      else if (Array.isArray(data['字卡'])) arr = data['字卡'];
      else if (Array.isArray(data.list)) arr = data.list;
      else if (Array.isArray(data.data)) arr = data.data;
      else if (typeof data.content === 'string' || typeof data.text === 'string' || typeof data['内容'] === 'string') arr = [data];
    }
    if (!arr && data && typeof data === 'object') {
      const libItems = parseReplyLibrary(data);
      if (libItems) return libItems;
    }
    if (!arr) throw new Error('JSON 结构不支持：需要数组、对象数组、{"cards":[…]} / {"字卡":[…]}，或回信库导出文件（含 customReplies / customReplyGroups）');
    return arr.map(normalizeImportItem);
  }

  return raw.split(/\r\n|\r|\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => ({ content: line, group: '', enabled: true }));
}

/* 兼容「回信库」导出格式（reply-library-*.json）：
 * 顶层为对象，含 customReplies（纯字符串数组）与/或 customReplyGroups（[{name, items:[字符串], disabled}]）。
 * customReplies → 未分组字卡；分组 items → 按分组名归档；分组 disabled 时对应字卡导入为停用状态。
 * 该格式中分组条目同时存在于 customReplies 里，故先收分组条目、再补未出现在任何分组的扁平条目，
 * 避免同一内容被先导入成未分组、导致分组信息丢失（两种查重模式下都能保留分组）。
 * 其余模块（表情、拍一拍、签名、状态等）不属于字卡，忽略。无法识别时返回 null。 */
function parseReplyLibrary(data) {
  const flat = Array.isArray(data.customReplies) ? data.customReplies : null;
  const groups = Array.isArray(data.customReplyGroups) ? data.customReplyGroups : null;
  if (!flat && !groups) return null;
  const items = [];
  const grouped = new Set();
  (groups || []).forEach(g => {
    if (!g || typeof g !== 'object' || !Array.isArray(g.items)) return;
    const name = typeof g.name === 'string' ? g.name.trim() : '';
    const enabled = g.disabled !== true;
    g.items.forEach(x => {
      if (typeof x !== 'string' || !x.trim()) return;
      grouped.add(normalizeCardContent(x));
      items.push({ content: x.trim(), group: name, enabled });
    });
  });
  (flat || []).forEach(x => {
    if (typeof x !== 'string' || !x.trim()) return;
    if (grouped.has(normalizeCardContent(x))) return;
    items.push({ content: x.trim(), group: '', enabled: true });
  });
  return items;
}

/* 把 JSON 的单个条目规范化为 {content, group, enabled}；无法取出内容的条目带 __error 标记 */
function normalizeImportItem(x) {
  const textOf = v => (typeof v === 'string' ? v.trim() : '');
  if (typeof x === 'string') {
    const c = x.trim();
    return c ? { content: c, group: '', enabled: true } : { content: '', group: '', enabled: true, __error: '内容为空' };
  }
  if (!x || typeof x !== 'object') {
    return { content: '', group: '', enabled: true, __error: '不是字符串或对象' };
  }
  const content = textOf(x.content) || textOf(x.text) || textOf(x['内容']);
  const groupRaw = x.group != null ? x.group : x['分组'];
  const group = typeof groupRaw === 'string' ? groupRaw.trim() : '';
  if (!content) return { content: '', group, enabled: x.enabled !== false, __error: '缺少 content / text / 内容 字段' };
  return { content, group, enabled: x.enabled !== false };
}

/* 分批导入（每批 200 条，让出主线程，避免大量字卡卡死页面）。
 * 自动查重：默认跳过重复；overwrite 模式更新已有字卡。
 * 返回 { total, ok, skip, fail, failList }，failList 记录失败序号与原因。 */
async function runCardImport(items, targetGroupId, dupMode, progressEl) {
  const CHUNK = 200;
  const existing = new Map();
  state.cards.forEach(c => existing.set(normalizeCardContent(c.content), c));
  const res = { total: items.length, ok: 0, skip: 0, fail: 0, failList: [] };
  const markFail = (index, reason) => {
    res.fail++;
    if (res.failList.length < 12) res.failList.push({ index, reason });
  };
  for (let i = 0; i < items.length; i += CHUNK) {
    const batch = items.slice(i, i + CHUNK);
    for (let j = 0; j < batch.length; j++) {
      const item = batch[j];
      const index = i + j + 1;
      try {
        if (item.__error) { markFail(index, item.__error); continue; }
        const content = String(item.content || '').trim();
        if (!content) { markFail(index, '内容为空'); continue; }
        let groupId = targetGroupId || '';
        if (item.group) {
          const found = state.cardGroups.find(g => g.name === item.group);
          if (found) groupId = found.id;
          else {
            const created = createCardGroup(item.group);
            groupId = created ? created.id : '';
          }
        }
        const norm = normalizeCardContent(content);
        const dup = existing.get(norm);
        if (dup) {
          if (dupMode === 'overwrite') {
            dup.groupId = groupId;
            dup.enabled = item.enabled !== false;
            res.ok++;
          } else {
            res.skip++;
          }
          continue;
        }
        const card = { id: uid(), content, groupId, enabled: item.enabled !== false, ts: Date.now() + res.ok };
        state.cards.push(card);
        existing.set(norm, card);
        res.ok++;
      } catch (e) {
        markFail(index, (e && e.message) || '单条数据异常');
      }
    }
    if (progressEl) progressEl.textContent = `正在导入… ${Math.min(i + CHUNK, items.length)} / ${items.length}`;
    await new Promise(r => setTimeout(r, 0));
  }
  return res;
}

function showImportResult(res) {
  const failDetail = res.fail && res.failList && res.failList.length
    ? `<div style="margin-top:6px;font-size:12px;color:#ff5a5f;line-height:1.7">${res.failList.map(f => `第 ${f.index} 条：${esc(f.reason)}`).join('<br>')}${res.fail > res.failList.length ? `<br>…其余 ${res.fail - res.failList.length} 条同类问题` : ''}</div>`
    : '';
  showModal({
    title: '导入完成',
    body: `<p class="modal-text" style="margin-top:0">共识别 <b>${res.total}</b> 条：<br>
      ✅ 成功导入 <b>${res.ok}</b> 条<br>
      ⏭ 跳过重复 <b>${res.skip}</b> 条<br>
      ❌ 失败 <b>${res.fail}</b> 条</p>${failDetail}`,
    actions: [{ label: '完成', kind: 'primary' }]
  });
}

/* 查重：列出重复组，支持一键保留第一张或手动选择保留哪张 */
function openCardDedupe() {
  const dups = findCardDuplicates();
  if (!dups.length) { showToast('没有发现重复字卡'); return; }
  const extra = dups.reduce((n, g) => n + g.length - 1, 0);
  const groupsHTML = dups.map((list, gi) => `
    <div class="dup-group">
      <div class="dup-content">${esc(list[0].content)}</div>
      <div class="muted" style="font-size:11px;margin:3px 0 5px">共 ${list.length} 张重复，勾选要保留的一张：</div>
      ${list.map((c, ci) => `
        <label class="dup-item">
          <input type="radio" name="dup_${gi}" value="${c.id}" ${ci === 0 ? 'checked' : ''}>
          <span class="txt">${esc(cardGroupNameOf(c))} · ${new Date(c.ts || Date.now()).toLocaleDateString()}</span>
        </label>`).join('')}
    </div>`).join('');

  const doClean = async ids => {
    const ok = await confirmDialog('清理重复字卡', `将删除 ${ids.size} 张重复字卡，无法恢复，确定吗？`, '删除', true);
    if (!ok) return false;
    state.cards = state.cards.filter(c => !ids.has(c.id));
    persist();
    renderCardsPage();
    showToast(`已删除 ${ids.size} 张重复字卡`);
    return true;
  };

  showModal({
    title: '字卡查重',
    wide: true,
    body: `
      <p class="modal-text" style="margin-top:0">发现 <b>${dups.length}</b> 组重复，共 <b>${extra}</b> 张多余字卡。</p>
      <div style="max-height:44vh;overflow-y:auto">${groupsHTML}</div>`,
    actions: [
      { label: '取消' },
      {
        label: '每组保留第一张', onClick: () => {
          const ids = new Set();
          dups.forEach(list => list.slice(1).forEach(c => ids.add(c.id)));
          return doClean(ids);
        }
      },
      {
        label: '按选择清理', kind: 'danger', onClick: el => {
          const keep = new Set();
          $$('input[type=radio]:checked', el).forEach(r => keep.add(r.value));
          const ids = new Set();
          dups.forEach(list => list.forEach(c => { if (!keep.has(c.id)) ids.add(c.id); }));
          if (!ids.size) { showToast('没有要删除的字卡'); return false; }
          return doClean(ids);
        }
      }
    ]
  });
}

function exportCards() {
  const data = state.cards.map(c => {
    const g = cardGroupById(c.groupId);
    return {
      content: c.content,
      group: g ? g.name : '',
      enabled: c.enabled !== false
    };
  });
  downloadJSON(data, `字卡库-${todayKey()}.json`);
  showToast('字卡 JSON 已导出');
}

/* =========================================================
 * 十六、表情包管理
 * ========================================================= */
function renderStickersPage() {
  subShell('表情包管理', `
    <div class="top-stat"><span>共 <b>${state.stickers.length}</b> 个表情</span></div>
    <div class="panel">
      <div class="row-between">
        <div class="muted">支持本地上传（自动压缩）或填写图片链接。</div>
        <div class="sticker-actions">
          <button class="btn" id="stickerBatchBtn">批量导入</button>
          <button class="btn primary" id="stickerAdd">＋ 添加</button>
        </div>
      </div>
    </div>
    ${state.stickers.length
      ? `<div class="sticker-manage-grid">${state.stickers.map(s => `
          <div class="sticker-card">
            <div class="thumb" data-preview="${s.id}"><img src="${esc(s.data)}" alt=""></div>
            <div class="nm">${esc(s.name)}</div>
            <div style="display:flex;justify-content:space-between;margin-top:5px">
              <button class="btn-sm" data-sticker-edit="${s.id}">改名</button>
              <button class="btn-sm" data-sticker-del="${s.id}" style="color:#ff5a5f">删除</button>
            </div>
          </div>`).join('')}</div>`
      : '<div class="empty">还没有表情包<br>添加后即可在聊天面板发送</div>'}`);

  $('#stickerAdd').addEventListener('click', () => openStickerEditor(null));
  /* 批量导入按钮：唤起常驻的多选输入框 */
  $('#stickerBatchBtn').addEventListener('click', () => {
    const input = $('#stickerBatchInput');
    if (!input) return;
    input.value = '';   /* 清空旧值，允许连续两次选择同一批文件 */
    input.click();
  });
  $$('[data-preview]').forEach(el => el.addEventListener('click', () => {
    const s = state.stickers.find(x => x.id === el.dataset.preview);
    if (s) showLightbox(s.data);
  }));
  $$('[data-sticker-edit]').forEach(btn => btn.addEventListener('click', () => openStickerEditor(btn.dataset.stickerEdit)));
  $$('[data-sticker-del]').forEach(btn => btn.addEventListener('click', async () => {
    const s = state.stickers.find(x => x.id === btn.dataset.stickerDel);
    if (!s) return;
    const ok = await confirmDialog('删除表情', `确定删除「${s.name}」吗？`, '删除', true);
    if (!ok) return;
    state.stickers = state.stickers.filter(x => x.id !== s.id);
    persist();
    renderStickersPage();
    showToast('已删除');
  }));
}

/* ===== 表情包批量导入 ===== */
/* 压缩单张图片：等比缩放到最大边 maxWidth，再转 JPEG(0.7) 的 Base64，回调返回 dataURL 或 null */
function compressImage(file, maxWidth, callback) {
  const max = Math.max(1, Number(maxWidth) || 200);
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width || 1, img.height || 1));
      const w = Math.max(1, Math.round((img.width || 1) * scale));
      const h = Math.max(1, Math.round((img.height || 1) * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      /* JPEG 不支持透明，先铺白底，避免透明区域变成黑块 */
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      callback(canvas.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = () => callback(null);
    img.src = reader.result;
  };
  reader.onerror = () => callback(null);
  reader.readAsDataURL(file);
}

/* Promise 版压缩：供 async/await 串行调用，保证一张处理完再处理下一张 */
function compressImageAsync(file, maxWidth) {
  return new Promise(resolve => compressImage(file, maxWidth, resolve));
}

/* 批量导入期间的全局 Loading 遮罩 */
let stickerLoadingEl = null;
function showStickerLoading(text) {
  hideStickerLoading();
  const el = document.createElement('div');
  el.className = 'sticker-loading';
  el.id = 'stickerLoading';
  el.innerHTML = `<div class="st-loading-box"><span class="st-loading-spin"></span><span>${esc(text)}</span></div>`;
  document.body.appendChild(el);
  stickerLoadingEl = el;
}
function hideStickerLoading() {
  if (stickerLoadingEl && stickerLoadingEl.parentNode) stickerLoadingEl.parentNode.removeChild(stickerLoadingEl);
  stickerLoadingEl = null;
}

/* 批量入库：一次性写盘；容量不足时回滚这批表情并给出专项提示，避免内存与落盘不一致 */
async function saveStickerBatch(added) {
  const before = state.stickers.slice();
  state.stickers = before.concat(added);
  try {
    let ok = true;
    if (Storage.mode === 'local') {
      /* localStorage 兜底模式：同步写入，QuotaExceededError 可以被 try-catch 精准捕获 */
      localStorage.setItem(STATE_KEY, JSON.stringify(state));
    } else {
      /* IndexedDB 模式：走统一的分表落盘（图片写入 assets 表），返回失败则回滚 */
      ok = await persist(true);
    }
    if (!ok) throw new Error('storage-write-failed');
    return true;
  } catch (err) {
    state.stickers = before;                 /* 回滚：列表与本地数据保持一致 */
    showToast('存储空间不足，请删除部分旧表情包后再试');
    if (currentRoute && currentRoute.page === 'sub' && currentRoute.name === 'stickers') renderStickersPage();
    return false;
  }
}

/* 批量导入主流程：逐张读取并压缩（最大边 200px / JPEG 0.7），全部完成后统一入库 */
async function importStickerFiles(files) {
  const list = Array.from(files || []);
  if (!list.length) return;
  showStickerLoading('正在批量导入表情包...');
  const added = [];
  for (let i = 0; i < list.length; i++) {   /* 串行 for + await：绝不同时压缩多张，避免浏览器卡死 */
    const file = list[i];
    if (!/^image\//.test(file.type)) continue;
    const data = await compressImageAsync(file, 200);
    if (!data) continue;
    const rawName = String(file.name || '').replace(/\.(png|jpg|jpeg|gif|webp|bmp|heic)$/i, '').trim();
    const name = (rawName || '表情').slice(0, 20);
    added.push({ id: uid(), name, data, ts: Date.now() });
  }
  hideStickerLoading();
  if (!added.length) {
    showToast('没有可导入的图片');
    return;
  }
  const ok = await saveStickerBatch(added);
  if (!ok) return;                          /* 失败提示已在保存函数内给出 */
  if (currentRoute && currentRoute.page === 'sub' && currentRoute.name === 'stickers') renderStickersPage();
  showToast(`成功导入了 ${added.length} 张表情包`);
}

function openStickerEditor(id) {
  const sticker = state.stickers.find(s => s.id === id);
  const modal = showModal({
    title: sticker ? '编辑表情' : '添加表情包',
    body: `
      <div style="text-align:center;margin-bottom:10px" id="stPreviewBox">
        ${sticker ? `<img src="${esc(sticker.data)}" style="max-height:110px;border-radius:10px" alt="">` : '<div class="empty" style="padding:12px">还没有选择图片</div>'}
      </div>
      <div class="field">
        <label>名称</label>
        <input class="input" id="stName" value="${esc(sticker ? sticker.name : '')}" placeholder="例如：抱抱">
      </div>
      <div class="field">
        <label>图片 URL（也可从本地选择）</label>
        <input class="input" id="stUrl" value="${sticker && sticker.data.startsWith('http') ? esc(sticker.data) : ''}" placeholder="https://…">
      </div>
      <div class="btn-row">
        <button class="btn" id="stUpload">📁 本地图片</button>
        <button class="btn" id="stUseUrl">使用该链接</button>
      </div>`,
    actions: [
      { label: '取消' },
      {
        label: '保存', kind: 'primary', onClick: el => {
          const data = $('#stUrl', el).value.trim();
          const name = $('#stName', el).value.trim() || '表情';
          if (!data) { showToast('请选择图片或填写图片链接'); return false; }
          if (sticker) {
            sticker.name = name;
            sticker.data = data;
          } else {
            state.stickers.push({ id: uid(), name, data, ts: Date.now() });
          }
          persist();
          renderStickersPage();
          showToast('表情已保存');
          return true;
        }
      }
    ],
    onMount: el => {
      const preview = $('#stPreviewBox', el);
      const urlInput = $('#stUrl', el);
      const paint = () => {
        const v = urlInput.value.trim();
        preview.innerHTML = v
          ? `<img src="${esc(v)}" style="max-height:110px;border-radius:10px" alt="">`
          : '<div class="empty" style="padding:12px">还没有选择图片</div>';
      };
      urlInput.addEventListener('input', paint);
      $('#stUpload', el).addEventListener('click', async () => {
        const data = await pickImage(300, .82);
        if (data) { urlInput.value = data; paint(); }
      });
      $('#stUseUrl', el).addEventListener('click', paint);
      if (sticker) urlInput.value = sticker.data;
    }
  });
  return modal;
}

/* =========================================================
 * 十七、信件管理
 * ========================================================= */
/* TA回信时间选项（分钟，0 = 立即几秒后） */
const REPLY_DELAY_OPTIONS = [
  [0, '立即（几秒后）'],
  [1, '1 分钟'],
  [5, '5 分钟'],
  [30, '30 分钟'],
  [60, '1 小时'],
  [360, '6 小时'],
  [720, '12 小时'],
  [1440, '1 天'],
  [4320, '3 天'],
  [-1, '自定义（分钟）']
];

function replyDelayOptionsHTML(selected, allowCustom = true) {
  return REPLY_DELAY_OPTIONS.filter(([v]) => allowCustom || v !== -1).map(([v, label]) =>
    `<option value="${v}"${Number(selected) === v ? ' selected' : ''}>${label}</option>`).join('');
}

function letterStatusChip(l) {
  const isTa = l.sender === 'ta';
  if (isTa) {
    /* TA 主动来信：待查看 / 已读 / 已回复，绝不显示「已回信」 */
    if (l.status === 'userReplied' || l.userReplyContent) return '<span class="letter-status st-replied">已回复</span>';
    if (!l.read) return '<span class="letter-status st-pending">待查看</span>';
    return '<span class="letter-status">已读</span>';
  }
  if (l.status === 'pendingReply') return '<span class="letter-status st-pending">等待回信</span>';
  if (l.status === 'replied') return '<span class="letter-status st-replied">已回信</span>';
  return '<span class="letter-status">草稿</span>';
}

/* 到点生成 TA 回信：统一使用信件页的全局拼接设置；空库兜底 */
function genLetterReply(letter) {
  /* 只有「我写的信」才会收到 TA 回信；TA 主动来信不进入此流程 */
  if (!letter || letter.sender === 'ta') return;
  const st = state.settings;
  const text = composeCardText(letter.roleId, {
    mergeMin: st.letterMergeMin,
    mergeMax: st.letterMergeMax,
    mergeSeparator: st.letterMergeSeparator,
    key: 'letter:' + letter.id
  });
  letter.taReplyContent = text || '最近有点忙，等我有空再好好回你。';
  letter.taReplyAt = Date.now();
  letter.status = 'replied';
  letter.read = false;
  letter.isNotified = false; /* 新到的回信：允许发一次来信通知 */
}

/* 来信系统通知：默认开启、无独立开关；isNotified 去重，避免刷新后重复弹窗 */
function notifyLetterArrived(letter) {
  if (!letter || letter.isNotified === true) return;
  letter.isNotified = true;
  notifyDefaultEvent('收到新信件', 'TA 给你寄来了一封信，快去看看吧！', 'letter-' + letter.id, { page: 'sub', name: 'letters' });
}

function checkLetterReplies() {
  if (!state || !Array.isArray(state.letters)) return;
  const now = Date.now();
  let changed = false;
  const arrived = [];
  state.letters.forEach(l => {
    /* 只处理我寄出、且尚未回信的信件 */
    if (l.sender === 'ta') return;
    if (l.status === 'pendingReply' && l.replyDueAt && l.replyDueAt <= now) {
      genLetterReply(l);
      arrived.push(l);
      changed = true;
    }
  });
  if (changed) {
    persist();
    arrived.forEach(notifyLetterArrived);
    if (currentRoute.page === 'sub' && currentRoute.name === 'letters') renderLettersPage();
    if (currentRoute.page === 'contacts') renderContactsPage();
    showToast(taName() + '回信了，去信件管理看看吧');
  }
}

/* 主动写信：按设定间隔自动生成一封 TA 来信，正文用信件专属拼接规则从字卡库抽取。
 * 下次写信时间写在 state.nextAutoLetterAt，随 state 一起持久化（IndexedDB / localStorage）。
 * force = true 时忽略开关，用于手动测试。 */
function checkAutoLetters(force) {
  if (!state || !Array.isArray(state.letters)) return false;
  const st = state.settings;
  if (!st.letterAutoEnabled && !force) return false;

  const now = Date.now();
  const gapMs = clamp(Math.round(Number(st.letterAutoInterval) || 1440), 1, 10080) * 60 * 1000;
  const next = Number(state.nextAutoLetterAt);

  /* 时间戳缺失（旧数据迁移 / 刚开启没写时间戳）：视为已到期，立即补发一封 */
  if (!Number.isFinite(next) || next <= 0) {
    state.nextAutoLetterAt = now;
  }
  if (!force && now < state.nextAutoLetterAt) return false;
  /* 先推进下一次时间，避免生成过程中异常导致每 15 秒重复发信 */
  state.nextAutoLetterAt = now + gapMs;

  const role = roleById(state.activeRoleId) || state.roles[0];
  if (!role) { persist(); return false; }

  let text = '';
  try {
    text = composeCardText('auto-letter:' + role.id, {
      mergeMin: st.letterMergeMin, mergeMax: st.letterMergeMax, mergeSeparator: st.letterMergeSeparator,
      key: 'autoLetter:' + role.id
    });
  } catch (err) { text = ''; }

  const letter = {
    id: uid(),
    title: '来自' + role.name + '的信',
    body: '',
    date: todayKey(),
    roleId: role.id,
    sender: 'ta',            /* TA 主动写来的信 */
    read: false,
    ts: now,
    status: 'inbox',         /* 待查看：绝不标记为已回信 */
    sentAt: now,
    replyDueAt: 0,           /* 不进入 TA 回信队列 */
    taReplyContent: text || '想你了，所以写了这封信。',
    taReplyAt: now,
    fromTa: true,
    isNotified: false
  };
  state.letters.push(letter);
  persist();

  /* 通知、渲染都做容错，任何一步失败都不能挡住信件写入与列表刷新 */
  try { notifyLetterArrived(letter); } catch (err) { /* 忽略 */ }
  try {
    if (currentRoute.page === 'sub' && currentRoute.name === 'letters') renderLettersPage();
    if (currentRoute.page === 'contacts') renderContactsPage();
    if (currentRoute.page === 'home') renderHomePage();   /* 刷新桌面「信件」红点 */
  } catch (err) { /* 忽略 */ }
  try { showToast(role.name + '给你写了一封信'); } catch (err) { /* 忽略 */ }
  return true;
}

function renderLettersPage() {
  const unread = state.letters.filter(l => !l.read).length;
  const list = state.letters.slice().sort((a, b) => b.ts - a.ts);
  const s = state.settings;
  const sepOpts = [['，', '逗号（，）'], ['、', '顿号（、）'], [' ', '空格'], ['\n', '换行'], ['', '无']]
    .map(p => `<option value="${p[0] === '\n' ? '&#10;' : p[0]}"${s.letterMergeSeparator === p[0] ? ' selected' : ''}>${p[1]}</option>`)
    .join('');
  subShell('信件管理', `
    <div class="top-stat"><span>共 <b>${state.letters.length}</b> 封</span><span>未读 <b>${unread}</b> 封</span></div>
    <div class="panel">
      <div class="panel-title">信件设置</div>
      <div class="slider-row row-between">
        <div>
          <div style="font-size:13px">主动写信</div>
          <div class="muted" id="letterAutoNote">开启后 ${esc(taName())} 每隔 ${s.letterAutoInterval} 分钟自动写一封信放进信件列表</div>
        </div>
        <label class="switch"><input type="checkbox" id="setLetterAuto" ${s.letterAutoEnabled ? 'checked' : ''}><span class="slider"></span></label>
      </div>
      <div id="letterAutoWrap"${s.letterAutoEnabled ? '' : ' class="range-off"'}>
        ${sliderRowHTML('写信间隔', '单位：分钟；下次写信时间会持久化，刷新后接着算', 'letterAutoInterval', s.letterAutoInterval, 1, 10080, '分钟')}
      </div>
      <div style="margin-top:14px;font-size:13px;font-weight:600">信件拼接设置（全局）</div>
      <div class="muted" style="margin-top:2px">只需设置一次即可全局生效：你写信触发的回信、${esc(taName())}主动写来的信，正文都按这里的规则拼接字卡。</div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <select class="select" id="letterMergeMin" style="flex:1">
          ${[1, 2, 3, 4, 5, 6].map(n => `<option value="${n}"${s.letterMergeMin === n ? ' selected' : ''}>最少 ${n} 张</option>`).join('')}
        </select>
        <select class="select" id="letterMergeMax" style="flex:1">
          ${[1, 2, 3, 4, 5, 6].map(n => `<option value="${n}"${s.letterMergeMax === n ? ' selected' : ''}>最多 ${n} 张</option>`).join('')}
        </select>
      </div>
      <select class="select" id="letterMergeSep" style="margin-top:8px">${sepOpts}</select>
    </div>
    <div class="panel row-between">
      <div class="muted">写给${esc(taName())}的信，寄出后${esc(taName())}会按间隔回信。</div>
      <button class="btn primary" id="letterNew">＋ 写新信件</button>
    </div>
    ${list.length ? list.map(l => {
      const role = roleById(l.roleId);
      const to = role ? role.name : '未指定收件人';
      const isTa = l.sender === 'ta';
      /* TA 主动来信的正文在 taReplyContent；我写的信回信后预览才显示 TA 的回信 */
      const preview = isTa
        ? (l.taReplyContent || l.body)
        : (l.status === 'replied' && l.taReplyContent ? (role ? role.name : 'TA') + '：' + l.taReplyContent : l.body);
      return `
        <div class="letter-item ${l.read ? '' : 'unread'}" data-letter="${l.id}">
          <div class="letter-head">
            <div class="letter-title">${l.read ? '' : '🔵 '}${esc(l.title)}</div>
            ${letterStatusChip(l)}
            <span class="chip">${isTa ? '来自 ' : '致 '}${esc(to)}</span>
          </div>
          <div class="letter-preview">${esc(String(preview || '').slice(0, 60))}</div>
          <div class="letter-meta">
            <span>${esc(l.date || '')} · ${l.read ? '已读' : '未读'}</span>
            <span style="display:flex;gap:8px">
              <button class="btn-sm" data-letter-toggle="${l.id}">${l.read ? '标为未读' : '标为已读'}</button>
              <button class="btn-sm" data-letter-del="${l.id}" style="color:#ff5a5f">删除</button>
            </span>
          </div>
        </div>`;
    }).join('') : '<div class="empty">还没有信件<br>写一封给' + esc(taName()) + '的信吧</div>'}`);

  $('#letterNew').addEventListener('click', () => navigate({ page: 'sub', name: 'letter-new' }));

  /* 信件页设置：主动写信开关/间隔 + 信件全局拼接 */
  bindProbSlider('letterAutoInterval', 'letterAutoIntervalRange', 'letterAutoIntervalNum', 1, 10080);
  syncLetterAutoInputs();
  updateLetterAutoNote();
  $('#setLetterAuto').addEventListener('change', e => {
    state.settings.letterAutoEnabled = e.target.checked;
    /* 开启时从当前时刻重新计时，避免旧时间戳已过期导致立刻连发 */
    state.nextAutoLetterAt = e.target.checked
      ? Date.now() + clamp(Number(state.settings.letterAutoInterval) || 1440, 1, 10080) * 60000
      : 0;
    persist();
    syncLetterAutoInputs();
  });
  const onLetterMergeChange = () => {
    let lo = clamp(parseInt($('#letterMergeMin').value, 10) || 1, 1, 6);
    let hi = clamp(parseInt($('#letterMergeMax').value, 10) || lo, 1, 6);
    if (lo > hi) hi = lo;
    state.settings.letterMergeMin = lo;
    state.settings.letterMergeMax = hi;
    state.settings.letterMergeSeparator = $('#letterMergeSep').value;
    $('#letterMergeMax').value = String(hi);
    persist();
  };
  ['letterMergeMin', 'letterMergeMax', 'letterMergeSep'].forEach(id => {
    $('#' + id).addEventListener('change', onLetterMergeChange);
  });

  $$('[data-letter]').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('[data-letter-toggle]') || e.target.closest('[data-letter-del]')) return;
      openLetter(el.dataset.letter);
    });
  });
  $$('[data-letter-toggle]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const l = state.letters.find(x => x.id === btn.dataset.letterToggle);
      if (!l) return;
      l.read = !l.read;
      persist();
      renderLettersPage();
    });
  });
  $$('[data-letter-del]').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const l = state.letters.find(x => x.id === btn.dataset.letterDel);
      if (!l) return;
      const ok = await confirmDialog('删除信件', `确定删除「${l.title}」吗？`, '删除', true);
      if (!ok) return;
      state.letters = state.letters.filter(x => x.id !== l.id);
      persist();
      renderLettersPage();
      showToast('信件已删除');
    });
  });
}

function openLetter(id) {
  const letter = state.letters.find(l => l.id === id);
  if (!letter) return;
  /* 打开即视为已读（TA 主动来信由此从「待查看」变为「已读」） */
  if (!letter.read) {
    letter.read = true;
    persist();
    if (currentRoute.page === 'sub' && currentRoute.name === 'letters') renderLettersPage();
    if (currentRoute.page === 'contacts') renderContactsPage();
  }
  const role = roleById(letter.roleId);
  const roleName = role ? role.name : 'TA';
  const isTaLetter = letter.sender === 'ta';
  /* 我写的信：展示 TA 的回信 / 等待提示；TA 主动来信：展示我的回复 */
  const replyBlock = isTaLetter
    ? (letter.userReplyContent
        ? `<div class="letter-reply" style="background:#f2f7ff">
            <div class="letter-reply-head">${esc(state.my.name)}的回复 · ${fmtListTime(letter.userReplyAt)}</div>
            <div>${esc(letter.userReplyContent)}</div>
            <div class="letter-sign">—— ${esc(state.my.name)}</div>
          </div>`
        : '')
    : letter.status === 'replied' && letter.taReplyContent
      ? `<div class="letter-reply">
        <div class="letter-reply-head">${roleAvatarHTML(role || { avatar: '💌', theme: '' }, 26)} ${esc((role && role.name) || taName())}的回信 · ${fmtListTime(letter.taReplyAt)}</div>
        <div>${esc(letter.taReplyContent)}</div>
        <div class="letter-sign">—— ${esc(roleName)}</div>
      </div>`
      : letter.status === 'pendingReply'
        ? `<div class="letter-reply" style="background:#f7f8fa;color:#8b909a">信件已寄出，等待${esc(taName(letter.roleId))}回信…</div>`
        : '';

  const actions = [];
  if (isTaLetter) {
    actions.push({
      label: letter.userReplyContent ? '再次回复' : '回复', kind: 'primary',
      onClick: () => { openTaLetterReply(letter); }
    });
  }
  actions.push({
    label: '删除', kind: 'danger', onClick: async () => {
      const ok = await confirmDialog('删除信件', '删除后无法恢复，确定吗？', '删除', true);
      if (!ok) return false;
      state.letters = state.letters.filter(l => l.id !== letter.id);
      persist();
      if (currentRoute.page === 'sub' && currentRoute.name === 'letters') renderLettersPage();
      if (currentRoute.page === 'contacts') renderContactsPage();
      showToast('信件已删除');
      return true;
    }
  });
  actions.push({ label: '关闭', kind: isTaLetter ? '' : 'primary' });

  const modal = showModal({
    title: (letter.status === 'replied' || letter.status === 'userReplied') ? '往来信件' : (isTaLetter ? '来信' : '信件'),
    wide: true,
    body: `
      <div class="muted" style="margin-bottom:10px">${isTaLetter ? '来自' : '致'} ${esc(role ? role.name : '未指定')} · ${esc(letter.date || '')}</div>
      <div style="font-size:17px;font-weight:600;margin-bottom:10px">${esc(letter.title)}</div>
      <div class="letter-body" style="box-shadow:none;padding:0">${esc(isTaLetter ? (letter.taReplyContent || letter.body) : letter.body)}</div>
      <div class="letter-sign">—— ${esc(isTaLetter ? roleName : state.my.name)}<br>${esc(letter.date || '')}</div>
      ${replyBlock}`,
    actions
  });
  return modal;
}

/* 回复 TA 主动来信：只更新原信并标记「已回复」，不进入 TA 回信定时队列 */
function openTaLetterReply(letter) {
  if (!letter) return;
  const role = roleById(letter.roleId);
  showModal({
    title: '回复' + (role ? ' ' + role.name : ' ' + taName()),
    body: `
      <div class="muted" style="margin-bottom:8px">回复《${esc(letter.title)}》</div>
      <div class="field" style="margin:0">
        <label>想说的话</label>
        <textarea class="textarea" id="taLetterReplyInput" style="min-height:130px" placeholder="写下你想说的话…">${esc(letter.userReplyContent || '')}</textarea>
      </div>`,
    actions: [
      { label: '取消' },
      {
        label: '发送回复', kind: 'primary',
        onClick: () => {
          const input = $('#taLetterReplyInput');
          const text = input ? input.value.trim() : '';
          if (!text) { showToast('请先写下想说的话'); return false; }
          letter.userReplyContent = text;
          letter.userReplyAt = Date.now();
          letter.status = 'userReplied';   /* 沟通闭环结束 */
          letter.replyDueAt = 0;           /* 明确不触发 TA 回信定时器 */
          letter.read = true;
          persist();
          if (currentRoute.page === 'sub' && currentRoute.name === 'letters') renderLettersPage();
          if (currentRoute.page === 'contacts') renderContactsPage();
          showToast('回复已发送');
          return true;
        }
      }
    ]
  });
}

function renderLetterNewPage() {
  const roles = state.roles;
  const body = subShell('写新信件', `
    <div class="panel">
      <div class="field">
        <label>标题</label>
        <input class="input" id="letterTitle" maxlength="60" placeholder="例如：写给今晚的你">
      </div>
      <div class="field">
        <label>收件梦角</label>
        <select class="select" id="letterRole">
          ${roles.map(r => `<option value="${r.id}"${r.id === state.activeRoleId ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>日期</label>
        <input class="input" type="date" id="letterDate" value="${new Date().toISOString().slice(0, 10)}">
      </div>
      <div class="field">
        <label>正文</label>
        <textarea class="textarea" id="letterBody" style="min-height:170px" placeholder="写下想对${esc(taName())}说的话…"></textarea>
      </div>
      <div class="field">
        <label>${esc(taName())}回信时间</label>
        <select class="select" id="letterDelay">
          ${replyDelayOptionsHTML(5)}
        </select>
        <input class="input hidden" id="letterDelayCustom" type="number" min="1" max="10080" placeholder="输入分钟数（1~10080）" style="margin-top:8px">
        <div class="muted" style="margin-top:4px">寄出后${esc(taName())}会在该时间后回信；每封信独立计时、互不影响，你可以随时连续寄出多封。</div>
      </div>

      <div class="btn-row">
        <button class="btn ghost" id="letterSave" style="flex:1">保存草稿</button>
        <button class="btn primary" id="letterSend" style="flex:1">寄出 ✉️</button>
      </div>
    </div>`);

  $('#letterDelay').addEventListener('change', e => {
    $('#letterDelayCustom').classList.toggle('hidden', e.target.value !== '-1');
  });

  const readForm = () => {
    const title = $('#letterTitle').value.trim();
    const bodyText = $('#letterBody').value.trim();
    const roleId = $('#letterRole').value;
    const date = $('#letterDate').value || todayKey();
    if (!title) { showToast('请填写标题'); return null; }
    if (!bodyText) { showToast('正文不能为空'); return null; }
    return { title, bodyText, roleId, date };
  };

  const readDelayMin = () => {
    const sel = $('#letterDelay').value;
    if (sel === '-1') {
      const v = parseInt($('#letterDelayCustom').value, 10);
      if (!Number.isFinite(v) || v < 1 || v > 10080) {
        showToast('请输入 1~10080 之间的分钟数');
        return null;
      }
      return v;
    }
    return parseInt(sel, 10);
  };

  $('#letterSave').addEventListener('click', () => {
    const f = readForm();
    if (!f) return;
    state.letters.push({
      id: uid(),
      title: f.title,
      body: f.bodyText,
      date: f.date,
      roleId: f.roleId,
      sender: 'user',          /* 我写的信 */
      read: true,
      ts: Date.now(),
      status: 'draft',
      sentAt: 0,
      replyDueAt: 0,
      taReplyContent: '',
      taReplyAt: 0
    });
    persist();
    showToast('信件已保存为草稿');
    goBack();
  });

  $('#letterSend').addEventListener('click', () => {
    const f = readForm();
    if (!f) return;
    const delayMin = readDelayMin();
    if (delayMin === null) return;
    const now = Date.now();
    /* 立即 = 几秒后，便于测试 */
    const due = delayMin === 0 ? now + randInt(4, 9) * 1000 : now + delayMin * 60 * 1000;
    state.letters.push({
      id: uid(),
      title: f.title,
      body: f.bodyText,
      date: f.date,
      roleId: f.roleId,
      sender: 'user',          /* 我写的信 */
      read: true,
      ts: now,
      status: 'pendingReply',
      sentAt: now,
      replyDueAt: due,
      taReplyContent: '',
      taReplyAt: 0
    });
    persist();
    showToast(delayMin === 0 ? '信件已寄出，' + taName() + '马上回信' : '信件已寄出，等待' + taName() + '回信');
    goBack();
  });
}

/* =========================================================
 * 十八、聊天问卷
 * ========================================================= */
let quizDraft = null;
let quizTargetRole = null;

/* 题目「作答模式」归一化（保存 / 读取历史模板时统一走这里）：
 * 新结构：selectMode('fixed'|'random') + fixedCount + randomMin + randomMax；
 * 兼容旧数据：pick / selectCount / maxSelect 一律转为固定选择数量 */
function quizQuestionNormalize(q) {
  const src = q || {};
  const options = (Array.isArray(src.options) ? src.options : []).map(o => String(o)).filter(Boolean);
  const maxN = Math.max(1, options.length);
  const legacy = Number(
    src.selectCount != null ? src.selectCount
      : (src.maxSelect != null ? src.maxSelect : src.pick)
  ) || 1;
  const selectMode = src.selectMode === 'random' ? 'random' : 'fixed';
  const fixedCount = clamp(Math.round(Number(src.fixedCount != null ? src.fixedCount : legacy)) || 1, 1, maxN);
  let randomMin = clamp(Math.round(Number(src.randomMin)) || 1, 1, maxN);
  let randomMax = clamp(Math.round(Number(src.randomMax)) || Math.min(3, maxN), 1, maxN);
  if (randomMax < randomMin) randomMax = randomMin;
  return {
    text: String(src.text || src.question || ''),
    options,
    selectMode,
    fixedCount,
    randomMin,
    randomMax
  };
}

/* 编辑器草稿版：保留空选项输入框（归一化会过滤空串，不能直接用） */
function quizQuestionInit(q) {
  const src = q || {};
  const options = Array.isArray(src.options) && src.options.length ? src.options.slice() : ['', ''];
  const maxN = Math.max(1, options.length);
  const legacy = Number(
    src.selectCount != null ? src.selectCount
      : (src.maxSelect != null ? src.maxSelect : src.pick)
  ) || 1;
  let randomMin = clamp(Math.round(Number(src.randomMin)) || 1, 1, maxN);
  let randomMax = clamp(Math.round(Number(src.randomMax)) || Math.min(3, maxN), 1, maxN);
  if (randomMax < randomMin) randomMax = randomMin;
  return {
    text: String(src.text || ''),
    options,
    selectMode: src.selectMode === 'random' ? 'random' : 'fixed',
    fixedCount: clamp(Math.round(Number(src.fixedCount != null ? src.fixedCount : legacy)) || 1, 1, maxN),
    randomMin,
    randomMax
  };
}

function renderQuizzesPage() {
  const list = state.quizTemplates.slice().sort((a, b) => b.ts - a.ts);
  subShell('问卷模板', `
    <div class="top-stat"><span>共 <b>${list.length}</b> 个模板</span></div>
    <div class="panel row-between">
      <div class="muted">模板可重复发送，${esc(taName())}会按每题设定的作答模式勾选选项。</div>
      <button class="btn primary" id="quizNew">＋ 新建问卷</button>
    </div>
    ${list.length ? list.map(t => `
      <div class="tpl-item">
        <div class="row-between">
          <div style="font-size:15px;font-weight:600">${esc(t.title)}</div>
          <button class="btn-sm" data-qexpand="${t.id}">展开</button>
        </div>
        <div class="muted" style="margin-top:4px">${t.questions.length} 个问题 · ${fmtListTime(t.ts)}</div>
        <div class="tpl-q-list" data-qlist="${t.id}">
          ${t.questions.map((q, i) => `<div>${i + 1}. ${esc(q.text)}<br><span style="color:#b0b5be">选项：${q.options.map(esc).join(' / ')}</span></div>`).join('')}
        </div>
        <div class="btn-row" style="margin-top:9px">
          <button class="btn-sm" data-qsend="${t.id}">发送给${esc(taName())}</button>
          <button class="btn-sm" data-qdel="${t.id}" style="color:#ff5a5f">删除</button>
        </div>
      </div>`).join('') : '<div class="empty">还没有问卷模板<br>新建一个，或从聊天页直接创建</div>'}`);

  $('#quizNew').addEventListener('click', () => {
    pendingQuizRoleId = state.activeRoleId;
    navigate({ page: 'sub', name: 'quiz-new' });
  });
  $$('[data-qexpand]').forEach(btn => btn.addEventListener('click', () => {
    const box = $(`[data-qlist="${btn.dataset.qexpand}"]`);
    if (!box) return;
    box.classList.toggle('open');
    btn.textContent = box.classList.contains('open') ? '收起' : '展开';
  }));
  $$('[data-qsend]').forEach(btn => btn.addEventListener('click', () => {
    const tpl = state.quizTemplates.find(t => t.id === btn.dataset.qsend);
    if (tpl) sendTemplateDialog(tpl);
  }));
  $$('[data-qdel]').forEach(btn => btn.addEventListener('click', async () => {
    const tpl = state.quizTemplates.find(t => t.id === btn.dataset.qdel);
    if (!tpl) return;
    const ok = await confirmDialog('删除模板', `确定删除「${tpl.title}」吗？`, '删除', true);
    if (!ok) return;
    state.quizTemplates = state.quizTemplates.filter(t => t.id !== tpl.id);
    persist();
    renderQuizzesPage();
    showToast('模板已删除');
  }));
}

function sendTemplateDialog(tpl) {
  showModal({
    title: '发送问卷',
    body: `
      <div class="field">
        <label>发给</label>
        <select class="select" id="tplRole">
          ${state.roles.map(r => `<option value="${r.id}"${r.id === state.activeRoleId ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}
        </select>
      </div>
      <p class="muted">发送后${esc(taName())}会按每题的作答模式（固定选择 / 随机范围）勾选选项，并逐题回复。</p>`,
    actions: [
      { label: '取消' },
      {
        label: '发送', kind: 'primary', onClick: el => {
          const rid = $('#tplRole', el).value;
          sendQuizToChat(JSON.parse(JSON.stringify(tpl)), rid);
          return true;
        }
      }
    ]
  });
}

function renderQuizNewPage() {
  quizTargetRole = pendingQuizRoleId || state.activeRoleId || (state.roles[0] && state.roles[0].id);
  const fromChat = !!pendingQuizRoleId;
  pendingQuizRoleId = null;
  quizDraft = { title: '', questions: [quizQuestionInit({ text: '', options: ['', ''] })] };

  subShell('新建问卷', '<div id="quizEditor"></div>',
    /* 标题栏右侧：从问卷编辑器里一键进入模板库 —— 桌面图标已迁移到此入口 */
    `<button class="qz-tpl-btn" id="qzOpenTpls" type="button">模板</button>`
  );
  $('#qzOpenTpls').addEventListener('click', openQuizTemplatePicker);
  const box = $('#quizEditor');
  box.addEventListener('input', onQuizInput);
  box.addEventListener('change', onQuizChange);
  box.addEventListener('click', onQuizClick);
  renderQuizEditorInner();
  box.dataset.fromChat = fromChat ? '1' : '';
}

/* 问卷编辑页里的模板速选弹窗：加载进编辑器 / 直接发送 / 进入完整模板列表 */
function openQuizTemplatePicker() {
  const list = state.quizTemplates.slice().sort((a, b) => b.ts - a.ts);
  const bodyHTML = `
    <div class="muted" style="margin-bottom:10px;font-size:12.5px">共 ${list.length} 个模板 · 选一个加载到当前编辑器，或直接发送</div>
    ${list.length ? list.map(t => `
      <div class="qz-tpl-row" data-tpl="${t.id}">
        <div class="qz-tpl-title">${esc(t.title)}</div>
        <div class="qz-tpl-meta muted">${t.questions.length} 题 · ${fmtListTime(t.ts)}</div>
        <div class="qz-tpl-actions">
          <button class="btn-sm" data-tpl-load="${t.id}">加载到编辑器</button>
          <button class="btn-sm" data-tpl-send="${t.id}">直接发送</button>
        </div>
      </div>`).join('') : `<div class="empty-hint">还没有问卷模板<br>保存一次问卷即可生成模板</div>`}
    ${list.length ? `<div style="margin-top:14px;text-align:center"><button class="btn ghost" id="qzGotoTplsBtn" style="font-size:12.5px">进入完整模板列表</button></div>` : ''}`;
  showModal({
    title: '问卷模板',
    body: bodyHTML,
    actions: [{ label: '关闭' }],
    onMount: root => {
      if (!list.length) {
        const addBtn = root.querySelector('#qzGotoTplsBtn');
        if (addBtn) addBtn.addEventListener('click', () => {
          root.remove();
          navigate({ page: 'sub', name: 'quizzes' });
        });
        return;
      }
      root.querySelectorAll('[data-tpl-load]').forEach(btn => btn.addEventListener('click', () => {
        const tpl = state.quizTemplates.find(t => t.id === btn.dataset.tplLoad);
        if (!tpl) return;
        quizDraft = JSON.parse(JSON.stringify({
          title: tpl.title,
          questions: tpl.questions.map(q => quizQuestionInit(q))
        }));
        root.remove();
        renderQuizEditorInner();
        showToast(`已加载「${tpl.title}」`);
      }));
      root.querySelectorAll('[data-tpl-send]').forEach(btn => btn.addEventListener('click', () => {
        const tpl = state.quizTemplates.find(t => t.id === btn.dataset.tplSend);
        if (!tpl) return;
        root.remove();
        sendTemplateDialog(tpl);
      }));
      const goBtn = root.querySelector('#qzGotoTplsBtn');
      if (goBtn) goBtn.addEventListener('click', () => {
        root.remove();
        navigate({ page: 'sub', name: 'quizzes' });
      });
    }
  });
}

function renderQuizEditorInner() {
  const box = $('#quizEditor');
  if (!box) return;
  box.innerHTML = `
    <div class="panel">
      <div class="field">
        <label>问卷标题</label>
        <input class="input" id="quizTitle" value="${esc(quizDraft.title)}" placeholder="例如：今晚的小问卷">
      </div>
      <div class="field">
        <label>发送给</label>
        <select class="select" id="quizTarget">
          ${state.roles.map(r => `<option value="${r.id}"${r.id === quizTargetRole ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}
        </select>
      </div>
    </div>
    ${quizDraft.questions.map((q, qi) => `
      <div class="q-block">
        <div class="q-head">
          <span class="idx">${qi + 1}</span>
          <input class="input q-text" data-qtext="${qi}" value="${esc(q.text)}" placeholder="问题，例如：今天想我了吗">
        </div>
        ${q.options.map((opt, oi) => `
          <div class="opt-row">
            <input class="input opt-input" data-qi="${qi}" data-oi="${oi}" value="${esc(opt)}" placeholder="选项 ${oi + 1}">
            <button class="del" data-opt-del="${qi}" data-oi-del="${oi}">✕</button>
          </div>`).join('')}
        <div class="q-actions">
          <button class="btn-sm" data-opt-add="${qi}">＋ 选项</button>
          ${quizDraft.questions.length > 1 ? `<button class="btn-sm" data-qdel="${qi}" style="color:#ff5a5f">删除问题</button>` : ''}
        </div>
        <div style="display:flex;align-items:center;gap:6px;margin-top:8px">
          <span class="muted" style="font-size:12px;flex:none">作答模式：</span>
          <div class="qz-mode-tabs">
            <button class="qz-mode-tab${q.selectMode === 'random' ? '' : ' active'}" type="button" data-qmode="fixed" data-qi-mode="${qi}">固定选择</button>
            <button class="qz-mode-tab${q.selectMode === 'random' ? ' active' : ''}" type="button" data-qmode="random" data-qi-mode="${qi}">随机范围</button>
          </div>
        </div>
        <div class="qz-count-row">
          ${q.selectMode === 'random' ? `
            <span class="qz-count-text">在</span>
            <input class="input qz-num" type="number" inputmode="numeric" min="1" max="${Math.max(1, q.options.length)}" value="${clamp(Math.round(Number(q.randomMin) || 1), 1, Math.max(1, q.options.length))}" data-qrand-min="${qi}">
            <span class="qz-count-text">到</span>
            <input class="input qz-num" type="number" inputmode="numeric" min="1" max="${Math.max(1, q.options.length)}" value="${clamp(Math.round(Number(q.randomMax) || Math.min(3, Math.max(1, q.options.length))), 1, Math.max(1, q.options.length))}" data-qrand-max="${qi}">
            <span class="qz-count-text">个之间随机</span>` : `
            <span class="qz-count-text">选</span>
            <input class="input qz-num" type="number" inputmode="numeric" min="1" max="${Math.max(1, q.options.length)}" value="${clamp(Math.round(Number(q.fixedCount) || 1), 1, Math.max(1, q.options.length))}" data-qfixed="${qi}">
            <span class="qz-count-text">个选项</span>`}
        </div>
      </div>`).join('')}
    <button class="btn block" id="quizAddQ">＋ 添加问题</button>
    <div class="btn-row" style="margin-top:12px">
      <button class="btn ghost" id="quizSaveTpl" style="flex:1">保存为模板</button>
      <button class="btn primary" id="quizSend" style="flex:1">直接发送</button>
    </div>`;
}

function onQuizInput(e) {
  const t = e.target;
  if (!quizDraft) return;
  if (t.id === 'quizTitle') quizDraft.title = t.value;
  else if (t.hasAttribute('data-qtext')) quizDraft.questions[Number(t.dataset.qtext)].text = t.value;
  else if (t.hasAttribute('data-qfixed')) {
    const q = quizDraft.questions[Number(t.dataset.qfixed)];
    if (q) q.fixedCount = Math.max(1, parseInt(t.value, 10) || 1);
  } else if (t.hasAttribute('data-qrand-min')) {
    const q = quizDraft.questions[Number(t.dataset.qrandMin)];
    if (q) q.randomMin = Math.max(1, parseInt(t.value, 10) || 1);
  } else if (t.hasAttribute('data-qrand-max')) {
    const q = quizDraft.questions[Number(t.dataset.qrandMax)];
    if (q) q.randomMax = Math.max(1, parseInt(t.value, 10) || 1);
  }
  else if (t.hasAttribute('data-oi')) {
    quizDraft.questions[Number(t.dataset.qi)].options[Number(t.dataset.oi)] = t.value;
  }
}

function onQuizChange(e) {
  if (e.target.id === 'quizTarget') quizTargetRole = e.target.value;
}

function onQuizClick(e) {
  const btn = e.target.closest('button');
  if (!btn || !quizDraft) return;

  if (btn.id === 'quizAddQ') {
    quizDraft.questions.push(quizQuestionInit({ text: '', options: ['', ''] }));
    renderQuizEditorInner();
    return;
  }
  if (btn.hasAttribute('data-qmode')) {
    const qi = Number(btn.dataset.qiMode);
    const q = quizDraft.questions[qi];
    if (!q) return;
    q.selectMode = btn.dataset.qmode === 'random' ? 'random' : 'fixed';
    /* 切换模式时把数量字段夹到当前选项数范围内，再重绘出对应的输入框 */
    quizDraft.questions[qi] = quizQuestionInit(q);
    renderQuizEditorInner();
    return;
  }
  if (btn.hasAttribute('data-opt-add')) {
    const qi = Number(btn.dataset.optAdd);
    quizDraft.questions[qi].options.push('');
    quizDraft.questions[qi] = quizQuestionInit(quizDraft.questions[qi]);
    renderQuizEditorInner();
    return;
  }
  if (btn.hasAttribute('data-opt-del')) {
    const qi = Number(btn.dataset.optDel);
    const oi = Number(btn.dataset.oiDel);
    const opts = quizDraft.questions[qi].options;
    if (opts.length > 1) opts.splice(oi, 1);
    quizDraft.questions[qi] = quizQuestionInit(quizDraft.questions[qi]);
    renderQuizEditorInner();
    return;
  }
  if (btn.hasAttribute('data-qdel')) {
    quizDraft.questions.splice(Number(btn.dataset.qdel), 1);
    renderQuizEditorInner();
    return;
  }
  if (btn.id === 'quizSaveTpl') {
    const quiz = collectQuiz();
    if (!quiz) return;
    state.quizTemplates.push({ id: uid(), title: quiz.title, questions: quiz.questions, ts: Date.now() });
    persist();
    showToast('问卷模板已保存');
    return;
  }
  if (btn.id === 'quizSend') {
    const quiz = collectQuiz();
    if (!quiz) return;
    const rid = quizTargetRole || state.activeRoleId;
    sendQuizToChat(quiz, rid);
    return;
  }
}

function collectQuiz() {
  if (!quizDraft) return null;
  const title = quizDraft.title.trim();
  if (!title) { showToast('请填写问卷标题'); return null; }
  const questions = quizDraft.questions
    .map(q => {
      const options = q.options.map(o => o.trim()).filter(Boolean);
      const maxN = Math.max(1, options.length);
      const selectMode = q.selectMode === 'random' ? 'random' : 'fixed';
      const fixedCount = clamp(Math.round(Number(q.fixedCount) || 1), 1, maxN);
      let randomMin = clamp(Math.round(Number(q.randomMin) || 1), 1, maxN);
      let randomMax = clamp(Math.round(Number(q.randomMax) || Math.min(3, maxN)), 1, maxN);
      if (randomMax < randomMin) randomMax = randomMin;
      return {
        text: q.text.trim(),
        options,
        selectMode,
        fixedCount,
        randomMin,
        randomMax
      };
    })
    .filter(q => q.text && q.options.length);
  if (!questions.length) { showToast('至少填写一个问题，并添加选项'); return null; }
  return { title, questions };
}

/* =========================================================
 * 一起玩（三级结构的二级页：一起做 → 一起玩 → 五子棋）
 * 返回键走默认 goBack：由【一起做】navigate 进入，弹栈自然回到一起做
 * ========================================================= */
function renderPlayPage() {
  const body = subShell('一起玩', `
    <div class="panel">
      <button class="game-entry" id="playGomoku">
        <span class="ge-ic">${APP_ICONS.gomoku}</span>
        <span class="ge-info"><b>五子棋</b><span class="muted">黑白对弈 · 和 ${esc(taName())} 下一局</span></span>
        <span class="ge-go">›</span>
      </button>
    </div>
    <div class="muted" style="text-align:center;margin-top:10px">更多小游戏筹备中…</div>`);
  $('#playGomoku', body).addEventListener('click', () => navigate({ page: 'sub', name: 'gomoku' }));
}

/* =========================================================
 * 五子棋（15x15 · 三档对局态度 AI · 内置互动台词 · 0.5~1s 模拟思考）
 * ========================================================= */
const GMK_N = 15;
/* 对局态度：默认宠溺模式 */
const GMK_ATTITUDES = {
  serious: { label: '认真模式', note: '全力以赴，是对你最大的尊重。' },
  pet: { label: '宠溺模式', note: '赢不赢不重要，你开心最重要。' },
  casual: { label: '随性模式', note: '随便下下，主打一个陪伴。' }
};
/* 全部互动台词均为内置预设，不从字卡库抽取 */
const GMK_LINES = {
  good: ['这步下得不错嘛！', '居然被你发现了！', '好险好险，差点就输了'],
  bad: ['哎呀，你怎么下那里呀？', '这步棋，我可不客气了哦'],
  water: ['咳，刚才走神了', '哎呀，我没看清那里', '刚才手滑了'],
  aboutWin: ['可恶，要输了吗？', '让让你好啦'],
  undo: ['怎么，想反悔呀？', '不许耍赖哦~', '拿你没办法，悔吧悔吧'],
  winMe: ['还是你厉害，我认输啦。', '恭喜你赢啦，想要什么奖励？'],
  winTa: ['承让啦，下次我要认真了。', '嘿嘿，这局我拿下咯。'],
  draw: ['势均力敌，这局不分高下，再来一局？']
};
const gmk = {
  board: [],        /* 0 空 / 1 黑 / 2 白；黑棋先行 */
  myColor: 1,       /* 玩家执子颜色，每局可切换 */
  turn: 1,
  over: false,
  thinking: false,
  last: null,       /* [x, y] 最后一手（红点标记） */
  gen: 0,           /* 渲染代际：离开页面/重开后使旧的延迟回调失效 */
  attitude: 'pet',  /* 对局态度：serious / pet / casual */
  history: [],      /* 落子顺序，悔棋用 */
  undoLeft: 3,      /* 每局悔棋次数 */
  watered: false,   /* 本次 TA 落子是否故意放水 */
  result: null,     /* 'me' / 'ta' / 'draw'：重新进入页面时恢复结算卡片 */
  resultSpeech: '',
  bubbleTimer: null
};

function gmkNewBoard() { return Array.from({ length: GMK_N }, () => Array(GMK_N).fill(0)); }
function gmkTaColor() { return gmk.myColor === 1 ? 2 : 1; }
function gmkReset(keepColor) {
  gmk.board = gmkNewBoard();
  gmk.turn = 1;
  gmk.over = false;
  gmk.thinking = false;
  gmk.last = null;
  gmk.history = [];
  gmk.undoLeft = 3;
  gmk.watered = false;
  gmk.result = null;
  gmk.resultSpeech = '';
  if (gmk.bubbleTimer) { clearTimeout(gmk.bubbleTimer); gmk.bubbleTimer = null; }
  if (!keepColor) gmk.myColor = 1;
}

function renderGomokuPage() {
  gmk.gen++;
  /* 首次进入时初始化棋盘（模块加载时 board 为空数组，避免 gmkDraw 读空） */
  if (!Array.isArray(gmk.board) || gmk.board.length !== GMK_N) gmkReset(true);
  /* 离开页面时可能残留“思考中”状态：回到页面后由下面重新调度 TA 落子 */
  gmk.thinking = false;
  const role = roleById(state.activeRoleId) || state.roles[0];
  const att = GMK_ATTITUDES[gmk.attitude] || GMK_ATTITUDES.pet;
  const body = subShell('五子棋', `
    <div class="gmk-wrap">
      <div class="gmk-att">
        <div class="gmk-att-guide">你想要 TA 用什么态度来陪你下棋？</div>
        <div class="gmk-att-opts">
          ${Object.keys(GMK_ATTITUDES).map(k =>
            `<button class="gmk-att-btn ${gmk.attitude === k ? 'active' : ''}" data-gmkatt="${k}">${GMK_ATTITUDES[k].label}</button>`).join('')}
        </div>
        <div class="gmk-att-note" id="gmkAttNote">${esc(att.note)}</div>
      </div>
      <div class="gmk-status" id="gmkStatus"></div>
      <div class="gmk-ta">
        <span class="gmk-ava">${role ? roleAvatarHTML(role, 30) : avatarHTML('🙂', 30)}</span>
        <div class="gmk-bubble" id="gmkBubble"></div>
      </div>
      <div class="gmk-board" id="gmkBoardBox"><canvas class="gmk" id="gmkCanvas"></canvas></div>
      <div class="gmk-side">
        <button class="gmk-opt ${gmk.myColor === 1 ? 'active' : ''}" id="gmkBlack">我执黑 · 先手</button>
        <button class="gmk-opt ${gmk.myColor === 2 ? 'active' : ''}" id="gmkWhite">我执白 · 后手</button>
        <button class="gmk-opt" id="gmkUndo">悔棋 · 剩 ${gmk.undoLeft} 次</button>
      </div>
    </div>`,
    '<button class="btn-sm" id="gmkRestart">重新开始</button>');
  const canvas = $('#gmkCanvas', body);
  gmkFitCanvas(canvas);
  gmkDraw(canvas);
  gmkUpdateStatus();
  gmkRefreshUndoBtn();
  canvas.addEventListener('click', e => gmkOnTap(e, canvas));
  /* 注意：重新开始/执子按钮在导航栏 .sub-right 与 subBody 两个容器里，
     不能用 $('#x', body) 作用域查询（gmkRestart 在 subBody 外会拿到 null） */
  $('#gmkRestart').addEventListener('click', () => { gmkReset(true); renderGomokuPage(); });
  $('#gmkBlack').addEventListener('click', () => gmkSetColor(1));
  $('#gmkWhite').addEventListener('click', () => gmkSetColor(2));
  $('#gmkUndo').addEventListener('click', gmkUndo);
  $$('[data-gmkatt]', body).forEach(btn => btn.addEventListener('click', () => gmkSetAttitude(btn.dataset.gmkatt)));
  /* 返回固定回到【一起玩】二级页（三级结构：一起做 → 一起玩 → 五子棋）。
     与一起专注同一模式：cloneNode 换掉 subShell 绑定的 goBack，再按路由栈决定返回目标 */
  const back = $('#page-sub [data-back]');
  if (back) {
    const fresh = back.cloneNode(true);
    back.replaceWith(fresh);
    fresh.addEventListener('click', () => {
      const prev = routeStack[routeStack.length - 1];
      if (prev && prev.page === 'sub' && prev.name === 'play') {
        goBack();
      } else {
        currentRoute = { page: 'sub', name: 'play' };
        applyRoute();
      }
    });
  }
  /* 重新进入已结束的对局：恢复终局文案与结算卡片 */
  if (gmk.over) { gmkPaintFinalStatus(); gmkShowResult(gmk.result, gmk.resultSpeech); return; }
  /* 玩家执白（后手）时，进入页面由 TA 执黑先行 */
  if (gmk.turn !== gmk.myColor) gmkTaMove();
}

function gmkSetColor(c) {
  if (gmk.myColor === c) return;
  gmk.myColor = c;
  gmkReset(true);
  renderGomokuPage();
}

/* 切换对局态度：只换 AI 策略与批注，不重开棋局 */
function gmkSetAttitude(k) {
  if (!GMK_ATTITUDES[k] || gmk.attitude === k) return;
  gmk.attitude = k;
  $$('[data-gmkatt]').forEach(btn => btn.classList.toggle('active', btn.dataset.gmkatt === k));
  const note = $('#gmkAttNote');
  if (!note) return;
  /* 批注平滑切换：先淡出、换文案、再淡入 */
  note.style.opacity = '0';
  setTimeout(() => {
    if (!note.isConnected) return;
    note.textContent = GMK_ATTITUDES[k].note;
    note.style.opacity = '1';
  }, 150);
}

function gmkFitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const css = canvas.clientWidth || 300;
  canvas.width = Math.round(css * dpr);
  canvas.height = Math.round(css * dpr);
}

function gmkGeom(W) {
  const pad = W * 0.055;
  const cell = (W - pad * 2) / (GMK_N - 1);
  return { pad, cell };
}

function gmkDraw(canvas) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const { pad, cell } = gmkGeom(W);
  ctx.clearRect(0, 0, W, W);
  /* 网格线 */
  ctx.strokeStyle = 'rgba(60,60,67,.35)';
  ctx.lineWidth = Math.max(1, W / 900);
  ctx.beginPath();
  for (let i = 0; i < GMK_N; i++) {
    const p = pad + i * cell;
    ctx.moveTo(pad, p); ctx.lineTo(W - pad, p);
    ctx.moveTo(p, pad); ctx.lineTo(p, W - pad);
  }
  ctx.stroke();
  /* 星位 */
  ctx.fillStyle = 'rgba(60,60,67,.55)';
  [[3, 3], [3, 11], [7, 7], [11, 3], [11, 11]].forEach(([x, y]) => {
    ctx.beginPath();
    ctx.arc(pad + x * cell, pad + y * cell, Math.max(1.5, cell * 0.09), 0, Math.PI * 2);
    ctx.fill();
  });
  /* 棋子 */
  for (let y = 0; y < GMK_N; y++) for (let x = 0; x < GMK_N; x++) {
    const v = gmk.board[y][x];
    if (!v) continue;
    const cx = pad + x * cell, cy = pad + y * cell, r = cell * 0.42;
    const grad = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
    if (v === 1) { grad.addColorStop(0, '#5A5A5E'); grad.addColorStop(1, '#101012'); }
    else { grad.addColorStop(0, '#FFFFFF'); grad.addColorStop(1, '#E4E4E8'); }
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = v === 1 ? 'rgba(0,0,0,.4)' : 'rgba(60,60,67,.28)';
    ctx.lineWidth = Math.max(1, W / 1200);
    ctx.stroke();
  }
  /* 最后一手红点标记 */
  if (gmk.last) {
    ctx.beginPath();
    ctx.arc(pad + gmk.last[0] * cell, pad + gmk.last[1] * cell, cell * 0.12, 0, Math.PI * 2);
    ctx.fillStyle = '#FF3B30';
    ctx.fill();
  }
}

function gmkStatusDot(color) {
  return `<span class="gs-dot" style="background:${color === 1 ? '#1C1C1E' : '#fff'}"></span>`;
}

function gmkUpdateStatus() {
  const el = $('#gmkStatus');
  if (!el) return;
  const dn = taName();
  if (gmk.over) return; /* 终局文案由 gmkFinish 写入 */
  if (gmk.thinking || gmk.turn !== gmk.myColor) el.innerHTML = `${gmkStatusDot(gmkTaColor())}${esc(dn)}正在思考…`;
  else el.innerHTML = `${gmkStatusDot(gmk.myColor)}轮到你了`;
}

function gmkOnTap(e, canvas) {
  if (gmk.over || gmk.thinking || gmk.turn !== gmk.myColor) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return;
  const scale = canvas.width / rect.width;
  const px = (e.clientX - rect.left) * scale;
  const py = (e.clientY - rect.top) * scale;
  const { pad, cell } = gmkGeom(canvas.width);
  const x = Math.round((px - pad) / cell), y = Math.round((py - pad) / cell);
  if (x < 0 || x >= GMK_N || y < 0 || y >= GMK_N) return;
  /* 命中容差：点击位置距交叉点不超过半格才落子 */
  if (Math.abs(px - (pad + x * cell)) > cell * 0.5 || Math.abs(py - (pad + y * cell)) > cell * 0.5) return;
  if (gmk.board[y][x]) return;
  const finished = gmkPlace(x, y, gmk.myColor);
  if (finished) return;
  /* 玩家落子后先给一句局势互动，再由 TA 应对 */
  gmkReactionToPlayer(x, y);
  gmk.turn = gmkTaColor();
  gmkRefreshUndoBtn();
  gmkTaMove();
}

function gmkPlace(x, y, color) {
  gmk.board[y][x] = color;
  gmk.last = [x, y];
  gmk.history.push({ x, y, color });
  const canvas = $('#gmkCanvas');
  if (canvas) gmkDraw(canvas);
  if (gmkWinAt(x, y, color)) { gmkFinish(color === gmk.myColor ? 'me' : 'ta'); return true; }
  if (gmkBoardFull()) { gmkFinish('draw'); return true; }
  return false;
}

/* 局势互动：按玩家这一步的棋力与威胁程度挑一句内置台词 */
function gmkReactionToPlayer(x, y) {
  if (gmk.over || !document.getElementById('gmkCanvas')) return;
  const score = gmkEvalPoint(x, y, gmk.myColor);
  const aboutToWin = gmkHasWinPoint(gmk.myColor);
  let pool = null;
  if (aboutToWin) pool = GMK_LINES.aboutWin;
  else if (score >= 800) pool = GMK_LINES.good;
  else if (score <= 100 && gmk.history.length >= 4) pool = GMK_LINES.bad;
  else if (score >= 300 && Math.random() < 0.3) pool = GMK_LINES.good;
  if (pool) gmkSay(pool);
}

/* 是否已经存在下一手就能连成五子的点（用于判断“玩家即将赢下比赛”） */
function gmkHasWinPoint(color) {
  return gmkCandidates().some(p => gmkWinAt(p[0], p[1], color));
}

/* 梦角气泡：显示 3 秒后自动淡出，不拦截棋盘点击 */
function gmkSay(pool) {
  const el = $('#gmkBubble');
  if (!el || !Array.isArray(pool) || !pool.length) return;
  el.textContent = pool[randInt(0, pool.length - 1)];
  el.classList.add('show');
  if (gmk.bubbleTimer) clearTimeout(gmk.bubbleTimer);
  gmk.bubbleTimer = setTimeout(() => {
    gmk.bubbleTimer = null;
    const n = $('#gmkBubble');
    if (n) n.classList.remove('show');
  }, 3000);
}

function gmkTaMove() {
  if (gmk.over) return;
  gmk.thinking = true;
  gmk.watered = false;
  gmkUpdateStatus();
  gmkRefreshUndoBtn();
  const gen = gmk.gen;
  setTimeout(() => {
    /* 页面已离开或已重开 → 丢弃这次落子 */
    if (gen !== gmk.gen || !document.getElementById('gmkCanvas')) return;
    gmk.thinking = false;
    const mv = gmkBestMove();
    if (!mv) { gmkFinish('draw'); return; }
    const watered = gmk.watered;
    gmkPlace(mv[0], mv[1], gmkTaColor());
    if (gmk.over) return;
    gmk.turn = gmk.myColor;
    gmkUpdateStatus();
    gmkRefreshUndoBtn();
    /* TA 故意放水时补一句吐槽，覆盖掉本回合前面的互动台词 */
    if (watered) gmkSay(GMK_LINES.water);
  }, randInt(500, 1000));
}

/* 胜负判定：以 (x,y) 为中心，横/竖/两斜四方向数同色连子 */
function gmkWinAt(x, y, color) {
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (const [dx, dy] of dirs) {
    let n = 1;
    for (let s = 1; s < 5; s++) {
      const nx = x + dx * s, ny = y + dy * s;
      if (nx < 0 || ny < 0 || nx >= GMK_N || ny >= GMK_N || gmk.board[ny][nx] !== color) break;
      n++;
    }
    for (let s = 1; s < 5; s++) {
      const nx = x - dx * s, ny = y - dy * s;
      if (nx < 0 || ny < 0 || nx >= GMK_N || ny >= GMK_N || gmk.board[ny][nx] !== color) break;
      n++;
    }
    if (n >= 5) return true;
  }
  return false;
}

function gmkBoardFull() { return gmk.board.every(row => row.every(v => v !== 0)); }

/* 单点评分：假设 color 落在 (x,y)，四方向按连子数与两端开放程度给权重 */
function gmkEvalPoint(x, y, color) {
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
  let score = 0;
  for (const [dx, dy] of dirs) {
    let n = 1, open = 0;
    for (let s = 1; s < 5; s++) {
      const nx = x + dx * s, ny = y + dy * s;
      if (nx < 0 || ny < 0 || nx >= GMK_N || ny >= GMK_N) break;
      if (gmk.board[ny][nx] === color) { n++; continue; }
      if (gmk.board[ny][nx] === 0) open++;
      break;
    }
    for (let s = 1; s < 5; s++) {
      const nx = x - dx * s, ny = y - dy * s;
      if (nx < 0 || ny < 0 || nx >= GMK_N || ny >= GMK_N) break;
      if (gmk.board[ny][nx] === color) { n++; continue; }
      if (gmk.board[ny][nx] === 0) open++;
      break;
    }
    if (n >= 5) score += 100000;
    else if (n === 4) score += open === 2 ? 12000 : open === 1 ? 8000 : 0;
    else if (n === 3) score += open === 2 ? 3000 : open === 1 ? 800 : 0;
    else if (n === 2) score += open === 2 ? 300 : open === 1 ? 80 : 0;
    else score += open === 2 ? 20 : open === 1 ? 4 : 0;
  }
  return score;
}

/* 候选点：只考虑已有棋子周围 2 格内的空点，兼顾棋力与性能 */
function gmkCandidates() {
  const out = [];
  let any = false;
  for (let y = 0; y < GMK_N; y++) for (let x = 0; x < GMK_N; x++) if (gmk.board[y][x]) any = true;
  if (!any) return [[7, 7]];
  for (let y = 0; y < GMK_N; y++) for (let x = 0; x < GMK_N; x++) {
    if (gmk.board[y][x]) continue;
    let near = false;
    for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= GMK_N || ny >= GMK_N) continue;
      if (gmk.board[ny][nx]) { near = true; break; }
    }
    if (near) out.push([x, y]);
  }
  return out.length ? out : [[7, 7]];
}

/* 在候选点里按「进攻分 + 防守分 × 权重」打分挑选，noise 越大越随性 */
function gmkPick(cands, ta, me, defWeight, noise) {
  const c = (GMK_N - 1) / 2;
  let best = null, bestScore = -Infinity;
  for (const [x, y] of cands) {
    let s = gmkEvalPoint(x, y, ta) + gmkEvalPoint(x, y, me) * defWeight;
    /* 轻微居中倾向 + 随机扰动，避免每局完全相同 */
    s += (GMK_N - Math.abs(x - c) - Math.abs(y - c)) * 0.6 + Math.random() * noise;
    if (s > bestScore) { bestScore = s; best = [x, y]; }
  }
  return best || [7, 7];
}

/* AI 选点：三档对局态度
 * 认真：能赢就赢、必堵五连，攻防权重最高；
 * 宠溺（默认）：能让就让，能赢也不急着赢，防守看心情，经常“放水”；
 * 随性：多半靠直觉，也会偶尔漏防。 */
function gmkBestMove() {
  const ta = gmkTaColor(), me = gmk.myColor, mode = gmk.attitude;
  const cands = gmkCandidates();
  const winNow = cands.find(p => gmkWinAt(p[0], p[1], ta));
  const blockNow = cands.find(p => gmkWinAt(p[0], p[1], me));

  if (mode === 'serious') {
    if (winNow) return winNow;
    if (blockNow) return blockNow;
    return gmkPick(cands, ta, me, 1.05, 5);
  }
  if (mode === 'casual') {
    if (winNow && Math.random() < 0.9) return winNow;
    if (blockNow && Math.random() < 0.55) return blockNow;
    return gmkPick(cands, ta, me, 0.6, 26);
  }
  /* 宠溺模式 */
  if (winNow && Math.random() < 0.85) {
    gmk.watered = true;
    const soft = cands.filter(p => p[0] !== winNow[0] || p[1] !== winNow[1]);
    if (soft.length) return gmkPick(soft, ta, me, 0.45, 34);
  }
  if (blockNow) {
    if (Math.random() < 0.4) {
      gmk.watered = true;
      const soft = cands.filter(p => p[0] !== blockNow[0] || p[1] !== blockNow[1]);
      if (soft.length) return gmkPick(soft, ta, me, 0.35, 40);
    }
    return blockNow;
  }
  if (Math.random() < 0.3) gmk.watered = true;
  return gmkPick(cands, ta, me, gmk.watered ? 0.4 : 0.55, gmk.watered ? 40 : 16);
}

/* 终局：状态文案 + 内置结算台词 + 聊天里一条 TA 的普通消息 + 棋盘上的半透明结算卡片 */
function gmkFinish(result) {
  gmk.over = true;
  gmk.thinking = false;
  gmk.result = result;
  if (gmk.bubbleTimer) { clearTimeout(gmk.bubbleTimer); gmk.bubbleTimer = null; }
  const bubble = $('#gmkBubble');
  if (bubble) bubble.classList.remove('show');
  gmkPaintFinalStatus();
  /* 内置结算台词：你赢=TA 认输/奖励，TA 赢=TA 得意，平局也有内置文案 */
  const pool = result === 'me' ? GMK_LINES.winMe : result === 'ta' ? GMK_LINES.winTa : GMK_LINES.draw;
  const speech = pool[randInt(0, pool.length - 1)];
  gmk.resultSpeech = speech;
  /* 聊天记录：只生成一条 TA 的普通文本消息，不写生硬的系统提示 */
  const rid = state.activeRoleId;
  if (rid && roleById(rid)) {
    pushDreamMessage(rid, { type: 'text', content: speech });
    renderChatIf(rid);
  }
  gmkShowResult(result, speech);
  gmkRefreshUndoBtn();
}

function gmkPaintFinalStatus() {
  const el = $('#gmkStatus');
  if (!el || !gmk.result) return;
  const dn = taName();
  if (gmk.result === 'me') el.innerHTML = `${gmkStatusDot(gmk.myColor)}你赢了 🎉`;
  else if (gmk.result === 'ta') el.innerHTML = `${gmkStatusDot(gmkTaColor())}${esc(dn)}赢了`;
  else el.textContent = '平局 · 棋盘下满了';
}

/* 棋盘中央的半透明结算卡片：TA 头像 + 内置台词 + 再来一局/知道了 */
function gmkShowResult(result, speech) {
  const box = $('#gmkBoardBox');
  if (!box || !speech) return;
  const old = $('#gmkOverlay', box);
  if (old) old.remove();
  const role = roleById(state.activeRoleId) || state.roles[0];
  const title = result === 'draw' ? '平局' : result === 'me' ? '你赢了 🎉' : `${taName()} 赢了`;
  const el = document.createElement('div');
  el.className = 'gmk-overlay';
  el.id = 'gmkOverlay';
  el.innerHTML = `
    <div class="gmk-result-card">
      <div class="gmk-result-head">
        ${role ? roleAvatarHTML(role, 40) : avatarHTML('🙂', 40)}
        <div class="gmk-result-title">${esc(title)}</div>
      </div>
      <div class="gmk-result-text">「${esc(speech)}」</div>
      <div class="gmk-result-actions">
        <button class="gmk-opt" id="gmkAgain">再来一局</button>
        <button class="gmk-opt" id="gmkClose">知道了</button>
      </div>
    </div>`;
  box.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  el.querySelector('#gmkAgain').addEventListener('click', () => { gmkReset(true); renderGomokuPage(); });
  el.querySelector('#gmkClose').addEventListener('click', () => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 220);
  });
}

function gmkRefreshUndoBtn() {
  const btn = $('#gmkUndo');
  if (!btn) return;
  const hasMine = gmk.history.some(m => m.color === gmk.myColor);
  const can = !gmk.over && !gmk.thinking && gmk.undoLeft > 0 && hasMine;
  btn.textContent = '悔棋 · 剩 ' + gmk.undoLeft + ' 次';
  btn.disabled = !can;
}

/* 悔棋：撤销玩家上一步与 TA 随后的应对，退回玩家回合；每局 3 次 */
function gmkUndo() {
  if (gmk.over || gmk.thinking || gmk.undoLeft <= 0) return;
  let idx = -1;
  for (let i = gmk.history.length - 1; i >= 0; i--) {
    if (gmk.history[i].color === gmk.myColor) { idx = i; break; }
  }
  if (idx < 0) return;
  const removed = gmk.history.splice(idx);
  removed.forEach(m => { gmk.board[m.y][m.x] = 0; });
  const lastMv = gmk.history[gmk.history.length - 1];
  gmk.last = lastMv ? [lastMv.x, lastMv.y] : null;
  gmk.turn = gmk.myColor;
  gmk.undoLeft--;
  const canvas = $('#gmkCanvas');
  if (canvas) gmkDraw(canvas);
  gmkUpdateStatus();
  gmkRefreshUndoBtn();
  gmkSay(GMK_LINES.undo);
}


/* =========================================================
 * 十九、一起专注
 * ========================================================= */
const pomo = {
  total: 1500,
  remain: 1500,
  running: false,
  everStarted: false,
  tickId: null,
  endAt: 0,
  task: '陪伴专注',
  /* 梦角陪伴气泡：下一次发言判定时间戳与当前气泡文案（不进聊天、不产生未读） */
  speakAt: 0,
  speakText: ''
};
const POMO_CIRC = 2 * Math.PI * 104;

/* 陪伴气泡的默认文案（未开始 / 重置后） */
function pomoIdleText(role) {
  return role ? `${role.name}在这儿，准备好就开始吧。` : '准备好就开始吧。';
}
function pomoRole() {
  return roleById(state.activeRoleId) || state.roles[0] || null;
}
/* 气泡淡入淡出更新：先淡出，再换文案，再淡入；页面不在一起专注时只记文案 */
function updatePomoBubble(text) {
  const b = $('#pomoBubble');
  if (!b) { pomo.speakText = text; return; }
  b.classList.add('fade');
  setTimeout(() => {
    pomo.speakText = text;
    const b2 = $('#pomoBubble');
    if (b2) { b2.textContent = text; b2.classList.remove('fade'); }
  }, 270);
}

function renderPomodoroPage() {
  if (!pomo.running && pomo.remain === pomo.total && !pomo.everStarted) {
    pomo.task = pomo.task || '陪伴专注';
  }
  const todayCount = state.pomodoro.records.filter(r => isSameDay(r.ts, Date.now())).length;
  const recent = state.pomodoro.records.slice().sort((a, b) => b.ts - a.ts).slice(0, 12);
  const companion = pomoRole();

  subShell('一起专注', `
    <div class="panel">
      <div class="field">
        <label>任务名称</label>
        <input class="input" id="pomoTask" value="${esc(pomo.task)}" placeholder="例如：陪我看书">
      </div>
      <div class="field">
        <label>时长（分钟）</label>
        <input class="input" id="pomoMinutes" type="number" min="1" max="180" value="${Math.round(pomo.total / 60)}">
      </div>
    </div>
    <div class="panel">
      <div class="pomo-wrap">
        <div class="ring-box">
          <svg viewBox="0 0 240 240">
            <circle class="ring-bg" cx="120" cy="120" r="104"></circle>
            <circle class="ring-fg" id="pomoRing" cx="120" cy="120" r="104"
              stroke-dasharray="${POMO_CIRC}" stroke-dashoffset="0"></circle>
          </svg>
          <div class="ring-inner">
            <div class="ring-time" id="pomoTime">${fmtDuration(pomo.remain)}</div>
            <div class="ring-task" id="pomoTaskLabel">${esc(pomo.task)}</div>
          </div>
        </div>
        ${companion ? `
        <div class="pomo-companion">
          ${roleAvatarHTML(companion, 36)}
          <div class="grow" style="min-width:0">
            <div class="pomo-bubble" id="pomoBubble">${esc(pomo.speakText || pomoIdleText(companion))}</div>
            <div class="pomo-who">${esc(companion.name)} 陪你专注</div>
          </div>
        </div>` : ''}
        <div class="pomo-actions">
          <button class="btn primary" id="pomoStart">${pomo.running ? '暂停' : ((pomo.remain < pomo.total || pomo.everStarted) ? '继续' : '开始')}</button>
          <button class="btn" id="pomoReset">重置</button>
        </div>
        <div class="today-count">今日完成 <b id="pomoToday">${todayCount}</b> 次</div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-title">最近记录</div>
      ${recent.length ? recent.map(r => `
        <div class="list-row">
          <div class="grow">
            <div style="font-size:14px">${esc(r.task)}</div>
            <div class="muted">${fmtMsgTime(r.ts)}</div>
          </div>
          <span class="chip">${r.minutes} 分钟</span>
        </div>`).join('') : '<div class="muted">还没有完成记录，开始第一次专注吧。</div>'}
    </div>`);

  $('#pomoTask').addEventListener('input', e => {
    pomo.task = e.target.value;
    const label = $('#pomoTaskLabel');
    if (label) label.textContent = pomo.task || '陪伴专注';
  });
  $('#pomoMinutes').addEventListener('change', e => {
    if (pomo.running) { showToast('计时中不能修改时长，请先重置'); renderPomodoroPage(); return; }
    const minutes = clamp(parseInt(e.target.value, 10) || 25, 1, 180);
    pomo.total = minutes * 60;
    pomo.remain = pomo.total;
    updatePomoUI();
  });
  $('#pomoStart').addEventListener('click', () => {
    if (pomo.running) pausePomodoro();
    else startPomodoro();
  });
  $('#pomoReset').addEventListener('click', resetPomodoro);
  updatePomoUI();

  /* 返回固定回到【一起做】：即使是从桌面通知直达一起专注，也不会直接回桌面。
     subShell 已经给返回键绑了 goBack，这里用 cloneNode 换掉原节点，
     彻底移除旧监听后再绑定新的返回逻辑，避免两个监听同时执行。 */
  const back = $('#page-sub [data-back]');
  if (back) {
    const fresh = back.cloneNode(true);
    back.replaceWith(fresh);
    fresh.addEventListener('click', () => {
      const prev = routeStack[routeStack.length - 1];
      if (prev && prev.page === 'sub' && prev.name === 'readtogether') {
        goBack();
      } else {
        currentRoute = { page: 'sub', name: 'readtogether' };
        applyRoute();
      }
    });
  }
}

function startPomodoro() {
  if (pomo.running) return;
  if (pomo.remain <= 0) pomo.remain = pomo.total;
  pomo.running = true;
  pomo.everStarted = true;
  pomo.endAt = Date.now() + pomo.remain * 1000;
  /* 安排首次陪伴发言判定（每 3~8 分钟一次，命中概率由设置控制） */
  if (!pomo.speakAt || pomo.speakAt < Date.now()) pomo.speakAt = Date.now() + randInt(3, 8) * 60000;
  clearInterval(pomo.tickId);
  pomo.tickId = setInterval(() => {
    const now = Date.now();
    const left = Math.max(0, Math.ceil((pomo.endAt - now) / 1000));
    pomo.remain = left;
    updatePomoUI();
    /* 陪伴发言判定：到点即判定一次并安排下一次，命中则从启用字卡抽一句（支持拼接） */
    if (pomo.speakAt && now >= pomo.speakAt && left > 0) {
      pomo.speakAt = now + randInt(3, 8) * 60000;
      const chance = Number(state.settings.pomodoroSpeakChance ?? 30);
      if (Math.random() * 100 < chance) {
        const role = pomoRole();
        if (role) updatePomoBubble(composeCardText(role.id) || '专心做你的事，我陪着你');
      }
    }
    if (left <= 0) finishPomodoro();
  }, 250);
  updatePomoUI();
}

function pausePomodoro() {
  if (!pomo.running) return;
  pomo.remain = Math.max(0, Math.ceil((pomo.endAt - Date.now()) / 1000));
  pomo.running = false;
  clearInterval(pomo.tickId);
  pomo.tickId = null;
  updatePomoUI();
}

function resetPomodoro() {
  clearInterval(pomo.tickId);
  pomo.tickId = null;
  pomo.running = false;
  pomo.endAt = 0;
  pomo.everStarted = false;
  pomo.remain = pomo.total;
  pomo.speakAt = 0;
  pomo.speakText = '';
  updatePomoUI();
  const b = $('#pomoBubble');
  if (b) b.textContent = pomoIdleText(pomoRole());
}

function finishPomodoro() {
  clearInterval(pomo.tickId);
  pomo.tickId = null;
  pomo.running = false;
  pomo.speakAt = 0;
  const minutes = Math.round(pomo.total / 60);
  const task = pomo.task || '陪伴专注';
  state.pomodoro.records.push({ id: uid(), task, minutes, ts: Date.now() });
  pomo.remain = pomo.total;
  persist(true);
  if (currentRoute.page === 'sub' && currentRoute.name === 'pomodoro') renderPomodoroPage();
  playFinishSound();
  /* 一起专注结束系统通知：默认开启，内部自带权限判断，未授权时静默跳过 */
  notifyDefaultEvent('专注结束', '时间到啦，休息一下吧！', 'pomodoro-finish', { page: 'sub', name: 'pomodoro' });
  const todayCount = state.pomodoro.records.filter(r => isSameDay(r.ts, Date.now())).length;
  showModal({
    title: '专注完成',
    body: `<p class="modal-text">「${esc(task)}」完成了 ${minutes} 分钟。<br>今天已经陪伴专注 ${todayCount} 次，辛苦了。</p>`,
    actions: [{ label: '好', kind: 'primary' }]
  });
}

function playFinishSound() {
  beep(880, 0.16, 0, 0.08);
  beep(1046, 0.16, 0.22, 0.08);
  beep(1318, 0.26, 0.44, 0.08);
}

function updatePomoUI() {
  const timeEl = $('#pomoTime');
  if (!timeEl) return;
  timeEl.textContent = fmtDuration(pomo.remain);
  const ring = $('#pomoRing');
  if (ring) {
    const ratio = pomo.total > 0 ? pomo.remain / pomo.total : 0;
    ring.setAttribute('stroke-dashoffset', String(POMO_CIRC * (1 - ratio)));
  }
  const label = $('#pomoTaskLabel');
  if (label) label.textContent = pomo.task || '陪伴专注';
  const start = $('#pomoStart');
  if (start) start.textContent = pomo.running ? '暂停' : ((pomo.remain < pomo.total || pomo.everStarted) ? '继续' : '开始');
  const today = $('#pomoToday');
  if (today) today.textContent = String(state.pomodoro.records.filter(r => isSameDay(r.ts, Date.now())).length);
  const minutesInput = $('#pomoMinutes');
  if (minutesInput && document.activeElement !== minutesInput) {
    minutesInput.value = String(Math.round(pomo.total / 60));
  }
}

/* =========================================================
 * 二十、梦角定位
 * ========================================================= */
function dirName(bearing) {
  const dirs = ['北', '北东北', '东北', '东东北', '东', '东东南', '东南', '南东南',
    '南', '南西南', '西南', '西西南', '西', '西西北', '西北', '北西北'];
  const index = Math.round(((bearing % 360) + 360) % 360 / 22.5) % 16;
  return dirs[index];
}

/* 梦角定位数据：每个梦角各自一份 {bearing,distance,status,activity,updated}。
 * defaultLocationData：新梦角的固定初始值（正北附近，温和文案）；
 * randomLocationData：随机生成一份，用于“随机刷新”与旧数据缺失时的补默认；
 * normalizeLocation：合并补全字段并做范围约束，保证迁移后数据结构完整。 */
function defaultLocationData() {
  return {
    bearing: 0,
    distance: 180,
    status: '在附近',
    activity: '在忙自己的事，偶尔想起你',
    updated: Date.now()
  };
}
/* 状态 / 正在做什么 词条库：按距离区间分桶，随机刷新时只从距离所属区间抽词，
   保证文案与距离严格匹配（不再出现 0 米却在车站的错位） */
const LOC_BUCKETS = [
  {
    /* 极近距离：0 ~ 5 米（含 0 米） */
    min: 0, max: 5,
    status: ['在你身边', '满眼都是你', '心跳加速'],
    activity: ['看着你', '牵着你的手', '从背后抱着你', '听你说话', '帮你整理头发']
  },
  {
    /* 近距离：6 ~ 100 米 */
    min: 6, max: 100,
    status: ['在附近', '想见你', '偷偷关注你'],
    activity: ['在楼下等你', '在隔壁房间', '在小区门口散步', '买水喝', '正在走向你']
  },
  {
    /* 中距离：101 ~ 300 米 */
    min: 101, max: 300,
    status: ['有点想你', '在忙', '挂念你'],
    activity: ['在附近的咖啡店', '在超市买东西', '在街角散步', '在健身房锻炼']
  },
  {
    /* 远距离：301 ~ 500 米 */
    min: 301, max: 500,
    status: ['在忙工作', '有些疲惫', '期待见面'],
    activity: ['在公司上班', '在通勤的地铁上', '在车站等车', '在开会', '在见客户']
  }
];
/* 按距离找到所属区间桶（兜底返回最后一桶，即远距离） */
function locBucketOf(distance) {
  for (const b of LOC_BUCKETS) {
    if (distance >= b.min && distance <= b.max) return b;
  }
  return LOC_BUCKETS[LOC_BUCKETS.length - 1];
}
function randomLocationData() {
  /* 1. 先随机距离：0 ~ 500 米整数 */
  const distance = randInt(0, 500);
  /* 2. 按区间抽词：只从该距离所属桶中抽取状态与动态 */
  const bucket = locBucketOf(distance);
  let status = pickOne(bucket.status);
  const activity = pickOne(bucket.activity);
  /* 3. 特殊绑定：0 米 = 在你身边（强制覆盖状态），动态仍从极近桶抽取 */
  if (distance === 0) status = '在你身边';
  return {
    bearing: randInt(0, 359),   /* 方位角照常随机 */
    distance,
    status,
    activity,
    updated: Date.now()
  };
}
function normalizeLocation(loc) {
  const d = defaultLocationData();
  const src = (loc && typeof loc === 'object') ? loc : {};
  /* 距离范围 0~500 米：旧数据超出范围时收敛到边界（<0 记 0，>500 记 500） */
  let dist = parseInt(src.distance, 10);
  if (!Number.isFinite(dist)) dist = d.distance;
  dist = clamp(dist, 0, 500);
  return {
    bearing: clamp(parseInt(src.bearing, 10), 0, 359) || 0,
    distance: dist,
    status: String(src.status || d.status),
    activity: String(src.activity || d.activity),
    updated: Number(src.updated) || Date.now()
  };
}

/* 指南针上一次显示的累计角度：新一次渲染先按它摆位，再平滑转到目标角，
 * 这样重新渲染页面后指针依然能连续旋转，且始终只绕圆心转、不会跳位。 */
let compassLastAngle = null;

function compassTargetAngle(bearing) {
  const n = Number(bearing);
  return ((isFinite(n) ? n : 0) % 360 + 360) % 360;
}

function compassSVG(bearing) {
  const startAngle = compassLastAngle == null ? compassTargetAngle(bearing) : compassLastAngle;
  let ticks = '';
  for (let i = 0; i < 72; i++) {
    const angle = i * 5;
    const major = i % 18 === 0;
    const rad = (angle - 90) * Math.PI / 180;
    const r1 = major ? 84 : 91;
    const r2 = 102;
    const x1 = 120 + Math.cos(rad) * r1;
    const y1 = 120 + Math.sin(rad) * r1;
    const x2 = 120 + Math.cos(rad) * r2;
    const y2 = 120 + Math.sin(rad) * r2;
    ticks += `<line class="compass-tick ${major ? 'major' : ''}" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"></line>`;
  }
  return `
    <svg viewBox="0 0 240 240">
      <circle class="compass-ring" cx="120" cy="120" r="112"></circle>
      ${ticks}
      <text class="compass-dir" x="120" y="24" text-anchor="middle">北</text>
      <text class="compass-dir" x="221" y="125" text-anchor="middle">东</text>
      <text class="compass-dir" x="120" y="226" text-anchor="middle">南</text>
      <text class="compass-dir" x="19" y="125" text-anchor="middle">西</text>
      <g class="needle" style="transform:rotate(${startAngle}deg)">
        <polygon points="120,34 111,122 120,132 129,122" fill="var(--primary)"></polygon>
        <polygon points="120,206 113,128 120,120 127,128" fill="#c8ced8"></polygon>
        <circle cx="120" cy="120" r="8" fill="#fff" stroke="var(--primary)" stroke-width="3"></circle>
      </g>
    </svg>`;
}

/* 指针从上次角度沿最短方向转到新角度（同一 transform 内只做 rotate，圆心固定）。
 * 页面重渲染后调用：先让元素按起始角绘制，再切到目标角触发 CSS 过渡。 */
function animateCompassNeedle(bearing) {
  const el = document.querySelector('.compass-box .needle');
  if (!el) return;
  const target = compassTargetAngle(bearing);
  const from = compassLastAngle == null ? target : compassLastAngle;
  let delta = target - (from % 360);
  if (delta > 180) delta -= 360;
  else if (delta < -180) delta += 360;
  const to = from + delta;
  compassLastAngle = ((to % 360) + 360) % 360;
  if (delta === 0) { el.style.transform = `rotate(${to}deg)`; return; }
  el.style.transform = `rotate(${from}deg)`;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    el.style.transform = `rotate(${to}deg)`;
  }));
}

/* 定位刷新冷却：按梦角独立，使用上次刷新时间戳计算，切换页面/梦角都不会重置 */
let locCdTimer = null;
function locationCooldownLeft(roleId) {
  const cd = clamp(Math.round(Number(state.settings.locationCooldown ?? 60)), 0, 3600);
  if (!(cd > 0)) return 0;
  const loc = (state.locations && state.locations[roleId]) || {};
  const last = Number(loc.refreshedAt || 0);
  if (!(last > 0)) return 0;
  const remain = Math.ceil((last + cd * 1000 - Date.now()) / 1000);
  return remain > 0 ? remain : 0;
}
function startLocCooldownTicker(roleId) {
  if (locCdTimer) { clearInterval(locCdTimer); locCdTimer = null; }
  const tick = () => {
    const btn = $('#locRefresh');
    if (!btn || currentRoute.page !== 'sub' || currentRoute.name !== 'location') {
      if (locCdTimer) { clearInterval(locCdTimer); locCdTimer = null; }
      return;
    }
    const left = locationCooldownLeft(roleId);
    if (left > 0) {
      btn.classList.add('cooling');
      btn.textContent = '冷却中 ' + left + 's';
    } else {
      btn.classList.remove('cooling');
      btn.textContent = '随机刷新';
    }
  };
  tick();
  locCdTimer = setInterval(tick, 1000);
}

function renderLocationPage() {
  /* 当前选中的梦角：默认上次选中（持久化于 state.locationRoleId），缺失时回落第一个 */
  let role = roleById(state.locationRoleId) || state.roles[0];
  if (!role) { subShell('梦角定位', '<div class="list-tip">还没有梦角，先去联系人页添加一位吧。</div>'); return; }
  if (role.id !== state.locationRoleId) { state.locationRoleId = role.id; persist(); }
  if (!state.locations[role.id]) { state.locations[role.id] = randomLocationData(); persist(); }
  const loc = state.locations[role.id];
  const bearing = Number(loc.bearing) || 0;
  const dir = dirName(bearing);
  /* 距离为 0 米时只把状态字段显示为「在你身边」；距离字段仍显示「0 米」，互不替代 */
  const distZero = Math.round(loc.distance) === 0;
  const statusDisplay = distZero ? '在你身边' : loc.status;

  subShell('梦角定位', `
    ${roleStripHTML(role.id)}
    <div class="panel" style="padding-top:4px">
      <div class="compass-box">${compassSVG(bearing)}</div>
      <div style="text-align:center" class="muted">${esc(role.name)} ${esc(loc.activity)}</div>
    </div>
    <div class="data-grid">
      <div class="data-cell"><div class="k">方位</div><div class="v">${esc(dir)}</div></div>
      <div class="data-cell"><div class="k">距离</div><div class="v">${Math.round(loc.distance)} 米</div></div>
      <div class="data-cell"><div class="k">状态</div><div class="v" style="font-size:15px">${esc(statusDisplay)}</div></div>
      <div class="data-cell"><div class="k">正在做什么</div><div class="v" style="font-size:13px;line-height:1.5">${esc(loc.activity)}</div></div>
    </div>
    <div class="btn-row">
      <button class="btn primary" style="flex:1" id="locRefresh">随机刷新</button>
      <button class="btn" style="flex:1" id="locEdit">手动编辑</button>
    </div>
    <div class="tip-box" style="margin-top:12px">每个梦角都有独立的方位与动态；定位为本地模拟数据，用于陪伴氛围，不会获取你的真实地理位置。</div>`);

  animateCompassNeedle(bearing);
  startLocCooldownTicker(role.id);

  /* 切换梦角：持久化选中并立即重渲染（指针按各自方位角平滑转过去） */
  $$('.role-strip [data-rspick]').forEach(btn => btn.addEventListener('click', () => {
    if (btn.dataset.rspick === state.locationRoleId) return;
    state.locationRoleId = btn.dataset.rspick;
    persist();
    renderLocationPage();
  }));

  $('#locRefresh').addEventListener('click', () => {
    const left = locationCooldownLeft(role.id);
    if (left > 0) { showToast('定位刷新冷却中，还需等待 ' + left + ' 秒'); return; }
    state.locations[role.id] = Object.assign(randomLocationData(), { refreshedAt: Date.now() });
    persist();
    renderLocationPage();
    showToast('已刷新定位');
  });

  $('#locEdit').addEventListener('click', () => {
    const modal = showModal({
      title: `编辑 ${role.name} 的定位`,
      body: `
        <div class="field"><label>方位角（0~359°）</label><input class="input" id="locBearing" type="number" min="0" max="359" value="${Math.round(bearing)}"></div>
        <div class="field"><label>距离（0~500 米，0 米显示「在你身边」）</label><input class="input" id="locDistance" type="number" min="0" max="500" value="${Math.round(loc.distance)}"></div>
        <div class="field"><label>状态</label><input class="input" id="locStatus" value="${esc(loc.status)}"></div>
        <div class="field"><label>正在做什么</label><input class="input" id="locActivity" value="${esc(loc.activity)}"></div>`,
      actions: [
        { label: '取消' },
        {
          label: '保存', kind: 'primary', onClick: el => {
            const rawDist = parseInt($('#locDistance', el).value, 10);
            if (!Number.isFinite(rawDist) || rawDist < 0 || rawDist > 500) {
              showToast('距离需在 0~500 米之间');
              return false;
            }
            state.locations[role.id] = {
              bearing: clamp(parseInt($('#locBearing', el).value, 10) || 0, 0, 359),
              distance: clamp(rawDist, 0, 500),
              status: $('#locStatus', el).value.trim() || '在附近',
              activity: $('#locActivity', el).value.trim() || '在忙自己的事',
              /* 手动编辑不受冷却限制，但保留上次刷新时间戳，避免借编辑绕过冷却 */
              refreshedAt: Number(loc.refreshedAt || 0),
              updated: Date.now()
            };
            persist();
            renderLocationPage();
            showToast('定位已保存');
            return true;
          }
        }
      ]
    });
    return modal;
  });
}

/* =========================================================
 * 二十一·五、待办事项（桌面应用 + 日历联动 + 提醒巡检）
 * ========================================================= */
let todoFocusDate = ''; /* 从日历点击跳转时自动定位到的日期（YYYY-MM-DD），待办页据此过滤 */

function todoDateKeyOf(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function todosOn(y, m0, d) {
  const key = y + '-' + pad2(m0 + 1) + '-' + pad2(d);
  return state.todos.filter(t => t.date === key);
}
function todoBadgeCount() {
  const key = todoDateKeyOf(Date.now());
  return state.todos.filter(t => t.date === key && !t.isCompleted).length;
}
/* 提醒时间：填了时间 → 当天该时刻；未填（全天）→ 当天 09:00 */
function todoRemindTime(date, time) {
  const t = /^\d{1,2}:\d{2}$/.test(time || '') ? time : '09:00';
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = t.split(':').map(Number);
  return new Date(y, m - 1, d, hh || 0, mm || 0, 0, 0).getTime();
}

function renderTodoPage() {
  const todayStr = todayKey();
  const focus = /^\d{4}-\d{2}-\d{2}$/.test(todoFocusDate) ? todoFocusDate : '';
  const all = state.todos.slice().sort((a, b) => (b.remindTime || 0) - (a.remindTime || 0));
  const list = focus ? all.filter(t => t.date === focus) : all;
  const unDone = all.filter(t => !t.isCompleted).length;
  const fmtDate = key => { const p = key.split('-'); return Number(p[1]) + '月' + Number(p[2]) + '日'; };
  const fmtTime = ts => {
    const d = new Date(ts);
    return d.getHours() + ':' + pad2(d.getMinutes());
  };

  const body = subShell('待办事项', `
    <div class="panel">
      <div class="panel-title">添加待办</div>
      <div class="field"><label>事项内容</label><input class="input" id="todoContent" placeholder="要做什么？" maxlength="100"></div>
      <div style="display:flex;gap:8px">
        <div class="field" style="flex:1.2"><label>日期</label><input class="input" id="todoDate" type="date" value="${focus || todayStr}"></div>
        <div class="field" style="flex:1"><label>时间（不填为全天）</label><input class="input" id="todoTime" type="time"></div>
      </div>
      <button class="btn primary" id="todoSave" style="width:100%">保存待办</button>
      <div class="muted" style="font-size:12px;line-height:1.6;margin-top:8px">按设定时间提醒（全天待办在当天 09:00 提醒）；页面刷新或切后台后回来也会自动补发错过的提醒。需在「设置 → 后台通知」开启通知才会弹系统通知。</div>
    </div>
    ${focus ? `<div class="todo-focusbar"><span>正在查看 ${esc(fmtDate(focus))} 的待办</span><button class="btn-sm" id="todoClearFocus">显示全部</button></div>` : ''}
    <div class="panel">
      <div class="panel-title row-between"><span>待办列表</span><span class="muted" style="font-size:11px">未完成 ${unDone} · 共 ${all.length}</span></div>
      ${list.length ? list.map(t => `
        <div class="todo-row" data-tid="${t.id}">
          <button class="todo-check${t.isCompleted ? ' done' : ''}" data-tchk="${t.id}" title="完成 / 取消完成"></button>
          <div class="grow" style="min-width:0">
            <div class="todo-content${t.isCompleted ? ' done' : ''}">${esc(t.content)}</div>
            <div class="todo-meta">${esc(fmtDate(t.date))}${t.time ? ' · ' + esc(t.time) : ' · 全天'} · ${t.isCompleted ? '已完成' : (t.isNotified ? '已提醒' : (t.remindTime > Date.now() ? '将于 ' + fmtTime(t.remindTime) + ' 提醒' : '已过提醒时间'))}</div>
          </div>
          <button class="btn-sm" data-tdel="${t.id}">删除</button>
        </div>`).join('') : `<div class="empty-hint">${focus ? '这一天还没有待办' : '还没有待办，先添加一条吧'}</div>`}
    </div>`);

  const save = () => {
    const content = $('#todoContent', body).value.trim();
    if (!content) { showToast('先写下要做什么'); return; }
    const date = $('#todoDate', body).value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { showToast('请选择日期'); return; }
    const time = $('#todoTime', body).value;
    state.todos.unshift({
      id: uid(), content,
      date, time: time || '',
      remindTime: todoRemindTime(date, time),
      isCompleted: false, isNotified: false
    });
    persist();
    renderTodoPage();
    renderHomePage();
    showToast('待办已保存');
  };
  $('#todoSave', body).addEventListener('click', save);
  $('#todoContent', body).addEventListener('keydown', e => { if (e.key === 'Enter') save(); });

  /* 勾选：完成置灰划线；完成的待办不再提醒 */
  $$('[data-tchk]', body).forEach(btn => btn.addEventListener('click', () => {
    const t = state.todos.find(x => x.id === btn.dataset.tchk);
    if (!t) return;
    t.isCompleted = !t.isCompleted;
    if (t.isCompleted) t.isNotified = true;
    persist();
    renderTodoPage();
    renderHomePage();
  }));

  const del = async id => {
    const ok = await confirmDialog('删除待办', '删除后不可恢复。', '删除', true);
    if (!ok) return;
    state.todos = state.todos.filter(t => t.id !== id);
    persist();
    renderTodoPage();
    renderHomePage();
    showToast('已删除');
  };
  $$('[data-tdel]', body).forEach(btn => btn.addEventListener('click', () => del(btn.dataset.tdel)));
  /* 长按 600ms 删除（与删除按钮双保险；左滑删除在手势库缺省下易误触，这里以长按为主） */
  $$('.todo-row', body).forEach(row => {
    let timer = null;
    row.addEventListener('pointerdown', e => {
      if (e.target.closest('[data-tchk],[data-tdel]')) return;
      timer = setTimeout(() => { timer = null; del(row.dataset.tid); }, 600);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => row.addEventListener(ev, () => {
      if (timer) { clearTimeout(timer); timer = null; }
    }));
  });

  const clearBtn = $('#todoClearFocus', body);
  if (clearBtn) clearBtn.addEventListener('click', () => { todoFocusDate = ''; renderTodoPage(); });
}

/* 提醒巡检：不依赖单个 setTimeout——
 * ① 启动加载完成后立即检查一次（补发刷新/关页期间错过的提醒）；
 * ② 15 秒周期循环检查（比每分钟更密，覆盖「提醒时间刚好在两次刷新之间」的场景）；
 * ③ visibilitychange 重新可见时立即检查（切后台回来的补发）。
 * 到达 remindTime 且未完成、未通知 → 标记 isNotified（防重复）→ 前台 Toast + 后台系统通知 */
function checkTodoReminders() {
  if (!state || !Array.isArray(state.todos)) return;
  const now = Date.now();
  let changed = false;
  state.todos.forEach(t => {
    if (!t || t.isCompleted || t.isNotified || !(Number(t.remindTime) > 0)) return;
    if (now < t.remindTime) return;
    t.isNotified = true;
    changed = true;
    showToast('待办时间到了：' + truncateNotifyText(t.content, 30));
    /* 系统通知：默认开启，仅受【后台通知】总开关控制；页面在前台时 sendSystemNotification 自行抑制 */
    if (state.settings.notifyEnabled === true) {
      sendSystemNotification('待办提醒', t.content, 'todo-' + t.id, { page: 'sub', name: 'todo' });
    }
  });
  if (changed) {
    persist();
    if (currentRoute.page === 'home') renderHomePage();
  }
}

/* =========================================================
 * 二十一、存储感知与备份
 * ========================================================= */
function renderStoragePage() {
  const msgCount = state.roles.reduce((n, r) => n + (state.chats[r.id] || []).length, 0);
  const callCount = state.roles.reduce((n, r) =>
    n + (state.chats[r.id] || []).filter(m => m.type === 'call').length, 0);
  /* 聊天图片消息张数（纳入存储感知统计） */
  const chatImgCount = state.roles.reduce((n, r) =>
    n + (state.chats[r.id] || []).reduce((k, m) => k + (Array.isArray(m.images) ? m.images.length : 0), 0), 0);
  const stickerCount = state.stickers.length;
  const momentCount = state.moments.length;
  const letterCount = state.letters.length;

  const body = subShell('存储感知', `
    <div class="storage-hero">
      <div class="small">本地持久化 + 导出备份</div>
      <div class="big" id="usageVal">计算中…</div>
      <div class="small" id="usageNote">存储模式：${Storage.mode === 'idb' ? 'IndexedDB' : Storage.mode === 'local' ? 'localStorage' : '仅内存'}</div>
    </div>
    <div class="stat-grid">
      <div class="stat-cell"><div class="num">${msgCount}</div><div class="lbl">聊天消息</div></div>
      <div class="stat-cell"><div class="num">${state.roles.length}</div><div class="lbl">梦角</div></div>
      <div class="stat-cell"><div class="num">${state.cards.length}</div><div class="lbl">字卡</div></div>
      <div class="stat-cell"><div class="num">${stickerCount}</div><div class="lbl">表情包</div></div>
      <div class="stat-cell"><div class="num">${petData().enabled ? '开启' : '关闭'}</div><div class="lbl">桌面宠物</div></div>
      <div class="stat-cell"><div class="num">${petData().image ? fmtBytes(Math.round(petData().image.length * 0.75)) : '未上传'}</div><div class="lbl">桌宠图片</div></div>
      <div class="stat-cell"><div class="num">${state.beautify.glassOn ? '磨砂 ' + state.beautify.glassOpacity + '%' : '纯色'}</div><div class="lbl">组件外观</div></div>
      <div class="stat-cell"><div class="num">${state.settings.emojiSendChance ?? 15}%</div><div class="lbl">表情包发送概率</div></div>
      <div class="stat-cell"><div class="num">${letterCount}</div><div class="lbl">信件</div></div>
      <div class="stat-cell"><div class="num">${state.readData.books.length}</div><div class="lbl">共读书籍</div></div>
      <div class="stat-cell"><div class="num">${state.music.list.length}</div><div class="lbl">歌单</div></div>
      <div class="stat-cell"><div class="num">${musicCoverURL() ? '已设置' : '未设置'}</div><div class="lbl">唱片封面</div></div>
      <div class="stat-cell"><div class="num">${state.photoWall.images.length} / 1</div><div class="lbl">照片墙</div></div>
      <div class="stat-cell"><div class="num">${momentCount}</div><div class="lbl">空间动态</div></div>
      <div class="stat-cell"><div class="num">${state.moments.reduce((n, m) => n + ((m.images || []).length), 0)}</div><div class="lbl">动态图片</div></div>
      <div class="stat-cell"><div class="num">${chatImgCount}</div><div class="lbl">聊天图片</div></div>
      <div class="stat-cell"><div class="num">${state.settings.burstEnabled === false ? '关闭' : state.settings.burstMin + '~' + state.settings.burstMax}</div><div class="lbl">连发字卡</div></div>
      <div class="stat-cell"><div class="num">${state.userPatCards.length} / ${state.taPatCards.length}</div><div class="lbl">拍一拍字卡（我/${esc(taName())}）</div></div>
      <div class="stat-cell"><div class="num">${callCount}</div><div class="lbl">通话记录</div></div>
      <div class="stat-cell"><div class="num">${state.pomodoro.records.length}</div><div class="lbl">专注记录</div></div>
      <div class="stat-cell"><div class="num">${state.redPackets.length}</div><div class="lbl">转账记录</div></div>
      <div class="stat-cell"><div class="num">${state.todos.length}</div><div class="lbl">待办</div></div>
      <div class="stat-cell"><div class="num">${state.redPackets.filter(r => r.status === 'pending').length + state.giftHistory.filter(g => g.claimed !== true && g.status !== 'claimed' && g.status !== 'returned').length}</div><div class="lbl">待接收</div></div>
      <div class="stat-cell"><div class="num">${state.redPackets.filter(r => r.direction === 'in').length}</div><div class="lbl">${esc(taName())}转来</div></div>
      <div class="stat-cell"><div class="num">${state.ledger.length}</div><div class="lbl">记账记录</div></div>
      <div class="stat-cell"><div class="num">${state.anniversaries.length}</div><div class="lbl">纪念日</div></div>
      <div class="stat-cell"><div class="num">${state.snapshots.length}</div><div class="lbl">留影卡片</div></div>
      <div class="stat-cell"><div class="num">${state.coinHistory.length}</div><div class="lbl">抛硬币记录</div></div>
      <div class="stat-cell"><div class="num">${state.linkBank.length}</div><div class="lbl">题库</div></div>
      <div class="stat-cell"><div class="num">${state.linkTests.length}</div><div class="lbl">链接测试</div></div>
      <div class="stat-cell"><div class="num">${state.giftHistory.filter(g => g.direction !== 'in').length} / ${state.giftHistory.filter(g => g.direction === 'in').length}</div><div class="lbl">我送 / ${esc(taName())}送</div></div>
      <div class="stat-cell"><div class="num" id="storageWalletBal">¥${(Math.round(walletBalance() * 100) / 100).toFixed(2)}</div><div class="lbl">钱包余额</div></div>
      <div class="stat-cell"><div class="num">${walletTransactions().length}</div><div class="lbl">钱包交易笔数</div></div>
    </div>
    <div class="panel">
      <div class="panel-title">存储体检</div>
      <div class="storage-usage-line" id="storageUsageLine">正在统计…</div>
      <div class="sb-list" id="storageBreakdown"></div>
      <div class="tip-box" style="margin-top:10px">
        聊天记录、字卡、书籍正文与图片已拆分存入 IndexedDB，不再受 localStorage 5MB 限制；聊天记录全量保存，永不截断。
      </div>
    </div>
    <div class="panel">
      <div class="panel-title">数据管理</div>
      <div class="btn-row">
        <button class="btn primary" id="exportAll" style="flex:1">⬇ 导出全部备份</button>
        <button class="btn ghost" id="importAll" style="flex:1">⬆ 导入备份</button>
      </div>
      <button class="btn danger block" id="clearAll" style="margin-top:10px">清空全部数据</button>
      <div class="tip-box" style="margin-top:10px">
        浏览器本地存储容量有限，图片会自动压缩。请定期导出备份；概率与行为参数也会一并写入备份。
      </div>
    </div>`);

  /* 真实占用：优先用浏览器给出的 usage / quota（IndexedDB 与 CacheStorage 都计入其中） */
  const bytes = new Blob([JSON.stringify(state)]).size;
  const el = $('#usageVal');
  const line = $('#storageUsageLine');
  const modeText = Storage.mode === 'idb' ? 'IndexedDB 分表' : Storage.mode === 'local' ? 'localStorage（兜底）' : '仅内存';
  if (navigator.storage && navigator.storage.estimate) {
    navigator.storage.estimate().then(est => {
      const used = Number(est.usage) || bytes;
      const quota = Number(est.quota) || 0;
      if (el) el.textContent = fmtBytes(used);
      const note = $('#usageNote');
      if (note) note.textContent = '存储模式：' + modeText + ' · 数据约 ' + fmtBytes(bytes);
      if (line) {
        line.textContent = '浏览器已用 ' + fmtBytes(used)
          + (quota ? ' / 配额 ' + fmtBytes(quota) + '（' + Math.min(100, Math.round(used / quota * 100)) + '%）' : '');
      }
    }).catch(() => {
      if (el) el.textContent = fmtBytes(bytes);
      if (line) line.textContent = '浏览器已用 ' + fmtBytes(bytes);
    });
  } else {
    if (el) el.textContent = fmtBytes(bytes);
    if (line) line.textContent = '浏览器已用 ' + fmtBytes(bytes);
  }

  /* ---------- 存储体检：分类统计各自占用，从大到小排序 ---------- */
  const jsonBytes = v => { try { return new Blob([JSON.stringify(v)]).size; } catch (e) { return 0; } };
  const renderBreakdown = () => {
    const box = $('#storageBreakdown');
    if (!box) return;
    const chatsBytes = state.roles.reduce((n, r) => n + jsonBytes(state.chats[r.id] || []), 0);
    const booksBytes = state.readData.books.reduce((n, b) => n + jsonBytes(b.paras || []), 0);
    const stickersBytes = jsonBytes(state.stickers || []);
    const cardsBytes = jsonBytes({ c: state.cards, g: state.cardGroups, p: [state.userPatCards, state.taPatCards] });
    const imgBytes = jsonBytes([
      state.beautify, state.photoWall, state.pet, state.couple,
      state.moments.map(m => m.images || []), state.music,
      state.readData.chat, state.snapshots, state.roles.map(r => r.avatar)
    ]);
    const total = jsonBytes(state);
    const other = Math.max(0, total - chatsBytes - booksBytes - stickersBytes - cardsBytes - imgBytes);
    const rows = [
      ['聊天记录', chatsBytes],
      ['一起读书 · 书籍正文', booksBytes],
      ['表情包', stickersBytes],
      ['字卡库', cardsBytes],
      ['图片资源（头像 / 壁纸 / 动态图）', imgBytes],
      ['其它设置与记录', other]
    ].sort((a, b) => b[1] - a[1]);
    const max = Math.max(1, ...rows.map(r => r[1]));
    let html = rows.map(([name, size]) => `
      <div class="sb-row">
        <div class="sb-top"><span class="sb-name">${esc(name)}</span><span class="sb-size">${fmtBytes(size)}</span></div>
        <div class="sb-bar"><i style="width:${Math.max(2, Math.round(size / max * 100))}%"></i></div>
      </div>`).join('');

    /* localStorage 逐键统计：迁移完成后通常为空，这里让用户一眼看清有没有旧残留 */
    const localRows = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        localRows.push([k, new Blob([localStorage.getItem(k) || '']).size]);
      }
    } catch (e) { /* 隐私模式可能不可用，忽略 */ }
    localRows.sort((a, b) => b[1] - a[1]);
    html += `<div class="sb-section">localStorage 键值（旧版残留）</div>`;
    if (localRows.length) {
      html += localRows.map(([k, size]) => `
        <div class="sb-row">
          <div class="sb-top"><span class="sb-name">${esc(k)}</span><span class="sb-size">${fmtBytes(size)}</span></div>
        </div>`).join('');
    } else {
      html += `<div class="sb-empty">无残留，已全部迁移到 IndexedDB</div>`;
    }
    box.innerHTML = html;
  };
  requestAnimationFrame(renderBreakdown);

  $('#exportAll').addEventListener('click', () => {
    downloadJSON(state, `梦之信使备份-${todayKey()}.json`);
    showToast('完整备份已导出');
  });

  $('#importAll').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (!data || typeof data !== 'object' || (!Array.isArray(data.roles) && !data.settings)) {
          showToast('备份文件格式不正确');
          return;
        }
        const ok = await confirmDialog('导入备份', '导入会覆盖当前全部数据，确定继续吗？', '导入', true);
        if (!ok) return;
        applyImportedState(data);
        showToast('备份已导入');
      } catch (e) {
        showToast('读取备份失败，请检查文件');
      }
    });
    input.click();
  });

  $('#clearAll').addEventListener('click', clearAllData);
}

async function applyImportedState(data) {
  state = mergeState(data);
  typingMap.clear();
  replyQueue.clear();
  replyBusy.clear();
  chatGenMap.clear();
  clearCallTimers();
  callState.status = 'idle';
  callState.roleId = null;
  hideCallMini();
  $('#callLayer').classList.remove('show');
  $('#callLayer').innerHTML = '';
  clearInterval(pomo.tickId);
  pomo.tickId = null;
  pomo.running = false;
  pomo.total = 1500;
  pomo.remain = 1500;
  pomo.task = '一起专注';
  /* 导入会替换歌单：先释放旧 Blob URL，再按新数据重建运行时列表 */
  musicReleaseAll();
  musicTracksInit();
  applyTheme();
  /* 导入会整体替换数据：先清掉旧的分表记录，避免旧聊天 / 旧书籍残留占用空间 */
  if (Storage.mode === 'idb') {
    await Promise.all([DB.clear(STORE_CHATS), DB.clear(STORE_BOOKS), DB.clear(STORE_CARDS), DB.clear(STORE_ASSETS)]);
    assetMemo.clear();
    assetById.clear();
    assetWritten.clear();
  }
  persist(true);
  routeStack = [];
  currentRoute = { page: 'home' };
  applyRoute();
  scheduleIncoming();
  checkLetterReplies();
  checkMomentInteractions();
}

async function clearAllData() {
  const ok = await confirmDialog(
    '清空全部数据',
    '会删除所有梦角、聊天记录、字卡、表情、信件、动态、定位和专注记录，且无法恢复。建议先导出备份。',
    '确认清空',
    true
  );
  if (!ok) return;
  clearCallTimers();
  callState.status = 'idle';
  callState.roleId = null;
  hideCallMini();
  $('#callLayer').classList.remove('show');
  $('#callLayer').innerHTML = '';
  clearInterval(pomo.tickId);
  pomo.tickId = null;
  pomo.running = false;
  pomo.total = 1500;
  pomo.remain = 1500;
  pomo.task = '一起专注';
  /* 清空数据：释放并清空一起听的运行时歌单 */
  musicReleaseAll();
  musicTracks = [];
  musicIndex = -1;
  state.music = { name: '', cover: '', playMode: 'sequence', list: [] };
  typingMap.clear();
  replyQueue.clear();
  replyBusy.clear();
  chatGenMap.clear();
  /* 清空 IndexedDB 分表：聊天 / 书籍 / 字卡 / 图片资源，彻底释放空间 */
  if (Storage.mode === 'idb') {
    await Promise.all([DB.clear(STORE_CHATS), DB.clear(STORE_BOOKS), DB.clear(STORE_CARDS), DB.clear(STORE_ASSETS)]);
    assetMemo.clear();
    assetById.clear();
    assetWritten.clear();
  }
  state = defaultState();
  applyTheme();
  persist(true);
  routeStack = [];
  currentRoute = { page: 'home' };
  applyRoute();
  scheduleIncoming();
  showToast('全部数据已清空');
}

/* =========================================================
 * 二十二、概率与行为设置
 * ========================================================= */
function renderProbabilityPage() {
  const s = state.settings;
  const dn = esc(taName());
  subShell('概率与行为', `
    <div class="panel">
      <div class="panel-title">字卡回复</div>
      ${sliderRowHTML('字卡回复概率', '未触发回复时，在你的消息下显示「已读」小字', 'replyChance', s.replyChance, 0, 100, '%')}
      ${sliderRowHTML('表情包发送概率', `普通回复命中后，本次改为发送一张共享表情包的概率；表情包与「表情包管理」共用同一套库，库为空时自动回退为字卡回复；表情包单条发送，不参与拼接与连发`, 'emojiSendChance', s.emojiSendChance, 0, 100, '%')}
      ${sliderRowHTML('最短回复时间', `${dn} 收到消息后至少等待多久再回复，单位：秒；0 表示不等待`, 'replyDelayMin', s.replyDelayMin, 0, 300, '秒')}
      ${sliderRowHTML('最长回复时间', `不得小于最短回复时间；对所有 ${dn} 消息（字卡回复、礼物感谢、收款提示、链接测试结果、通话与空间互动等）生效`, 'replyDelayMax', s.replyDelayMax, 0, 300, '秒')}
      ${sliderRowHTML('拼字卡概率', '命中概率时拼接多张字卡，未命中则只发单张；对所有字卡回复生效', 'mergeChance', s.mergeChance, 0, 100, '%')}
      ${sliderRowHTML('拼接最少张数', '最少 2 张；字卡不足时按实际数量拼接', 'mergeMin', s.mergeMin, 2, 6, '张')}
      ${sliderRowHTML('拼接最多张数', '最大值不得小于最小值', 'mergeMax', s.mergeMax, 2, 6, '张')}
      <div class="slider-row">
        <div class="slider-head"><label>拼接分隔符</label></div>
        <select class="select" id="setSeparator">
          <option value="，"${s.mergeSeparator === '，' ? ' selected' : ''}>中文逗号「，」</option>
          <option value="、"${s.mergeSeparator === '、' ? ' selected' : ''}>顿号「、」</option>
          <option value=" "${s.mergeSeparator === ' ' ? ' selected' : ''}>空格</option>
          <option value="&#10;"${s.mergeSeparator === '\n' ? ' selected' : ''}>换行</option>
        </select>
      </div>
      <div class="slider-row row-between" style="margin-top:6px;border-top:1px solid var(--line);padding-top:10px">
        <div>
          <div style="font-size:13px">连发字卡</div>
          <div class="muted" id="burstNote">${dn} 每次回复会连发 ${s.burstMin}~${s.burstMax} 条字卡消息</div>
        </div>
        <label class="switch"><input type="checkbox" id="setBurst" ${s.burstEnabled !== false ? 'checked' : ''}><span class="slider"></span></label>
      </div>
      <div id="burstWrap"${s.burstEnabled === false ? ' class="range-off"' : ''}>
        ${sliderRowHTML('连发最少条数', '一轮回复至少发几条字卡消息', 'burstMin', s.burstMin, 1, 6, '条')}
        ${sliderRowHTML('连发最多条数', '最大值不得小于最小值；关闭开关后只发 1 条', 'burstMax', s.burstMax, 1, 6, '条')}
      </div>
    </div>
    <div class="panel">
      <div class="panel-title">聊天互动</div>
      ${sliderRowHTML(`${dn}撤回消息概率`, `${dn} 发出文字或表情消息后，按该概率在数秒后撤回`, 'taRecallChance', s.taRecallChance, 0, 100, '%')}
      ${sliderRowHTML(`${dn}引用消息概率`, `${dn} 回复时按该概率引用你之前的一条消息`, 'taQuoteChance', s.taQuoteChance, 0, 100, '%')}
    </div>
    <div class="panel">
      <div class="panel-title">语音来电</div>
      ${sliderRowHTML('来电触发概率', '每 3~6 分钟判定一次，判定时再乘以该概率', 'callChance', s.callChance, 0, 100, '%')}
      ${sliderRowHTML('梦角接听概率', `我打给${dn}时是否接听`, 'answerChance', s.answerChance, 0, 100, '%')}
    </div>
    <div class="panel">
      <div class="panel-title">转账、礼物与链接</div>
      ${sliderRowHTML(`${dn}收款概率`, `我发起转账后${dn}是否收款`, 'redPacketClaimChance', s.redPacketClaimChance, 0, 100, '%')}
      ${sliderRowHTML(`${dn}主动转账概率`, `每 30~90 分钟判定一次，命中后${dn}主动转来一笔转账`, 'taRedPacketChance', s.taRedPacketChance, 0, 100, '%')}
      ${sliderRowHTML(`${dn}送礼概率`, `每 4~8 小时判定一次，命中后${dn}主动送你一份礼物`, 'taGiftChance', s.taGiftChance, 0, 100, '%')}
      <div class="muted" style="font-size:12px;line-height:1.6;margin-top:6px">链接测试中，${dn} 会在每题的选项里完全随机作答，不设正确率参数。</div>
    </div>
    <div class="panel">
      <div class="panel-title">梦角定位</div>
      ${sliderRowHTML('定位刷新冷却时间', '每次随机刷新后需等待的秒数；0 表示不限制，最长 3600 秒，每个梦角独立计算', 'locationCooldown', s.locationCooldown, 0, 3600, '秒')}
    </div>
    <div class="panel">
      <div class="panel-title">留影时刻</div>
      <div class="slider-row row-between">
        <div>
          <div style="font-size:13px">${dn}自动截屏</div>
          <div class="muted">开启后${dn}会按间隔与概率自动截取一段对话留存</div>
        </div>
        <label class="switch"><input type="checkbox" id="setAutoSnapshot" ${s.autoSnapshotEnabled ? 'checked' : ''}><span class="slider"></span></label>
      </div>
      <div id="autoSnapshotWrap"${s.autoSnapshotEnabled ? '' : ' class="range-off"'}>
        ${sliderRowHTML('自动截屏概率', '每次判定时真正截取的概率', 'autoSnapshotChance', s.autoSnapshotChance, 0, 100, '%')}
        ${sliderRowHTML('自动截屏间隔', '单位：分钟', 'autoSnapshotInterval', s.autoSnapshotInterval, 30, 720, '分钟')}
        ${sliderRowHTML('截取条数', '随机截取多少条聊天记录', 'snapshotCount', s.snapshotCount, 3, 20, '条')}
      </div>
    </div>
    <div class="panel">
      <div class="panel-title">字卡主动回复</div>
      <div class="slider-row row-between">
        <div>
          <div style="font-size:13px">主动回复开关</div>
          <div class="muted" id="proactiveNote">${dn} 每隔 ${s.proactiveMin}~${s.proactiveMax} 分钟判定一次，${s.proactiveChance}% 概率主动给你发消息</div>
        </div>
        <label class="switch"><input type="checkbox" id="setProactive" ${s.proactiveEnabled !== false ? 'checked' : ''}><span class="slider"></span></label>
      </div>
      <div id="proactiveWrap"${s.proactiveEnabled === false ? ' class="range-off"' : ''}>
        ${sliderRowHTML('主动回复概率', `每次判定时${dn}真正发消息的概率`, 'proactiveChance', s.proactiveChance, 0, 100, '%')}
        ${sliderRowHTML('主动判定最短间隔', '单位：分钟', 'proactiveMin', s.proactiveMin, 1, 240, '分钟')}
        ${sliderRowHTML('主动判定最长间隔', '不得小于最短间隔', 'proactiveMax', s.proactiveMax, 1, 240, '分钟')}
      </div>
      <div class="muted" style="margin-top:4px">字卡为空时不发送；与用户发消息后的回复判定互不影响。</div>
    </div>
    <div class="panel">
      <div class="panel-title">一起专注</div>
      ${sliderRowHTML('一起专注梦角发言概率', `专注过程中每 3~8 分钟判定一次，命中后${dn}说一句话陪伴`, 'pomodoroSpeakChance', s.pomodoroSpeakChance, 0, 100, '%')}
    </div>
    <div class="panel">
      <div class="panel-title">空间互动</div>
      ${sliderRowHTML('空间点赞概率', `发布动态后${dn}点赞的概率`, 'spaceLikeChance', s.spaceLikeChance, 0, 100, '%')}
      ${sliderRowHTML('空间评论概率', `发布动态后${dn}评论的概率，评论由字卡拼接`, 'spaceCommentChance', s.spaceCommentChance, 0, 100, '%')}
    </div>
    <div class="panel">
      <div class="panel-title">${dn}主动发空间</div>
      <div class="slider-row row-between">
        <div>
          <div style="font-size:13px">主动发空间开关</div>
          <div class="muted" id="spaceProactiveNote">${dn} 每隔 ${s.spaceProactiveMin}~${s.spaceProactiveMax} 分钟判定一次，${s.spaceProactiveChance}% 概率主动发布一条动态</div>
        </div>
        <label class="switch"><input type="checkbox" id="setSpaceProactive" ${s.spaceProactiveEnabled !== false ? 'checked' : ''}><span class="slider"></span></label>
      </div>
      <div id="spaceProactiveWrap"${s.spaceProactiveEnabled === false ? ' class="range-off"' : ''}>
        ${sliderRowHTML('主动发空间概率', `每次判定时${dn}真正发布动态的概率`, 'spaceProactiveChance', s.spaceProactiveChance, 0, 100, '%')}
        ${sliderRowHTML('判定最短间隔', '单位：分钟', 'spaceProactiveMin', s.spaceProactiveMin, 1, 480, '分钟')}
        ${sliderRowHTML('判定最长间隔', '不得小于最短间隔', 'spaceProactiveMax', s.spaceProactiveMax, 1, 480, '分钟')}
      </div>
      <div class="muted" style="margin-top:4px">动态内容由字卡拼接生成；字卡库为空时使用兜底文案（如「我想你了」）。判定时间戳会持久化，刷新后接着算。</div>
    </div>
    <div class="panel">
      <div class="panel-title">拍一拍</div>
      ${sliderRowHTML(`${dn}拍我概率`, '每次冷却到点后按该概率拍你', 'patChance', s.patChance, 0, 100, '%')}
      ${sliderRowHTML('拍一拍冷却', '两次拍一拍之间的最小间隔，单位秒；0 表示不限制', 'patCooldown', s.patCooldown, 0, 120, '秒')}
      <div class="muted" style="margin-top:4px">双击聊天页 ${dn} 的头像（顶部头像或 ${dn} 消息气泡旁的头像）即可拍 ${dn}，两个入口共用冷却；拍一拍固定单张字卡、不参与字卡拼接（在「拍一拍」页配置），不参与连发条数；通话中 ${dn} 不主动拍。</div>
    </div>
    <div class="panel">
      <div class="panel-title">一起读书</div>
      ${sliderRowHTML(`${dn}接受共读概率`, '我发起共读邀请后，2 秒内按该概率判定是否接受', 'readTogetherAcceptChance', s.readTogetherAcceptChance, 0, 100, '%')}
      ${sliderRowHTML('陪读消息发送间隔', `共读时每隔多少分钟由字卡弹一条陪读消息；0 表示关闭（不发送陪读消息）`, 'readCompanionInterval', s.readCompanionInterval, 0, 60, '分钟')}
      ${sliderRowHTML(`${dn}主动邀请共读概率`, `每隔约 25~55 分钟判定一次，命中后 ${dn} 在聊天里发来共读邀请卡片`, 'readInviteChance', s.readInviteChance, 0, 100, '%')}
      <div class="muted" style="margin-top:4px">陪读消息只出现在阅读界面的悬浮小聊天框，不会写进主聊天；字卡为空时不发送。</div>
    </div>
    <div class="tip-box">修改立即保存。所有概率参数都会写入本地存储、统计与备份文件。</div>`);

  bindProbSlider('replyChance', 'replyChanceRange', 'replyChanceNum', 0, 100);
  bindProbSlider('emojiSendChance', 'emojiSendChanceRange', 'emojiSendChanceNum', 0, 100);
  bindProbSlider('replyDelayMin', 'replyDelayMinRange', 'replyDelayMinNum', 0, 300);
  bindProbSlider('replyDelayMax', 'replyDelayMaxRange', 'replyDelayMaxNum', 0, 300);
  bindProbSlider('taRecallChance', 'taRecallChanceRange', 'taRecallChanceNum', 0, 100);
  bindProbSlider('taQuoteChance', 'taQuoteChanceRange', 'taQuoteChanceNum', 0, 100);
  bindProbSlider('locationCooldown', 'locationCooldownRange', 'locationCooldownNum', 0, 3600);
  bindProbSlider('mergeChance', 'mergeChanceRange', 'mergeChanceNum', 0, 100);
  bindProbSlider('mergeMin', 'mergeMinRange', 'mergeMinNum', 2, 6);
  bindProbSlider('mergeMax', 'mergeMaxRange', 'mergeMaxNum', 2, 6);
  bindProbSlider('burstMin', 'burstMinRange', 'burstMinNum', 1, 6);
  bindProbSlider('burstMax', 'burstMaxRange', 'burstMaxNum', 1, 6);
  bindProbSlider('callChance', 'callChanceRange', 'callChanceNum', 0, 100);
  bindProbSlider('answerChance', 'answerChanceRange', 'answerChanceNum', 0, 100);
  bindProbSlider('redPacketClaimChance', 'redPacketClaimChanceRange', 'redPacketClaimChanceNum', 0, 100);
  bindProbSlider('taRedPacketChance', 'taRedPacketChanceRange', 'taRedPacketChanceNum', 0, 100);
  bindProbSlider('taGiftChance', 'taGiftChanceRange', 'taGiftChanceNum', 0, 100);
  bindProbSlider('autoSnapshotChance', 'autoSnapshotChanceRange', 'autoSnapshotChanceNum', 0, 100);
  bindProbSlider('autoSnapshotInterval', 'autoSnapshotIntervalRange', 'autoSnapshotIntervalNum', 30, 720);
  bindProbSlider('snapshotCount', 'snapshotCountRange', 'snapshotCountNum', 3, 20);
  bindProbSlider('pomodoroSpeakChance', 'pomodoroSpeakChanceRange', 'pomodoroSpeakChanceNum', 0, 100);
  bindProbSlider('spaceLikeChance', 'spaceLikeChanceRange', 'spaceLikeChanceNum', 0, 100);
  bindProbSlider('spaceCommentChance', 'spaceCommentChanceRange', 'spaceCommentChanceNum', 0, 100);
  bindProbSlider('proactiveChance', 'proactiveChanceRange', 'proactiveChanceNum', 0, 100);
  bindProbSlider('proactiveMin', 'proactiveMinRange', 'proactiveMinNum', 1, 240);
  bindProbSlider('proactiveMax', 'proactiveMaxRange', 'proactiveMaxNum', 1, 240);
  bindProbSlider('spaceProactiveChance', 'spaceProactiveChanceRange', 'spaceProactiveChanceNum', 0, 100);
  bindProbSlider('spaceProactiveMin', 'spaceProactiveMinRange', 'spaceProactiveMinNum', 1, 480);
  bindProbSlider('spaceProactiveMax', 'spaceProactiveMaxRange', 'spaceProactiveMaxNum', 1, 480);
  bindProbSlider('patChance', 'patChanceRange', 'patChanceNum', 0, 100);
  bindProbSlider('patCooldown', 'patCooldownRange', 'patCooldownNum', 0, 120);
  bindProbSlider('readTogetherAcceptChance', 'readTogetherAcceptChanceRange', 'readTogetherAcceptChanceNum', 0, 100);
  bindProbSlider('readCompanionInterval', 'readCompanionIntervalRange', 'readCompanionIntervalNum', 0, 60);
  bindProbSlider('readInviteChance', 'readInviteChanceRange', 'readInviteChanceNum', 0, 100);
  syncProactiveInputs();
  syncBurstInputs();
  syncAutoSnapshotInputs();
  syncSpaceProactiveInputs();

  $('#setSeparator').addEventListener('change', e => {
    state.settings.mergeSeparator = e.target.value;
    persist();
  });
  $('#setAutoSnapshot').addEventListener('change', e => {
    state.settings.autoSnapshotEnabled = e.target.checked;
    persist();
    syncAutoSnapshotInputs();
  });
  $('#setProactive').addEventListener('change', e => {
    state.settings.proactiveEnabled = e.target.checked;
    persist();
    syncProactiveInputs();
  });
  $('#setBurst').addEventListener('change', e => {
    state.settings.burstEnabled = e.target.checked;
    persist();
    syncBurstInputs();
  });
  $('#setSpaceProactive').addEventListener('change', e => {
    state.settings.spaceProactiveEnabled = e.target.checked;
    persist();
    syncSpaceProactiveInputs();
  });
}

/* 自动留影开关关闭时，概率与间隔控件置灰不可用 */
function syncAutoSnapshotInputs() {
  const off = !state.settings.autoSnapshotEnabled;
  const wrap = $('#autoSnapshotWrap');
  if (wrap) wrap.classList.toggle('range-off', off);
  ['autoSnapshotChanceRange', 'autoSnapshotChanceNum', 'autoSnapshotIntervalRange', 'autoSnapshotIntervalNum', 'snapshotCountRange', 'snapshotCountNum'].forEach(id => {
    const el = $('#' + id);
    if (el) el.disabled = off;
  });
}

/* 主动写信开关关闭时，信件页的间隔控件置灰不可用 */
function syncLetterAutoInputs() {
  const off = !state.settings.letterAutoEnabled;
  const wrap = $('#letterAutoWrap');
  if (wrap) wrap.classList.toggle('range-off', off);
  ['letterAutoIntervalRange', 'letterAutoIntervalNum'].forEach(id => {
    const el = $('#' + id);
    if (el) el.disabled = off;
  });
}

/* 主动写信说明文字随参数实时更新 */
function updateLetterAutoNote() {
  const note = $('#letterAutoNote');
  if (note) note.textContent = `开启后 ${taName()} 每隔 ${state.settings.letterAutoInterval} 分钟自动写一封信放进信件列表`;
}

/* 主动回复开关关闭时，概率与间隔控件置灰不可用 */
function syncProactiveInputs() {
  const off = state.settings.proactiveEnabled === false;
  const wrap = $('#proactiveWrap');
  if (wrap) wrap.classList.toggle('range-off', off);
  ['proactiveChanceRange', 'proactiveChanceNum', 'proactiveMinRange', 'proactiveMinNum', 'proactiveMaxRange', 'proactiveMaxNum'].forEach(id => {
    const el = $('#' + id);
    if (el) el.disabled = off;
  });
}

/* 主动回复说明文字随参数实时更新 */
function updateProactiveNote() {
  const note = $('#proactiveNote');
  if (note) note.textContent = `${taName()} 每隔 ${state.settings.proactiveMin}~${state.settings.proactiveMax} 分钟判定一次，${state.settings.proactiveChance}% 概率主动给你发消息`;
}

/* TA主动发空间开关关闭时，概率与间隔控件置灰不可用 */
function syncSpaceProactiveInputs() {
  const off = state.settings.spaceProactiveEnabled === false;
  const wrap = $('#spaceProactiveWrap');
  if (wrap) wrap.classList.toggle('range-off', off);
  ['spaceProactiveChanceRange', 'spaceProactiveChanceNum', 'spaceProactiveMinRange', 'spaceProactiveMinNum', 'spaceProactiveMaxRange', 'spaceProactiveMaxNum'].forEach(id => {
    const el = $('#' + id);
    if (el) el.disabled = off;
  });
  updateSpaceProactiveNote();
}

/* TA主动发空间说明文字随参数实时更新 */
function updateSpaceProactiveNote() {
  const note = $('#spaceProactiveNote');
  if (note) note.textContent = state.settings.spaceProactiveEnabled === false
    ? '开关关闭后 ' + taName() + ' 不会主动发布空间动态'
    : `${taName()} 每隔 ${state.settings.spaceProactiveMin}~${state.settings.spaceProactiveMax} 分钟判定一次，${state.settings.spaceProactiveChance}% 概率主动发布一条动态`;
}

/* 连发开关关闭时置灰；说明文字随条数实时更新 */
function syncBurstInputs() {
  const off = state.settings.burstEnabled === false;
  const wrap = $('#burstWrap');
  if (wrap) wrap.classList.toggle('range-off', off);
  ['burstMinRange', 'burstMinNum', 'burstMaxRange', 'burstMaxNum'].forEach(id => {
    const el = $('#' + id);
    if (el) el.disabled = off;
  });
  updateBurstNote();
}

function updateBurstNote() {
  const note = $('#burstNote');
  if (!note) return;
  note.textContent = state.settings.burstEnabled === false
    ? '已关闭连发，' + taName() + ' 每次只发 1 条字卡消息'
    : `${taName()} 每次回复会连发 ${state.settings.burstMin}~${state.settings.burstMax} 条字卡消息`;
}

function sliderRowHTML(label, desc, key, value, min, max, unit) {
  return `
    <div class="slider-row">
      <div class="slider-head">
        <div>
          <div style="font-size:13px">${label}</div>
          <div class="muted">${desc}</div>
        </div>
        <div style="display:flex;align-items:center;gap:4px">
          <input class="num" id="${key}Num" type="number" min="${min}" max="${max}" value="${value}">
          <span class="muted">${unit}</span>
        </div>
      </div>
      <input type="range" id="${key}Range" min="${min}" max="${max}" value="${value}">
    </div>`;
}

function bindProbSlider(key, rangeId, numId, min, max) {
  const range = $('#' + rangeId);
  const num = $('#' + numId);
  if (!range || !num) return;
  const apply = raw => {
    let v = clamp(parseInt(raw, 10) || 0, min, max);
    if (key === 'mergeMin' && state.settings.mergeMax < v) {
      state.settings.mergeMax = v;
      const maxNum = $('#mergeMaxNum');
      const maxRange = $('#mergeMaxRange');
      if (maxNum) maxNum.value = v;
      if (maxRange) maxRange.value = v;
    }
    if (key === 'mergeMax' && state.settings.mergeMin > v) v = state.settings.mergeMin;
    /* 连发条数：最大不得小于最小，双向自动校正并提示 */
    if (key === 'burstMin' && state.settings.burstMax < v) {
      state.settings.burstMax = v;
      const maxNum = $('#burstMaxNum');
      const maxRange = $('#burstMaxRange');
      if (maxNum) maxNum.value = v;
      if (maxRange) maxRange.value = v;
      showToast('连发最多条数已自动拉到与最少一致');
    }
    if (key === 'burstMax' && state.settings.burstMin > v) {
      state.settings.burstMin = v;
      const minNum = $('#burstMinNum');
      const minRange = $('#burstMinRange');
      if (minNum) minNum.value = v;
      if (minRange) minRange.value = v;
      showToast('连发最少条数已自动拉到与最多一致');
    }
    /* 回复时间区间：最短不得大于最长，双向自动校正 */
    if (key === 'replyDelayMin' && state.settings.replyDelayMax < v) {
      state.settings.replyDelayMax = v;
      const maxNum = $('#replyDelayMaxNum');
      const maxRange = $('#replyDelayMaxRange');
      if (maxNum) maxNum.value = v;
      if (maxRange) maxRange.value = v;
      showToast('最长回复时间已自动拉到与最短一致');
    }
    if (key === 'replyDelayMax' && state.settings.replyDelayMin > v) {
      state.settings.replyDelayMin = v;
      const minNum = $('#replyDelayMinNum');
      const minRange = $('#replyDelayMinRange');
      if (minNum) minNum.value = v;
      if (minRange) minRange.value = v;
      showToast('最短回复时间已自动拉到与最长一致');
    }
    /* 主动判定区间：min 调过 max 时自动把 max 拉到一致，反之亦然，并提示 */
    if (key === 'proactiveMin' && state.settings.proactiveMax < v) {
      state.settings.proactiveMax = v;
      const maxNum = $('#proactiveMaxNum');
      const maxRange = $('#proactiveMaxRange');
      if (maxNum) maxNum.value = v;
      if (maxRange) maxRange.value = v;
      showToast('最长间隔已自动拉到与最短间隔一致');
    }
    if (key === 'proactiveMax' && state.settings.proactiveMin > v) {
      state.settings.proactiveMin = v;
      const minNum = $('#proactiveMinNum');
      const minRange = $('#proactiveMinRange');
      if (minNum) minNum.value = v;
      if (minRange) minRange.value = v;
      showToast('最短间隔已自动拉到与最长间隔一致');
    }
    /* TA主动发空间间隔：min/max 双向自动校正并提示 */
    if (key === 'spaceProactiveMin' && state.settings.spaceProactiveMax < v) {
      state.settings.spaceProactiveMax = v;
      const maxNum = $('#spaceProactiveMaxNum');
      const maxRange = $('#spaceProactiveMaxRange');
      if (maxNum) maxNum.value = v;
      if (maxRange) maxRange.value = v;
      showToast('最长间隔已自动拉到与最短间隔一致');
    }
    if (key === 'spaceProactiveMax' && state.settings.spaceProactiveMin > v) {
      state.settings.spaceProactiveMin = v;
      const minNum = $('#spaceProactiveMinNum');
      const minRange = $('#spaceProactiveMinRange');
      if (minNum) minNum.value = v;
      if (minRange) minRange.value = v;
      showToast('最短间隔已自动拉到与最长间隔一致');
    }
    state.settings[key] = v;
    if (key.startsWith('proactive')) updateProactiveNote();
    if (key.startsWith('burst')) updateBurstNote();
    if (key.startsWith('spaceProactive')) updateSpaceProactiveNote();
    if (key.startsWith('letterAuto')) updateLetterAutoNote();
    if (key === 'letterAutoInterval' && state.settings.letterAutoEnabled) {
      state.nextAutoLetterAt = Date.now() + v * 60000;
    }
    range.value = v;
    if (document.activeElement !== num) num.value = v;
    persist();
  };
  range.addEventListener('input', () => apply(range.value));
  num.addEventListener('change', () => apply(num.value));
}

/* =========================================================
 * 二十三、设置与资料编辑
 * ========================================================= */
const THEME_COLORS = ['#12b7f5', '#7c6cf5', '#f26b9c', '#f59e0b', '#22c55e', '#64748b'];
/* 【美化 - 主题颜色】预设色块：名称 + 色值，点击即写入全局主题色 */
const THEME_PRESETS = [
  { c: '#007AFF', n: 'iMessage 蓝' },
  { c: '#F26B9C', n: '樱花粉' },
  { c: '#7C6CF5', n: '薰衣草紫' },
  { c: '#22C55E', n: '薄荷绿' },
  { c: '#F59E0B', n: '暖阳黄' },
  { c: '#0F172A', n: '暗夜黑' },
  { c: '#12B7F5', n: '天青蓝' },
  { c: '#FF5E57', n: '珊瑚红' }
];

function renderSettingsPage() {
  const my = state.my;
  const s = state.settings;
  const roleRows = state.roles.map(role => {
    return `
      <div class="role-manage" data-srole="${role.id}">
        <div class="avatar-wrap">${roleAvatarHTML(role, 40)}</div>
        <div class="grow">
          <div style="font-size:14px;font-weight:600">${esc(role.name)}</div>
          <div class="muted">${esc(role.signature || '还没有签名')}</div>
        </div>
        <button class="btn-sm" data-srole-edit="${role.id}">编辑</button>
      </div>`;
  }).join('');

  const body = subShell('设置', `
    <div class="panel">
      <div class="panel-title">我的资料</div>
      <div class="avatar-edit">
        ${avatarHTML(my.avatar, 56)}
        <div class="grow">
          <div style="font-size:15px;font-weight:600">${esc(my.name)}</div>
          <div class="muted">会同步到消息页、空间和聊天气泡</div>
        </div>
        <button class="btn-sm" id="editMe">编辑</button>
      </div>
    </div>
    <div class="panel">
      <div class="panel-title">梦角</div>
      ${roleRows || '<div class="muted">还没有梦角</div>'}
      <button class="btn block" id="settingsAddRole" style="margin-top:10px">＋ 添加梦角</button>
    </div>
    <div class="panel">
      <div class="panel-title">后台保活</div>
      <div class="list-row row-between">
        <div class="grow">
          <div style="font-size:14px">启用后台保活</div>
          <div class="muted">循环播放静音音频，尽量让页面在后台保持运行</div>
        </div>
        <label class="switch"><input type="checkbox" id="setKeepAlive" ${s.keepAliveEnabled === true ? 'checked' : ''}><span class="slider"></span></label>
      </div>
      <div class="muted" style="margin-top:6px">状态：<span id="keepAliveStatus">${keepAliveStatusText()}</span></div>
      <div class="tip-box" style="margin-top:8px">开启后会循环播放静音音频，尽量让页面在手机后台保持运行；实际效果受浏览器自动播放与省电策略限制，不保证一定生效。保活音频保持静音，不影响来电铃声与一起专注提示音。</div>
    </div>
    <div class="panel">
      <div class="panel-title">后台通知</div>
      <div class="list-row row-between">
        <div class="grow">
          <div style="font-size:14px">启用后台通知</div>
          <div class="muted">需要浏览器通知权限</div>
        </div>
        <label class="switch"><input type="checkbox" id="setNotify" ${s.notifyEnabled === true ? 'checked' : ''}><span class="slider"></span></label>
      </div>
      <div id="notifySubWrap" class="${s.notifyEnabled === true ? '' : 'hidden'}">
        <div class="list-row row-between">
          <div class="grow"><div style="font-size:14px">聊天消息通知</div><div class="muted">${esc(taName())} 发来新消息时通知</div></div>
          <label class="switch"><input type="checkbox" id="setNotifyChat" ${s.notifyChat !== false ? 'checked' : ''}><span class="slider"></span></label>
        </div>
        <div class="list-row row-between">
          <div class="grow"><div style="font-size:14px">空间消息通知</div><div class="muted">${esc(taName())} 点赞或评论你的动态时通知</div></div>
          <label class="switch"><input type="checkbox" id="setNotifySpace" ${s.notifySpace !== false ? 'checked' : ''}><span class="slider"></span></label>
        </div>
      </div>
      <div class="list-row row-between">
        <div class="grow">
          <div style="font-size:14px">测试通知</div>
          <div class="muted" id="notifyPermInfo">权限状态：${notifySupported() ? (Notification.permission === 'granted' ? '已允许' : Notification.permission === 'denied' ? '被拒绝' : '未请求') : '当前浏览器不支持'}</div>
        </div>
        <button class="btn-sm" id="notifyTest"${s.notifyEnabled === true ? '' : ' style="opacity:.45"'}>测试</button>
      </div>
      <div class="tip-box" style="margin-top:8px">页面在前台时只更新未读红点、不弹系统通知；页面切到后台后才发通知，避免重复打扰。</div>
    </div>
    <div class="panel">
      <div class="panel-title">更多设置</div>
      <div class="list-row" data-sentry="beautify" style="cursor:pointer" onclick="navigate({page:'sub',name:'beautify'})">
        <div class="grow"><div style="font-size:14px">美化</div><div class="muted">壁纸与图标主题</div></div>
        <span class="chev">›</span>
      </div>
      <div class="list-row" data-sentry="probability" style="cursor:pointer">
        <div class="grow"><div style="font-size:14px">概率与行为</div><div class="muted">回复、拼接、来电与接听</div></div>
        <span class="chev">›</span>
      </div>
      <div class="list-row" data-sentry="storage" style="cursor:pointer">
        <div class="grow"><div style="font-size:14px">存储感知</div><div class="muted">备份、导入与清空</div></div>
        <span class="chev">›</span>
      </div>
      <div class="list-row" data-sentry="cards" style="cursor:pointer">
        <div class="grow"><div style="font-size:14px">字卡库</div><div class="muted">管理${esc(taName())}的回复内容</div></div>
        <span class="chev">›</span>
      </div>
    </div>
    <div class="tip-box">
      ${esc(state.appName)} · 本地持久化 + 导出备份<br>
      所有数据只保存在当前浏览器中，不会上传；更换设备或清理浏览器数据前请先导出备份。
    </div>
    <button class="app-update-btn" id="appUpdateBtn" type="button">${APP_ICONS.refresh}<span>检查更新</span></button>
    <div id="app-version-display" class="app-version-text"></div>`);

  /* 版本号显示：内容来自文件顶部全局常量 APP_VERSION */
  $('#app-version-display', body).textContent = '当前版本：' + APP_VERSION;

  /* 检查更新：只弹二次确认，确认后才清理缓存并强制刷新 */
  $('#appUpdateBtn').addEventListener('click', openUpdateConfirm);

  $('#editMe').addEventListener('click', openMyProfileEditor);
  $('#settingsAddRole').addEventListener('click', () => openRoleEditor(null));

  /* 后台保活开关：开启后尝试播放内置静音音频，关闭时暂停并释放资源 */
  $('#setKeepAlive').addEventListener('change', e => {
    state.settings.keepAliveEnabled = e.target.checked;
    persist();
    syncKeepAliveBySetting();
    if (e.target.checked) showToast('已开启后台保活（受浏览器限制，不保证一定生效）');
    else showToast('已关闭后台保活');
  });

  /* 后台通知总开关：开启时请求系统通知权限；被拒绝则回退为关闭 */
  $('#setNotify').addEventListener('change', async e => {
    if (e.target.checked) {
      if (!notifySupported()) {
        showToast('当前浏览器不支持系统通知');
        e.target.checked = false;
        state.settings.notifyEnabled = false;
        persist();
        return;
      }
      let perm = Notification.permission;
      if (perm !== 'granted') {
        try { perm = await Notification.requestPermission(); } catch (err) { perm = 'denied'; }
      }
      if (perm !== 'granted') {
        state.settings.notifyEnabled = false;
        persist();
        e.target.checked = false;
        $('#notifySubWrap').classList.add('hidden');
        syncNotifyTestUI();
        showToast('通知权限被拒绝，请在浏览器设置中允许通知');
        return;
      }
      state.settings.notifyEnabled = true;
      persist();
      $('#notifySubWrap').classList.remove('hidden');
      syncNotifyTestUI();
      showToast('已开启后台通知');
    } else {
      state.settings.notifyEnabled = false;
      persist();
      $('#notifySubWrap').classList.add('hidden');
      syncNotifyTestUI();
      showToast('已关闭后台通知');
    }
  });
  $('#setNotifyChat').addEventListener('change', e => {
    state.settings.notifyChat = e.target.checked;
    persist();
  });
  $('#setNotifySpace').addEventListener('change', e => {
    state.settings.notifySpace = e.target.checked;
    persist();
  });

  /* 测试通知按钮：与真实通知走同一个 sendSystemNotification（force 跳过前台抑制），
     各分支给出明确提示；成功后额外更新权限状态文本 */
  function syncNotifyTestUI() {
    const btn = $('#notifyTest');
    const info = $('#notifyPermInfo');
    if (btn) btn.style.opacity = state.settings.notifyEnabled === true ? '' : '.45';
    if (info) {
      info.textContent = '权限状态：' + (notifySupported()
        ? (Notification.permission === 'granted' ? '已允许' : Notification.permission === 'denied' ? '被拒绝' : '未请求')
        : '当前浏览器不支持');
    }
  }
  $('#notifyTest').addEventListener('click', async () => {
    if (state.settings.notifyEnabled !== true) {
      showToast('请先开启「启用后台通知」');
      return;
    }
    if (!notifySupported()) {
      showToast('当前浏览器不支持系统通知');
      return;
    }
    let perm = Notification.permission;
    if (perm === 'default') {
      try { perm = await Notification.requestPermission(); } catch (err) { perm = 'denied'; }
      syncNotifyTestUI();
    }
    if (perm !== 'granted') {
      showToast('请先允许通知权限');
      return;
    }
    const role = state.roles[0];
    if (!role) { showToast('请先添加梦角'); return; }
    sendSystemNotification(role.name, '这是一条测试通知，看到它就说明通知正常', 'test-' + Date.now(), { page: 'chat', roleId: role.id }, true);
    /* 在第一个梦角的聊天里插入一条标明“测试消息”的系统轻提示，不触发未读 */
    chatOf(role.id).push({
      id: uid(), role: 'system', type: 'tip',
      content: '测试消息：后台通知测试已发送', ts: Date.now(), read: true
    });
    persist();
    renderChatIf(role.id);
    syncNotifyTestUI();
    showToast('已发送测试通知');
  });
  updateKeepAliveStatus();

  $$('[data-srole-edit]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    openRoleEditor(btn.dataset.sroleEdit);
  }));
  $$('[data-srole]').forEach(row => row.addEventListener('click', () => openRoleEditor(row.dataset.srole)));
  $$('[data-sentry]').forEach(row => row.addEventListener('click', () => {
    navigate({ page: 'sub', name: row.dataset.sentry });
  }));
}

/* =========================================================
 * 二十三·一、检查更新（设置页最底部的「检查更新」按钮）
 * 流程：点击 → 全屏二次确认弹窗 → 确认后注销 Service Worker、
 *       清空 CacheStorage → 500ms 兜底延迟 → 带最新时间戳强制刷新
 * 弹窗 DOM 固定在 index.html 的 #updateConfirmMask，这里只处理交互
 * ========================================================= */
function openUpdateConfirm() {
  const mask = $('#updateConfirmMask');
  if (!mask) return;
  mask.classList.remove('hidden');
  /* 先取消隐藏再置 show，保证淡入过渡生效 */
  requestAnimationFrame(() => mask.classList.add('show'));
}

function closeUpdateConfirm() {
  const mask = $('#updateConfirmMask');
  if (!mask) return;
  mask.classList.remove('show');
  /* 等淡出动画结束再彻底隐藏，避免下一帧就消失显得生硬 */
  setTimeout(() => mask.classList.add('hidden'), 180);
}

/* 确定更新：按钮改文案并禁用 → 写入刷新标记 → 后台清理缓存 → 500ms 后强制刷新 */
function startUpdateRefresh() {
  const btn = $('#appUpdateBtn');
  if (btn) {
    btn.disabled = true;
    const label = btn.querySelector('span');
    if (label) label.textContent = '正在获取最新版本...';
  }

  /* 刷新标记：刷新后由 checkUpdateResult() 读取，用于判断并弹出更新结果提示 */
  try { sessionStorage.setItem('is_checking_update', 'true'); } catch (err) { /* 隐私模式下可能不可用，忽略 */ }

  /* 兜底刷新：即使下面的清理逻辑卡住或报错，500ms 后也一定带时间戳刷新 */
  setTimeout(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('t', Date.now());   /* 覆盖旧的 t 参数，强制绕过浏览器 / PWA 缓存 */
    window.location.replace(url.toString());
  }, 500);

  (async () => {
    /* ① 注销 Service Worker（PWA 缓存是“改了代码却还是旧版”的常见原因） */
    if ('serviceWorker' in navigator) {
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
      } catch (err) { console.warn('[检查更新] 注销 Service Worker 失败：', err); }
    }
    /* ② 清空 CacheStorage：遍历所有缓存版本一次性删除 */
    if (typeof caches !== 'undefined' && caches && typeof caches.keys === 'function') {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      } catch (err) { console.warn('[检查更新] 清理缓存失败：', err); }
    }
  })();
}

/* 弹窗按钮只绑一次（boot 时调用）：取消中断，确定更新才执行清理与刷新 */
function bindUpdateFeature() {
  const mask = $('#updateConfirmMask');
  if (!mask) return;
  const cancelBtn = $('#updCancel');
  const okBtn = $('#updOk');
  if (cancelBtn) cancelBtn.addEventListener('click', closeUpdateConfirm);
  if (okBtn) okBtn.addEventListener('click', () => { closeUpdateConfirm(); startUpdateRefresh(); });
  /* 点遮罩空白处等同取消，与全局弹窗习惯保持一致 */
  mask.addEventListener('click', e => { if (e.target === mask) closeUpdateConfirm(); });
}

/* 检查更新专用 Toast：复用全局 #toast 的黑底白字圆角样式，额外居中显示 */
function showUpdateToast(text) {
  const el = $('#toast');
  if (!el) return;
  el.classList.add('toast-center');
  showToast(text);
  /* 提示结束后摘掉居中标记，不影响后续其它普通 Toast 的位置 */
  setTimeout(() => el.classList.remove('toast-center'), 2200);
}

/* 刷新后的结果判断：只有从「确定更新」跳转回来时（sessionStorage 有标记）才提示
 * 记录上一次版本号 → 与本次 APP_VERSION 对比 → 提示结果 → 写入本次版本号 */
function checkUpdateResult() {
  let flag = null;
  try { flag = sessionStorage.getItem('is_checking_update'); } catch (err) { flag = null; }
  if (flag !== 'true') return;                       /* 普通刷新 / 重启不提示 */
  try { sessionStorage.removeItem('is_checking_update'); } catch (err) { /* 忽略 */ }

  let saved = null;
  try { saved = localStorage.getItem('saved_app_version'); } catch (err) { saved = null; }
  const isNewVersion = saved !== APP_VERSION;        /* 与上次记录不同 = 拉到了新版本 */

  /* 延迟到首屏渲染与路由稳定后再弹，避免被页面切换动画遮住 */
  setTimeout(() => showUpdateToast(isNewVersion ? '已更新到新版本！' : '当前已是最新版本'), 600);

  try { localStorage.setItem('saved_app_version', APP_VERSION); } catch (err) { /* 忽略 */ }
}

function avatarEditorHTML(value) {
  return `
    <div class="avatar-edit" style="margin-bottom:10px">
      <div id="avPreview">${avatarHTML(value || '🙂', 56)}</div>
      <div class="grow">
        <div class="btn-row">
          <button class="btn-sm" id="avUpload">上传图片</button>
          ${['🌙', '🐰', '✨', '🐈', '🦋', '🍓'].map(e => `<button class="btn-sm" data-emoji="${e}">${e}</button>`).join('')}
        </div>
        <div class="muted" style="margin-top:5px">可上传本地图片，也可直接填 emoji 或图片 URL</div>
      </div>
    </div>
    <div class="field">
      <label>头像（emoji / 图片 URL / dataURL）</label>
      <input class="input" id="avText" value="${esc(value || '')}" placeholder="🌙">
    </div>`;
}

function bindAvatarEditor(root) {
  const input = $('#avText', root);
  const preview = $('#avPreview', root);
  if (!input || !preview) return;
  const paint = () => {
    preview.innerHTML = avatarHTML(input.value.trim() || '🙂', 56);
  };
  input.addEventListener('input', paint);
  const upload = $('#avUpload', root);
  if (upload) upload.addEventListener('click', async () => {
    const data = await pickImage(240, .85);
    if (data) { input.value = data; paint(); }
  });
  $$('[data-emoji]', root).forEach(btn => btn.addEventListener('click', () => {
    input.value = btn.dataset.emoji;
    paint();
  }));
}

function openMyProfileEditor() {
  const modal = showModal({
    title: '我的资料',
    body: `
      ${avatarEditorHTML(state.my.avatar)}
      <div class="field">
        <label>昵称</label>
        <input class="input" id="myName" value="${esc(state.my.name)}" maxlength="20" placeholder="怎么称呼你">
      </div>`,
    actions: [
      { label: '取消' },
      {
        label: '保存', kind: 'primary', onClick: el => {
          const name = $('#myName', el).value.trim() || '我';
          state.my.name = name;
          state.my.avatar = $('#avText', el).value.trim() || '🐰';
          persist();
          refreshAllViews();
          showToast('资料已保存');
          return true;
        }
      }
    ],
    onMount: el => bindAvatarEditor(el)
  });
  return modal;
}

function openRoleEditor(roleId) {
  const role = roleId ? roleById(roleId) : null;
  const editing = !!role;
  const data = role || {
    name: '',
    avatar: '🌙',
    signature: '',
    theme: ''
  };

  const modal = showModal({
    title: editing ? '编辑梦角' : '添加梦角',
    wide: true,
    body: `
      ${avatarEditorHTML(data.avatar)}
      <div class="field">
        <label>名字</label>
        <input class="input" id="roleName" value="${esc(data.name)}" maxlength="20" placeholder="梦角的名字">
      </div>
      <div class="field">
        <label>签名</label>
        <input class="input" id="roleSign" value="${esc(data.signature || '')}" maxlength="60" placeholder="一句话介绍">
      </div>
      <div class="field">
        <label>梦角标识色（仅用于头像配色，聊天页统一跟随全局主题色）</label>
        <div class="color-row">
          ${THEME_COLORS.map(c => `<button class="color-dot ${roleColor(data) === c ? 'active' : ''}" data-rtheme="${c}" style="background:${c}"></button>`).join('')}
          <input class="color-picker" type="color" id="roleThemePicker" value="${/^#[0-9a-fA-F]{6}$/.test(roleColor(data)) ? roleColor(data) : '#007AFF'}">
        </div>
      </div>
      ${editing ? '<button class="btn ghost block" id="roleClearChat" style="margin-top:8px">清空聊天记录</button>' : ''}
      ${editing ? '<button class="btn danger block" id="roleDelete" style="margin-top:8px">删除这个梦角</button>' : ''}`,
    actions: [
      { label: '取消' },
      {
        label: editing ? '保存' : '添加', kind: 'primary', onClick: el => {
          const name = $('#roleName', el).value.trim();
          if (!name) { showToast('请填写梦角名字'); return false; }
          let theme = data.theme;
          const activeDot = $('[data-rtheme].active', el);
          if (activeDot) theme = activeDot.dataset.rtheme;
          theme = $('#roleThemePicker', el).value || theme;
          /* 未单独设置且选的正是全局主题色 → 继续继承，之后切换全局主题才能同步过来 */
          if (!data.theme && String(theme).toLowerCase() === String(state.settings.theme || '').toLowerCase()) theme = '';
          const payload = {
            name,
            avatar: $('#avText', el).value.trim() || '🌙',
            signature: $('#roleSign', el).value.trim(),
            theme
          };
          if (editing) {
            Object.assign(role, payload);
          } else {
            const created = defaultRole(Object.assign({ ts: Date.now() }, payload));
            state.roles.push(created);
            state.chats[created.id] = [];
            state.unread[created.id] = 0;
            state.locations[created.id] = defaultLocationData();
            state.activeRoleId = created.id;
          }
          persist(true);
          refreshAllViews();
          showToast(editing ? '梦角资料已更新' : '梦角已添加');
          return true;
        }
      }
    ],
    onMount: el => {
      bindAvatarEditor(el);
      $$('[data-rtheme]', el).forEach(btn => btn.addEventListener('click', () => {
        $$('[data-rtheme]', el).forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const picker = $('#roleThemePicker', el);
        if (picker) picker.value = btn.dataset.rtheme;
      }));
      const picker = $('#roleThemePicker', el);
      if (picker) picker.addEventListener('input', () => {
        $$('[data-rtheme]', el).forEach(b => b.classList.remove('active'));
      });
      const del = $('#roleDelete', el);
      if (del) del.addEventListener('click', () => deleteRole(role.id, () => modal.close()));
      const cc = $('#roleClearChat', el);
      if (cc) cc.addEventListener('click', async () => {
        modal.close();
        await clearChat(role.id);
      });
    }
  });
  return modal;
}

async function deleteRole(roleId, closeFn) {
  const role = roleById(roleId);
  if (!role) return;
  if (state.roles.length <= 1) { showToast('至少保留一个梦角'); return; }
  const ok = await confirmDialog(
    '删除梦角',
    `将删除「${role.name}」和它的聊天记录，无法恢复。字卡为全局共享，会与表情包、信件、问卷模板和空间动态一起保留。`,
    '删除',
    true
  );
  if (!ok) return;

  state.roles = state.roles.filter(r => r.id !== roleId);
  delete state.chats[roleId];
  delete state.unread[roleId];
  delete state.lastReplies[roleId];
  delete state.locations[roleId];
  if (state.locationRoleId === roleId) state.locationRoleId = state.roles[0] ? state.roles[0].id : null;
  if (state.linkRoleId === roleId) state.linkRoleId = state.roles[0] ? state.roles[0].id : null;
  bumpChatGen(roleId);
  typingMap.delete(roleId);
  replyQueue.delete(roleId);
  replyBusy.delete(roleId);
  if (state.activeRoleId === roleId) {
    state.activeRoleId = state.roles[0] ? state.roles[0].id : null;
  }
  persist(true);
  if (typeof closeFn === 'function') closeFn();
  /* 分表里该梦角的聊天记录同步删除，避免占用空间 */
  if (Storage.mode === 'idb') DB.del(STORE_CHATS, roleId);

  if (currentRoute.page === 'chat' && currentRoute.roleId === roleId) {
    routeStack = [];
    currentRoute = { page: 'messages' };
    applyRoute();
  } else {
    refreshAllViews();
  }
  showToast('梦角已删除');
}

function refreshAllViews() {
  if (currentRoute.page === 'home') renderHomePage();
  else if (currentRoute.page === 'messages') renderMessagesPage();
  else if (currentRoute.page === 'contacts') renderContactsPage();
  else if (currentRoute.page === 'space') renderSpacePage();
  else if (currentRoute.page === 'chat') {
    if (roleById(currentRoute.roleId)) renderChatPage(currentRoute.roleId);
    else { currentRoute = { page: 'messages' }; applyRoute(); }
  } else if (currentRoute.page === 'sub') {
    renderSub(currentRoute.name);
  }
}

/* =========================================================
 * 二十三·五、一起做 / 一起读书
 * 双向邀请卡片 + 一起读书主界面 + 阅读界面 + 悬浮小聊天框 + 长按引用
 * ========================================================= */
/* 阅读界面的名言（只做展示，不落库） */
const RD_QUOTES = [
  { text: '我们读书，是为了在别人的故事里，遇见自己的影子。', from: '佚名' },
  { text: '书页翻动的声音，是最安静的陪伴。', from: '佚名' },
  { text: '愿你在字里行间，找到想去的远方。', from: '佚名' },
  { text: '有人一起读书的夜晚，时间会走得慢一些。', from: '佚名' },
  { text: '读一页书，就像和一个人聊了一会儿天。', from: '佚名' }
];

/* 运行时状态：isReadingTogether 与当前共读梦角 ID（持久化镜像在 state.readData） */
let isReadingTogether = false;
let readingRoleId = '';
let readingRoomMounted = false;   /* 阅读界面是否已挂载（控制悬浮窗与定时器） */
let readingStatsTimer = null;     /* 每分钟累计阅读时长的定时器 */
let readingCompAccum = 0;         /* 陪读消息间隔累计（分钟） */
let readingExpanded = false;      /* 悬浮小聊天框是否展开 */
let readingQuote = null;          /* 当前引用：{ text, who } */
let readingSelText = '';          /* 情绪卡：长按选中的书中文字 */
let readingDragState = null;      /* 悬浮窗拖拽状态 */
let readingRingRange = 'day';     /* 环形统计范围：day / week / all（全部 = 累加所有历史记录） */
let readingQuoteTimer = null;     /* 松手后的 150ms 延时，等浏览器把选区稳定下来 */
let rdLastEmotionTapAt = 0;       /* 触屏 touchend 已处理过的标记，防止 click 再触发一次 */
const rdParasTried = new Set();   /* 已尝试从 books 表补读正文的书籍 ID，避免重复补读 */

function rdDateKey(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function rdMins(sec) {
  return Math.max(0, Math.round((Number(sec) || 0) / 60));
}
function rdCharsLabel(chars) {
  const n = Number(chars) || 0;
  if (n >= 10000) return (Math.round(n / 1000) / 10).toFixed(1) + ' 万字';
  return n + ' 字';
}
/* 封面文字色：按混色后的实际亮度逐档取白字或深灰字，保证浅色/深色主题都清晰 */
function rdBookInk(hex) {
  const c = hexToRgb(hex || '#12b7f5');
  const lum = (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
  return lum > 0.62 ? '#3C3C43' : '#FFFFFF';
}
/* 主题色按 100% / 80% / 60% 与白色混合，逐档计算文字色 */
function rdBookInks(hex) {
  const base = hex || '#12b7f5';
  return [100, 80, 60].map(p => rdBookInk(mixHex(base, '#ffffff', 1 - p / 100)));
}
/* 章节切分：按段落累计到约 1800 字切一章，只渲染当前章，避免长文本卡顿 */
const RD_CHAPTER_CHARS = 1800;
let rdChapterCache = { bookId: '', len: -1, chapters: [] };
function rdChaptersOf(book) {
  if (!book) return [''];
  const paras = book.paras || [];
  if (rdChapterCache.bookId !== book.id || rdChapterCache.len !== paras.length) {
    const chapters = [];
    let buf = [];
    let size = 0;
    for (let i = 0; i < paras.length; i++) {
      const p = paras[i];
      buf.push(p);
      size += p.length;
      if (size >= RD_CHAPTER_CHARS) {
        chapters.push(buf.join('\n\n'));
        buf = [];
        size = 0;
      }
    }
    if (buf.length) chapters.push(buf.join('\n\n'));
    rdChapterCache = { bookId: book.id, len: paras.length, chapters: chapters.length ? chapters : [''] };
  }
  return rdChapterCache.chapters;
}
function rdCurrentRoleId() {
  const d = state.readData;
  if (d.roleId && roleById(d.roleId)) return d.roleId;
  return state.activeRoleId || (state.roles[0] && state.roles[0].id) || '';
}
function rdBookName() {
  const b = state.readData.books.find(x => x.id === state.readData.bookId);
  return b ? b.name : '原文';
}
function rdSyncGlobals() {
  isReadingTogether = !!(state.readData && state.readData.isReading && state.readData.roleId);
  readingRoleId = (state.readData && state.readData.roleId) || '';
}

/* 开始 / 结束共读会话：同时更新全局状态与持久化数据 */
function rdStartSession(roleId) {
  if (!state.readData) return;
  state.readData.isReading = true;
  state.readData.roleId = roleId || state.activeRoleId || '';
  if (!state.readData.bookId && state.readData.books[0]) state.readData.bookId = state.readData.books[0].id;
  rdSyncGlobals();
  persist();
}
function rdEndSession() {
  if (!state.readData) return;
  if (!state.readData.isReading && !state.readData.roleId) return;
  state.readData.isReading = false;
  state.readData.roleId = '';
  rdSyncGlobals();
  persist();
}

/* ---------- 【一起做】页 ---------- */
function renderReadTogetherPage() {
  const roleId = rdCurrentRoleId();
  const roleName = esc(taName(roleId));
  const listeningNow = musicIsPlaying() && musicDisplayName();
  const listenDesc = listeningNow ? `正在听《${esc(musicDisplayName())}》 · 点击继续` : `和 ${roleName} 一起听一首歌，慢慢待在彼此身边`;
  const focusDesc = (pomo && pomo.running)
    ? `专注进行中 · 剩余 ${fmtDuration(pomo.remain)}`
    : `把手机放下，和 ${roleName} 安静地专注一会儿`;
  const body = subShell('一起做', `
    <button class="rt-entry-card" data-rt-read>
      <div class="ic">${APP_ICONS.readbook}</div>
      <div class="txt">
        <div class="t">一起读书</div>
        <div class="d">${isReadingTogether ? '正在和 ' + esc(taName(readingRoleId)) + ' 共读中 · 点击继续' : '上传一本书，和 ' + roleName + ' 一起慢慢读'}</div>
      </div>
      <div class="arrow">›</div>
    </button>
    <button class="rt-entry-card" data-rt-listen>
      <div class="ic">${APP_ICONS.listen}</div>
      <div class="txt">
        <div class="t">一起听</div>
        <div class="d">${listenDesc}</div>
      </div>
      <div class="arrow">›</div>
    </button>
    <button class="rt-entry-card" data-rt-focus>
      <div class="ic">${APP_ICONS.pomodoro}</div>
      <div class="txt">
        <div class="t">一起专注</div>
        <div class="d">${focusDesc}</div>
      </div>
      <div class="arrow">›</div>
    </button>
    <button class="rt-entry-card" data-rt-play>
      <div class="ic">${APP_ICONS.games}</div>
      <div class="txt">
        <div class="t">一起玩</div>
        <div class="d">五子棋 · 更多小游戏筹备中</div>
      </div>
      <div class="arrow">›</div>
    </button>
    <div class="rt-more">更多一起做功能，敬请期待…</div>
  `);
  const entry = $('[data-rt-read]', body);
  if (entry) {
    entry.addEventListener('click', () => {
      if (isReadingTogether) openReadingRoom();
      else navigate({ page: 'sub', name: 'reading' });
    });
  }
  const listenEntry = $('[data-rt-listen]', body);
  if (listenEntry) listenEntry.addEventListener('click', () => navigate({ page: 'sub', name: 'listen' }));
  const focusEntry = $('[data-rt-focus]', body);
  if (focusEntry) focusEntry.addEventListener('click', () => navigate({ page: 'sub', name: 'pomodoro' }));
  /* 一起玩：进入二级子页面（三级结构：一起做 → 一起玩 → 五子棋） */
  const playEntry = $('[data-rt-play]', body);
  if (playEntry) playEntry.addEventListener('click', () => navigate({ page: 'sub', name: 'play' }));
}

/* ---------- 【一起读书】主界面 ---------- */
function rdStatsOf(range) {
  let together = 0, alone = 0;
  /* 【全部】：不做任何日期过滤，直接遍历存储里的所有阅读记录并分别累加 */
  if (range === 'all') {
    const all = (state.readData && state.readData.stats) || {};
    Object.keys(all).forEach(k => {
      const v = all[k];
      if (!v) return;
      together += Number(v.together) || 0;
      alone += Number(v.alone) || 0;
    });
    return { together, alone };
  }
  /* 【日】/【周】：沿用原有的日期范围过滤 */
  let keys = [];
  const now = new Date();
  if (range === 'week') {
    for (let i = 6; i >= 0; i--) keys.push(rdDateKey(new Date(now.getTime() - i * 86400000)));
  } else {
    keys = [todayKey()];
  }
  keys.forEach(k => {
    const v = state.readData.stats[k];
    if (!v) return;
    together += Number(v.together) || 0;
    alone += Number(v.alone) || 0;
  });
  return { together, alone };
}

function renderReadingPage() {
  const books = state.readData.books;
  const bookName = esc(rdBookName());
  const roleId = rdCurrentRoleId();
  const roleName = esc(taName(roleId));
  const quote = pickOne(RD_QUOTES);
  const stats = rdStatsOf(readingRingRange);
  const total = stats.together + stats.alone;
  const pct = total > 0 ? Math.round((stats.together / total) * 100) : 0;
  const totalMins = rdMins(total);
  const totalTxt = totalMins > 999 ? '999+' : String(totalMins);
  const bookInks = rdBookInks(state.settings.theme);

  const body = subShell('一起读书', `
    <div class="rd-quote-card">
      <div class="q">“${esc(quote.text)}”</div>
      <div class="from">— ${esc(quote.from)}</div>
    </div>
    <div class="panel rd-stats">
      <div class="panel-title">阅读时长</div>
      <div class="rd-ring-wrap">
        <div class="rd-ring" id="rdRing" style="--read-together:${pct}">
          <div class="rd-ring-center"><b>${totalTxt}</b><span>分钟</span></div>
        </div>
        <div class="legend">
          <div class="rd-legend-item"><span class="rd-dot ta"></span><span>共读 ${rdMins(stats.together)} 分钟</span></div>
          <div class="rd-legend-item"><span class="rd-dot gray"></span><span>自己 ${rdMins(stats.alone)} 分钟</span></div>
          <div class="rd-legend-item" style="color:var(--sub);font-size:11.5px">共读占比 ${pct}%</div>
        </div>
      </div>
      <div class="rd-range-tabs">
        <button class="${readingRingRange === 'day' ? 'active' : ''}" data-rd-range="day">日</button>
        <button class="${readingRingRange === 'week' ? 'active' : ''}" data-rd-range="week">周</button>
        <button class="${readingRingRange === 'all' ? 'active' : ''}" data-rd-range="all">全部</button>
      </div>
    </div>
    <div class="panel rd-shelf-panel">
      <div class="rd-shelf-head">
        <div class="panel-title" style="margin:0">书架${books.length ? `<span class="muted" style="font-weight:400;margin-left:6px">${books.length} 本</span>` : ''}</div>
        <button class="rd-pick-btn" data-rd-pick ${books.length <= 1 ? 'disabled' : ''}>让${roleName}挑一本</button>
      </div>
      <div class="rd-shelf">
        <div class="rd-shelf-track" style="--book-fg-1:${bookInks[0]};--book-fg-2:${bookInks[1]};--book-fg-3:${bookInks[2]}">
          ${books.map(b => `
            <button class="rd-book ${b.id === state.readData.bookId ? 'active' : ''}" data-rd-book="${b.id}">
              <span class="rd-book-name">${esc(b.name)}</span>
              <span class="rd-book-meta">${esc(rdCharsLabel(b.chars))}</span>
            </button>`).join('')}
          <button class="rd-book rd-book-add" data-rd-upload aria-label="上传 txt">
            <span class="rd-book-plus">＋</span>
            <span class="rd-book-add-txt">上传</span>
          </button>
        </div>
      </div>
      ${books.length ? '' : `<div class="rd-shelf-empty">书架还是空的，点右侧「＋」上传一个 txt</div>`}
      <div class="muted" style="margin-top:4px;font-size:11.5px">仅支持 txt，单个文件不超过 2MB；文件只保存在本地浏览器，可随完整备份导出。</div>
    </div>
    ${isReadingTogether
      ? `<button class="btn primary block" data-rd-open style="margin-top:12px">继续和 ${esc(taName(readingRoleId))} 共读 · ${bookName}</button>`
      : `<button class="btn primary block" data-rd-invite style="margin-top:12px">邀请${roleName}一起读</button>`}
  `);

  $$('[data-rd-range]', body).forEach(btn => btn.addEventListener('click', () => {
    readingRingRange = btn.dataset.rdRange;
    applyRoute();
  }));
  /* 书本：单击打开阅读 + 长按删除，统一由 rdBindBookNode 绑定，同一节点只绑一次 */
  $$('[data-rd-book]', body).forEach(rdBindBookNode);
  const upBtn = $('[data-rd-upload]', body);
  if (upBtn) upBtn.addEventListener('click', rdUploadBook);
  const pickBtn = $('[data-rd-pick]', body);
  if (pickBtn) pickBtn.addEventListener('click', () => rdPickBook(roleId));
  const openBtn = $('[data-rd-open]', body);
  if (openBtn) openBtn.addEventListener('click', openReadingRoom);
  const invBtn = $('[data-rd-invite]', body);
  if (invBtn) invBtn.addEventListener('click', () => inviteReadTogether(roleId, 'reading'));
}

/* ---------- 书籍：上传 / 切分 / 让 TA 挑一本 ---------- */
function rdSplitText(raw) {
  const text = String(raw || '').replace(/\r\n?/g, '\n');
  const out = [];
  text.split(/\n\s*\n/).forEach(block => {
    const t = block.replace(/\u3000/g, ' ').trim();
    if (!t) return;
    if (t.length <= 900) { out.push(t); return; }
    /* 超长段落按句末标点再切，避免单段过长导致渲染卡顿 */
    let rest = t;
    while (rest.length > 900) {
      let cut = -1;
      for (let i = 900; i > 400; i--) {
        if ('。！？…!?'.indexOf(rest.charAt(i)) >= 0) { cut = i; break; }
      }
      if (cut < 0) cut = 900;
      const seg = rest.slice(0, cut + 1).trim();
      if (seg) out.push(seg);
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) out.push(rest);
  });
  return out;
}

function rdUploadBook() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.txt,text/plain';
  input.style.display = 'none';
  document.body.appendChild(input);
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    input.remove();
    if (!file) return;
    if (!/\.txt$/i.test(file.name) && !/text\/plain/i.test(file.type || '')) {
      showToast('只支持 txt 文件');
      return;
    }
    if (file.size > 2 * 1024 * 1024) { showToast('文件不能超过 2MB'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const paras = rdSplitText(reader.result);
      if (!paras.length) { showToast('文件内容为空'); return; }
      const book = {
        id: uid(),
        name: (file.name || '未命名').replace(/\.txt$/i, '').slice(0, 60) || '未命名',
        paras,
        chars: String(reader.result || '').length,
        ts: Date.now()
      };
      state.readData.books.push(book);
      state.readData.bookId = book.id;
      state.readData.readPos = 0;
      state.readData.chapter = 0;
      rdParasTried.add(book.id);
      persist(true);   /* 正文较大：立即写入 books 表，不等防抖 */
      showToast('已加入书架：' + book.name);
      applyRoute();
    };
    reader.onerror = () => showToast('读取文件失败');
    reader.readAsText(file, 'UTF-8');
  });
  input.click();
}

function rdPickBook(roleId) {
  const books = state.readData.books;
  if (!books.length) { showToast('先上传一本书吧'); return; }
  if (books.length <= 1) { showToast('只有一本书，没得挑啦'); return; }
  const b = pickOne(books);
  state.readData.bookId = b.id;
  state.readData.readPos = 0;
  state.readData.chapter = 0;
  persist();
  showToast(taName(roleId) + ' 挑了《' + b.name + '》');
  applyRoute();
}

/* ---------- 长按书本 → 删除确认 ---------- */
const RD_LONG_PRESS_MS = 500;
const RD_DEL_LOCK_MS = 1000;      /* 弹窗打开后 1 秒内不允许关闭（时间戳硬锁） */
const RD_GHOST_CLICK_MS = 400;    /* 松手后吞掉幽灵 click 的时间窗 */
let rdBookLongPressedAt = 0;      /* 长按判定时刻：用于吞掉随后的 click */
let rdPendingDeleteBookId = '';   /* 确认框里待删除的书 */
let modalOpenedTime = 0;          /* 弹窗打开时间戳：1 秒内遮罩点击一律无效 */
let rdLongPressReleasedAt = 0;    /* 长按松手时间戳：斩断松手后的原生 click */
let isPoppingUp = false;          /* 弹窗弹出瞬间的全局状态锁 */
let rdDelLockTimer = null;        /* 300ms 物理屏蔽遮罩点击的计时器 */

/* 书本节点统一绑定：单击打开 + 长按删除，同一节点只绑一次，避免重复监听 */
function rdBindBookNode(btn) {
  if (!btn || btn.dataset.rdBound === '1') return;
  btn.dataset.rdBound = '1';

  btn.addEventListener('click', () => {
    /* 长按刚触发过删除确认：吞掉这次 click，避免松手时把书打开 */
    if (Date.now() - rdBookLongPressedAt < RD_DEL_LOCK_MS) return;
    /* 点击书本始终按「自己读」进入：先结束共读会话，再以单人状态阅读 */
    rdEndSession();
    state.readData.bookId = btn.dataset.rdBook;
    state.readData.readPos = 0;
    state.readData.chapter = 0;
    persist();
    openReadingRoom();
  });

  rdBindBookLongPress(btn);
}

function rdBindBookLongPress(btn) {
  if (!btn || btn.dataset.rdLongPressBound === '1') return;   /* 防重复绑定 */
  btn.dataset.rdLongPressBound = '1';
  const bookId = btn.dataset.rdBook;
  let timer = null;
  let fired = false;      /* 本次按压是否已成功触发长按 */
  let pressed = false;    /* 当前是否处于按下状态 */
  let sx = 0, sy = 0;
  let startAt = 0;        /* 本次按下的起始时间 */
  let lastTouchAt = 0;    /* 触屏时间：用于屏蔽模拟鼠标事件，避免重复计时 */

  const stop = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    pressed = false;
    btn.classList.remove('long-pressing');
  };

  const begin = (x, y) => {
    stop();
    fired = false;
    pressed = true;
    startAt = Date.now();
    sx = x; sy = y;
    btn.classList.add('long-pressing');   /* 按下即缩小，给出“按到了”的反馈 */
    timer = setTimeout(() => {
      timer = null;
      pressed = false;
      fired = true;
      rdBookLongPressedAt = Date.now();
      btn.classList.remove('long-pressing');
      try { if (navigator.vibrate) navigator.vibrate(15); } catch (err) { /* 忽略 */ }
      rdAskDeleteBook(bookId);
    }, RD_LONG_PRESS_MS);
  };

  const release = e => {
    stop();
    if (!fired) return;
    /* 长按已弹出确认框：记录松手时刻，物理斩断后续原生点击 */
    rdLongPressReleasedAt = Date.now();
    if (e && e.cancelable) e.preventDefault();
    if (e) e.stopPropagation();
  };

  /* 触屏：touchstart / touchend（不用 pointerdown，避免滚动时 pointercancel 打断计时） */
  btn.addEventListener('touchstart', e => {
    if (e.touches && e.touches.length > 1) return;   /* 双指缩放不触发 */
    lastTouchAt = Date.now();
    const t = e.touches && e.touches[0];
    begin(t ? t.clientX : 0, t ? t.clientY : 0);
  }, { passive: true });
  btn.addEventListener('touchmove', e => {
    if (!pressed) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    /* 滑动超过 8px 视为滚动书架，取消长按 */
    if (Math.abs(t.clientX - sx) > 8 || Math.abs(t.clientY - sy) > 8) stop();
  }, { passive: true });
  btn.addEventListener('touchend', e => {
    lastTouchAt = Date.now();
    release(e);
  }, { passive: false });
  btn.addEventListener('touchcancel', e => {
    lastTouchAt = Date.now();
    /* 部分浏览器在长按被系统接管时会发 touchcancel：
       只要已经按满 500ms 且没因滑动取消，就照样完成长按，避免「按好几次才成功」 */
    const held = pressed && (Date.now() - startAt) >= RD_LONG_PRESS_MS;
    const wasFired = fired;
    stop();
    if (fired) { rdLongPressReleasedAt = Date.now(); if (e && e.cancelable) e.preventDefault(); return; }
    if (held && !wasFired) {
      fired = true;
      rdBookLongPressedAt = Date.now();
      rdLongPressReleasedAt = Date.now();
      rdAskDeleteBook(bookId);
      if (e && e.cancelable) e.preventDefault();
    }
  });

  /* 电脑端：mousedown / mouseup */
  btn.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (Date.now() - lastTouchAt < 600) return;   /* 触屏的模拟 mousedown，忽略 */
    begin(e.clientX, e.clientY);
  });
  btn.addEventListener('mouseup', release);
  btn.addEventListener('mouseleave', () => {
    /* 鼠标移出才取消；触屏不看 pointerleave，避免轻微抖动误取消 */
    if (pressed) stop();
  });

  /* 指针松开兜底：松手瞬间再拦一次，确保 click 不落到遮罩/弹窗上 */
  btn.addEventListener('pointerup', release);
}

function rdAskDeleteBook(bookId) {
  const b = state.readData.books.find(x => x.id === bookId);
  const mask = $('#rdDelModal');
  const txt = $('#rdDelText');
  if (!b || !mask) return;
  rdPendingDeleteBookId = bookId;
  if (txt) txt.textContent = '确定要移除《' + b.name + '》吗？相关的阅读进度和感悟也会一并消失哦。';
  /* 三重防穿透：时间戳硬锁 + 全局状态锁 + 遮罩物理屏蔽 */
  modalOpenedTime = Date.now();
  isPoppingUp = true;
  mask.classList.add('is-locked');     /* 300ms 内遮罩物理屏蔽所有点击 */
  mask.classList.remove('hidden');
  requestAnimationFrame(() => mask.classList.add('show'));
  if (rdDelLockTimer) clearTimeout(rdDelLockTimer);
  rdDelLockTimer = setTimeout(() => {
    rdDelLockTimer = null;
    isPoppingUp = false;
    mask.classList.remove('is-locked');
  }, 300);
}

function rdCloseDeleteModal() {
  const mask = $('#rdDelModal');
  rdPendingDeleteBookId = '';
  modalOpenedTime = 0;
  isPoppingUp = false;
  if (rdDelLockTimer) { clearTimeout(rdDelLockTimer); rdDelLockTimer = null; }
  if (!mask || mask.classList.contains('hidden')) return;
  mask.classList.remove('is-locked');
  mask.classList.remove('show');
  setTimeout(() => mask.classList.add('hidden'), 170);
}

function rdDeleteBook(bookId) {
  const d = state.readData;
  const idx = d.books.findIndex(b => b.id === bookId);
  if (idx < 0) return;
  const name = d.books[idx].name;
  d.books.splice(idx, 1);
  /* 删的正好是当前书：清空进度与章节缓存，切到剩下的第一本，避免指向已删除的书 */
  if (d.bookId === bookId) {
    d.bookId = d.books[0] ? d.books[0].id : '';
    d.readPos = 0;
    d.chapter = 0;
    rdChapterCache = { bookId: '', len: -1, chapters: [] };
  }
  /* 该书专属的阅读聊天记录（普通消息 / 书摘感悟卡都按 bookId 标记）一并清掉 */
  d.chat = (d.chat || []).filter(m => m.bookId !== bookId);
  /* 书架已空：顺势结束共读会话，避免残留「继续共读」入口和计时器 */
  if (!d.books.length) {
    rdStopTimers();
    rdEndSession();
    d.readPos = 0;
    d.chapter = 0;
  }
  persist();
  /* 分表里这本书的正文同步删除，避免占用空间 */
  if (Storage.mode === 'idb') {
    DB.del(STORE_BOOKS, bookId);
    rdParasTried.delete(bookId);
  }
  showToast('已移除《' + name + '》');
  applyRoute();   /* 重新渲染书架；没有书时自动回到空状态提示 */
}

/* ---------- 阅读界面 ---------- */
function openReadingRoom() {
  if (!state.readData.books.length) {
    showToast('先上传一本书吧');
    navigate({ page: 'sub', name: 'reading' });
    return;
  }
  navigate({ page: 'sub', name: 'readingroom' });
}

function renderReadingRoomPage() {
  const d = state.readData;
  const book = d.books.find(b => b.id === d.bookId) || d.books[0] || null;
  if (book && d.bookId !== book.id) { d.bookId = book.id; persist(); }
  /* 正文只存在 books 表：若本次没有读到（首次升级或瞬时失败），补读一次再渲染 */
  if (book && (!book.paras || !book.paras.length) && Storage.mode === 'idb' && !rdParasTried.has(book.id)) {
    rdParasTried.add(book.id);
    DB.get(STORE_BOOKS, book.id).then(rec => {
      if (rec && Array.isArray(rec.paras) && rec.paras.length) {
        book.paras = rec.paras;
        rdChapterCache = { bookId: '', len: -1, chapters: [] };
        if (currentRoute.page === 'sub' && currentRoute.name === 'readingroom') applyRoute();
      }
    });
  }
  const role = roleById(rdCurrentRoleId());
  /* 章节化渲染：无论书多大，页面只挂当前一章，避免整本 join 造成滚动/重排卡顿 */
  const chapters = book ? rdChaptersOf(book) : [''];
  d.chapter = clamp(Number(d.chapter) || 0, 0, chapters.length - 1);
  const chapterText = chapters[d.chapter] || '';
  const multi = chapters.length > 1;
  const body = subShell(book ? book.name : '一起读书', book ? `
    ${multi ? `<div class="rr-chapter-bar">
      <button class="rr-ch-btn" id="rdPrevCh" ${d.chapter <= 0 ? 'disabled' : ''}>‹ 上一章</button>
      <span class="rr-ch-label" id="rdChLabel">第 ${d.chapter + 1} / ${chapters.length} 章</span>
      <button class="rr-ch-btn" id="rdNextCh" ${d.chapter >= chapters.length - 1 ? 'disabled' : ''}>下一章 ›</button>
    </div>` : ''}
    <div class="reading-area" id="readingArea">
      <div class="reading-text" id="readingText">${esc(chapterText)}</div>
    </div>
    <div class="rr-tip">长按选中一段文字，挑一个心情发给 TA</div>
    <div class="rr-progress" id="rrProgress"></div>
  ` : `
    <div class="rr-empty">
      <div style="font-size:14px">还没有书</div>
      <div class="muted">先上传一个 txt 文件吧</div>
      <button class="btn primary" data-rd-upload style="margin-top:6px">＋ 上传 txt</button>
    </div>
  `, `<button class="rd-finish-btn" data-rd-finish type="button">结束</button>`);

  /* 顶栏按钮在 .sub-nav 里、不在 #subBody 内，必须全局查找才能绑定成功 */
  const finishBtn = $('[data-rd-finish]');
  if (finishBtn) finishBtn.addEventListener('click', rdFinishSession);
  const upBtn = $('[data-rd-upload]', body);
  if (upBtn) upBtn.addEventListener('click', rdUploadBook);
  const prevCh = $('#rdPrevCh');
  if (prevCh) prevCh.addEventListener('click', () => rdGoChapter(-1));
  const nextCh = $('#rdNextCh');
  if (nextCh) nextCh.addEventListener('click', () => rdGoChapter(1));

  /* 挂载悬浮小聊天框并启动计时（内部会先清理旧定时器） */
  rdEnterRoom(role);
  /* 恢复上次阅读位置（按章存储，切章后回到本章顶部） */
  const sc = $('#subBody');
  if (sc) {
    if (d.readPos > 0) sc.scrollTop = d.readPos;
    sc.addEventListener('scroll', () => {
      d.readPos = Math.round(sc.scrollTop);
      rdUpdateProgress();
      rdHideQuoteBtn();
    }, { passive: true });
  }
  rdUpdateProgress();
}
/* 章节切换：只替换当前章正文，不重建整页、不重启定时器 */
function rdGoChapter(delta) {
  const d = state.readData;
  const book = d.books.find(b => b.id === d.bookId);
  if (!book) return;
  const chapters = rdChaptersOf(book);
  if (chapters.length <= 1) return;
  const cur = clamp(Number(d.chapter) || 0, 0, chapters.length - 1);
  const next = clamp(cur + delta, 0, chapters.length - 1);
  if (next === cur) return;
  d.chapter = next;
  d.readPos = 0;
  persist();
  const textEl = $('#readingText');
  if (textEl) textEl.innerHTML = esc(chapters[next]);
  const label = $('#rdChLabel');
  if (label) label.textContent = '第 ' + (next + 1) + ' / ' + chapters.length + ' 章';
  const prev = $('#rdPrevCh');
  if (prev) prev.disabled = next <= 0;
  const nx = $('#rdNextCh');
  if (nx) nx.disabled = next >= chapters.length - 1;
  const sc = $('#subBody');
  if (sc) sc.scrollTop = 0;
  rdUpdateProgress();
  rdHideQuoteBtn();
}

function rdFinishSession() {
  /* 先停计时器，再存进度，最后清理共读状态并返回 */
  rdStopTimers();
  const sc = $('#subBody');
  if (sc) state.readData.readPos = Math.round(sc.scrollTop);
  rdEndSession();
  rdHideFloat();
  persist();
  showToast('共读已结束');
  goBack();
}

function rdUpdateProgress() {
  const el = $('#rrProgress');
  if (!el) return;
  const sc = $('#subBody');
  if (!sc) { el.textContent = ''; return; }
  const max = Math.max(1, sc.scrollHeight - sc.clientHeight);
  const pct = clamp(Math.round((sc.scrollTop / max) * 100), 0, 100);
  const d = state.readData;
  const book = d.books.find(b => b.id === d.bookId);
  const chapters = book ? rdChaptersOf(book) : [''];
  el.textContent = chapters.length > 1
    ? '第 ' + (clamp(Number(d.chapter) || 0, 0, chapters.length - 1) + 1) + ' / ' + chapters.length + ' 章 · 本章已读 ' + pct + '%'
    : '已读 ' + pct + '%';
}

/* ---------- 阅读计时与陪读消息 ---------- */
function rdStartTimers() {
  rdStopTimers();
  readingCompAccum = 0;
  readingStatsTimer = setInterval(rdTick, 60000);
}
function rdStopTimers() {
  if (readingStatsTimer) { clearInterval(readingStatsTimer); readingStatsTimer = null; }
}
function rdTick() {
  if (!readingRoomMounted) return;
  /* 每分钟累加时长：共读记 together，自己读记 alone */
  const k = todayKey();
  const cur = state.readData.stats[k] || { together: 0, alone: 0 };
  if (isReadingTogether) cur.together += 60; else cur.alone += 60;
  state.readData.stats[k] = cur;
  persist();
  /* 共读时按设定间隔抽字卡发陪读消息 */
  if (!isReadingTogether) return;
  const iv = Number(state.settings.readCompanionInterval) || 0;
  if (iv <= 0) return;
  readingCompAccum += 1;
  if (readingCompAccum >= iv) {
    readingCompAccum = 0;
    rdCompanionSay();
  }
}
function rdCompanionSay() {
  if (!isReadingTogether) return;   /* 非共读状态绝不发陪读消息 */
  const roleId = rdCurrentRoleId();
  if (!roleId) return;
  const text = composeCardText(roleId);
  if (!text) return;   /* 字卡为空时不发，避免空消息 */
  state.readData.chat.push({
    id: uid(), roleId, bookId: state.readData.bookId || '',
    sender: 'ta', content: text, quote: null, ts: Date.now()
  });
  persist();
  if (readingRoomMounted) {
    rdRenderChatBody();
    rdNotifyChat();
  }
}

/* ---------- 悬浮小聊天框 ---------- */
function rdHideFloat() {
  const fc = $('#rdFChat');
  if (fc) {
    fc.classList.add('hidden');
    fc.classList.remove('expanded', 'bump');
  }
  readingExpanded = false;
  readingQuote = null;
  rdRenderQuotePreview();
  rdHideQuoteBtn();
  if (readingQuoteTimer) { clearTimeout(readingQuoteTimer); readingQuoteTimer = null; }
}

function rdShowFloat(role) {
  const fc = $('#rdFChat');
  if (!fc) return;
  fc.classList.remove('hidden', 'expanded', 'bump');
  readingExpanded = false;
  const pos = state.readData.fcPos;
  const maxW = Math.max(200, window.innerWidth - 24);
  const w = Math.min(pos && pos.w ? pos.w : 280, maxW);
  fc.style.width = w + 'px';
  const nameEl = $('#rdFCName');
  if (nameEl) nameEl.textContent = role ? role.name : 'TA';
  const avaEl = $('#rdFCAva');
  if (avaEl) avaEl.innerHTML = role ? roleAvatarHTML(role, 22) : '🌙';
  if (pos) {
    fc.style.left = clamp(pos.left, 6, Math.max(6, window.innerWidth - w - 6)) + 'px';
    fc.style.top = clamp(pos.top, 8, Math.max(8, window.innerHeight - 120)) + 'px';
    fc.style.right = 'auto';
    fc.style.bottom = 'auto';
  } else {
    fc.style.left = '';
    fc.style.top = '';
    fc.style.right = '14px';
    fc.style.bottom = 'calc(76px + env(safe-area-inset-bottom))';
  }
}

function rdRenderChatBody() {
  const bodyEl = $('#rdFCBody');
  if (!bodyEl) return;
  const roleId = rdCurrentRoleId();
  const all = state.readData.chat.filter(m => m.roleId === roleId);
  let list;
  if (readingExpanded) {
    list = all;
  } else {
    /* 收起状态：只渲染最后一条「我」和最后一条「TA」 */
    let lastMe = null, lastTa = null;
    all.forEach(m => { if (m.sender === 'ta') lastTa = m; else lastMe = m; });
    list = [lastMe, lastTa].filter(Boolean).sort((a, b) => a.ts - b.ts);
  }
  if (!list.length) {
    bodyEl.innerHTML = `<div class="rd-fc-empty">还没有聊天，说点什么吧</div>`;
    return;
  }
  bodyEl.innerHTML = list.map(m => {
    const mine = m.sender === 'user';
    /* 引用情绪卡：书摘 + 细分割线 + 情绪，像一张书签 */
    if (m.type === 'quote') {
      return `<div class="rd-fc-msg ${mine ? 'mine' : 'theirs'}">
        <div class="rd-fc-note">
          <div class="rd-fc-note-quote">${esc(m.quoteText || '')}</div>
          <div class="rd-fc-note-line"></div>
          <div class="rd-fc-note-emotion">${esc(m.emotion || '')}</div>
        </div>
      </div>`;
    }
    return `<div class="rd-fc-msg ${mine ? 'mine' : 'theirs'}">
      <div class="rd-fc-bubble">
        ${m.quote ? `<span class="rd-fc-q">${esc(m.quote.text)}</span>` : ''}${esc(m.content)}
      </div>
    </div>`;
  }).join('');
  bodyEl.scrollTop = bodyEl.scrollHeight;
}

function rdToggleChat() {
  const fc = $('#rdFChat');
  if (!fc) return;
  readingExpanded = !readingExpanded;
  fc.classList.toggle('expanded', readingExpanded);
  const dot = $('#rdFCDot');
  if (dot) dot.classList.add('hidden');
  rdRenderChatBody();
  if (readingExpanded) {
    /* 展开后若超出屏幕底部，向上收回到可视范围 */
    const h = fc.offsetHeight;
    const maxTop = Math.max(8, window.innerHeight - h - 8);
    if (fc.offsetTop > maxTop) {
      fc.style.top = maxTop + 'px';
      fc.style.bottom = 'auto';
    }
  }
}

function rdNotifyChat() {
  const fc = $('#rdFChat');
  if (!fc || fc.classList.contains('hidden')) return;
  if (!readingExpanded) {
    const dot = $('#rdFCDot');
    if (dot) dot.classList.remove('hidden');
  }
  fc.classList.add('bump');
  setTimeout(() => fc.classList.remove('bump'), 300);
}

function rdRenderQuotePreview() {
  const box = $('#rdFCQuote');
  const txt = $('#rdFCQText');
  if (!box || !txt) return;
  if (readingQuote && readingQuote.text) {
    box.classList.remove('hidden');
    txt.textContent = (readingQuote.who ? readingQuote.who + '：' : '') + readingQuote.text;
  } else {
    box.classList.add('hidden');
  }
}
function rdClearQuote() {
  readingQuote = null;
  rdRenderQuotePreview();
}

function rdSendChat() {
  const input = $('#rdFCText');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  const roleId = rdCurrentRoleId();
  if (!roleId) return;
  const quote = readingQuote ? { text: readingQuote.text, who: readingQuote.who } : null;
  /* 记下发送时正在读的书，TA 延迟回复也归到同一本书名下 */
  const bid = state.readData.bookId || '';
  state.readData.chat.push({
    id: uid(), roleId, bookId: bid, sender: 'user', content: text, quote, ts: Date.now()
  });
  input.value = '';
  rdClearQuote();
  persist();
  rdRenderChatBody();
  /* TA 根据字卡库回复 */
  setTimeout(() => {
    const reply = composeCardText(roleId);
    if (!reply) return;
    state.readData.chat.push({
      id: uid(), roleId, bookId: bid, sender: 'ta', content: reply, quote: null, ts: Date.now()
    });
    persist();
    if (readingRoomMounted) { rdRenderChatBody(); rdNotifyChat(); }
  }, randInt(700, 1500));
}

/* ---------- 长按选词 → 情绪选择浮层 ---------- */
function rdHideQuoteBtn() {
  const btn = $('#rdQuoteBtn');
  if (btn) btn.classList.add('hidden');
  const pop = $('#rdEmotionPop');
  if (pop) pop.classList.add('hidden');
}
function rdShowEmotionPop(rect) {
  const pop = $('#rdEmotionPop');
  if (!pop) return;
  const quoteEl = $('#rdEmotionQuote');
  if (quoteEl) quoteEl.textContent = '“' + readingSelText + '”';
  pop.classList.remove('hidden');
  const pad = 8, gap = 10;
  const w = pop.offsetWidth, h = pop.offsetHeight;
  /* 水平：以选区中心对齐，两侧都不出屏 */
  const cx = rect.left + rect.width / 2;
  const left = clamp(cx - w / 2, pad, Math.max(pad, window.innerWidth - w - pad));
  /* 垂直：优先放选区上方（不挡正在读的字），上方放不下就放下方，
     两边都放不下时夹回可视范围内 */
  const above = rect.top - h - gap;
  const below = rect.bottom + gap;
  let top;
  if (above >= pad) top = above;
  else if (below + h <= window.innerHeight - pad) top = below;
  else top = above;
  top = clamp(top, pad, Math.max(pad, window.innerHeight - h - pad));
  pop.style.left = Math.round(left) + 'px';
  pop.style.top = Math.round(top) + 'px';
}
/* 手指 / 鼠标离开阅读区后再取选区：避免“早弹”，也不清蓝框 */
function rdHandleSelectionEnd() {
  if (!readingRoomMounted) return;
  if (readingQuoteTimer) clearTimeout(readingQuoteTimer);
  readingQuoteTimer = setTimeout(() => {
    const pop = $('#rdEmotionPop');
    const textEl = $('#readingText');
    if (!pop || !textEl) return;
    const sel = window.getSelection();
    const text = sel ? String(sel.toString()).trim() : '';
    if (!text || text.length > 400 || !sel.rangeCount) {
      pop.classList.add('hidden'); readingSelText = ''; return;
    }
    const anchor = sel.anchorNode;
    const node = anchor && anchor.nodeType === 3 ? anchor.parentNode : anchor;
    if (!node || !textEl.contains(node)) {
      pop.classList.add('hidden'); readingSelText = ''; return;
    }
    let rect = null;
    try { rect = sel.getRangeAt(0).getBoundingClientRect(); } catch (err) { rect = null; }
    if (!rect || (!rect.width && !rect.height)) {
      pop.classList.add('hidden'); readingSelText = ''; return;
    }
    readingSelText = text.slice(0, 300);
    rdShowEmotionPop(rect);
    /* 注意：这里绝对不清除选区，原生蓝框保持到用户点完情绪按钮 */
  }, 150);
}
/* 点击情绪 → 生成「书摘 + 情绪」引用卡片，并让 TA 抽卡回应 */
function rdSendQuoteEmotion(emotion) {
  const roleId = rdCurrentRoleId();
  const qText = String(readingSelText || '').trim();
  if (!roleId || !qText || !emotion) return;
  const bid = state.readData.bookId || '';
  state.readData.chat.push({
    id: uid(), roleId, bookId: bid, sender: 'user', type: 'quote',
    quoteText: qText, emotion: emotion, content: '', quote: null, ts: Date.now()
  });
  readingSelText = '';
  rdHideQuoteBtn();
  persist();
  rdRenderChatBody();
  /* 卡片已经 push 进历史并渲染完成，最后一步才清除蓝框 */
  try { const s = window.getSelection(); if (s) s.removeAllRanges(); } catch (err) { /* 忽略 */ }
  setTimeout(() => {
    const reply = composeCardText(roleId);
    if (!reply) return;
    state.readData.chat.push({
      id: uid(), roleId, bookId: bid, sender: 'ta', content: reply, quote: null, ts: Date.now()
    });
    persist();
    /* 与普通文本回复一致：已退出阅读界面时只落库，不再渲染 */
    if (readingRoomMounted) { rdRenderChatBody(); rdNotifyChat(); }
  }, randInt(1000, 2000));
}

/* ---------- 进入 / 退出阅读界面 ---------- */
function rdEnterRoom(role) {
  readingRoomMounted = true;
  readingExpanded = false;
  readingQuote = null;
  rdStopTimers();              /* 进入前先清掉可能残留的旧计时器，避免重复叠加 */
  /* 只有「接受共读」且存在共读梦角时才显示悬浮小窗，自己读一律隐藏 */
  const together = isReadingTogether === true && !!(readingRoleId || state.readData.roleId);
  if (together) {
    rdShowFloat(role);
    rdRenderChatBody();
    rdRenderQuotePreview();
  } else {
    rdHideFloat();
  }
  rdStartTimers();             /* 计时器均需运行；陪读消息在 rdTick 内按共读状态判断 */
}
function rdUnmountRoom() {
  readingRoomMounted = false;
  rdStopTimers();
  if (readingQuoteTimer) { clearTimeout(readingQuoteTimer); readingQuoteTimer = null; }
  rdHideQuoteBtn();
  /* 保存阅读位置，刷新后接着读 */
  const sc = $('#subBody');
  if (sc) state.readData.readPos = Math.round(sc.scrollTop);
  persist();
  const fc = $('#rdFChat');
  if (fc) {
    fc.classList.add('hidden');
    fc.classList.remove('expanded', 'bump');
    fc.style.left = '';
    fc.style.top = '';
    fc.style.right = '14px';
    fc.style.bottom = 'calc(76px + env(safe-area-inset-bottom))';
  }
  const q = $('#rdFCQuote');
  if (q) q.classList.add('hidden');
  const input = $('#rdFCText');
  if (input) input.value = '';
  readingQuote = null;
  readingExpanded = false;
}

/* ---------- 双向邀请 ---------- */
/* 我邀请 TA：source = 'chat'（聊天页 + 菜单）或 'reading'（一起读主页面） */
function inviteReadTogether(roleId, source) {
  const rid = roleId && roleById(roleId) ? roleId : rdCurrentRoleId();
  const role = roleById(rid);
  if (!role) { showToast('还没有梦角'); return; }
  if (state.readData.isReading && state.readData.roleId === rid) {
    showToast('你们已经在共读了');
    if (source === 'reading') openReadingRoom();
    return;
  }
  const acceptChance = clamp(Number(state.settings.readTogetherAcceptChance ?? 80), 0, 100);
  const gen = chatGenMap.get(rid) || 0;
  const msg = {
    id: uid(), role: 'user', type: 'readInvite', direction: 'out',
    status: 'pending', ts: Date.now(), read: true
  };
  chatOf(rid).push(msg);
  persist();
  renderChatIf(rid);
  refreshMessagesPage();
  showToast('已发送共读邀请，等待接受…');
  setTimeout(() => {
    if (gen !== (chatGenMap.get(rid) || 0)) return;
    const ok = Math.random() * 100 < acceptChance;
    msg.status = ok ? 'accepted' : 'rejected';
    if (ok) rdStartSession(rid);
    persist();
    renderChatIf(rid);
    refreshMessagesPage();
    if (!ok) { showToast(taName(rid) + ' 暂时不想一起读'); return; }
    if (source === 'chat') {
      /* 来源是聊天页：延迟 1 秒自动跳到【一起读书】主页面 */
      setTimeout(() => {
        if (currentRoute.page === 'chat' && currentRoute.roleId === rid) {
          navigate({ page: 'sub', name: 'reading' });
        }
      }, 1000);
    } else {
      showToast(taName(rid) + ' 接受了邀请');
      applyRoute();
    }
  }, 2000);
}

/* TA 主动邀请我：接受 */
function acceptReadInvite(roleId, msgId) {
  const msg = chatOf(roleId).find(m => m.id === msgId);
  if (!msg || (msg.status || 'pending') !== 'pending') return;
  msg.status = 'accepted';
  rdStartSession(roleId);
  persist();
  renderChatIf(roleId);
  refreshMessagesPage();
  showToast('已接受共读邀请');
  /* 自动跳转到【一起读书】主页面 */
  setTimeout(() => {
    if (currentRoute.page === 'chat' && currentRoute.roleId === roleId) {
      navigate({ page: 'sub', name: 'reading' });
    } else if (currentRoute.page === 'sub' && currentRoute.name === 'reading') {
      applyRoute();
    }
  }, 500);
}

/* TA 主动邀请我：拒绝 → 卡片变已拒绝 + TA 字卡回复 */
function rejectReadInvite(roleId, msgId) {
  const msg = chatOf(roleId).find(m => m.id === msgId);
  if (!msg || (msg.status || 'pending') !== 'pending') return;
  msg.status = 'rejected';
  persist();
  renderChatIf(roleId);
  refreshMessagesPage();
  taSayAfterDelay(roleId, () => {
    const t = composeCardText(roleId);
    return { type: 'text', content: t || '好吧，那下次再一起读。' };
  });
}

/* 全局判定：TA 按「主动邀请共读概率」发起邀请（复用主动消息的定时检查框架） */
function checkTaReadInvite() {
  if (!state || !state.readData) return;
  const now = Date.now();
  if (!state.nextTaReadInviteAt) {
    state.nextTaReadInviteAt = now + randInt(25, 55) * 60000;
    persist();
    return;
  }
  if (now < state.nextTaReadInviteAt) return;
  state.nextTaReadInviteAt = now + randInt(25, 55) * 60000;
  persist();
  if (state.readData.isReading) return;
  if (callState && callState.status !== 'idle') return;
  const chance = clamp(Number(state.settings.readInviteChance ?? 10), 0, 100);
  if (chance <= 0) return;
  state.roles.forEach(role => {
    if (!role || !role.id) return;
    const list = state.chats[role.id] || [];
    /* 已有待处理邀请时不重复发 */
    if (list.some(m => m.type === 'readInvite' && (m.status || 'pending') === 'pending')) return;
    if (Math.random() * 100 >= chance) return;
    pushDreamMessage(role.id, { type: 'readInvite', direction: 'in', status: 'pending' });
  });
  refreshMessagesPage();
}

/* ---------- 悬浮框全局事件（只绑定一次） ---------- */
function rdBindGlobal() {
  const head = $('#rdFCHead');
  const fc = $('#rdFChat');
  if (head && fc && head.dataset.rdBound !== '1') {
    head.dataset.rdBound = '1';
    head.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const rect = fc.getBoundingClientRect();
      readingDragState = {
        id: e.pointerId, sx: e.clientX, sy: e.clientY,
        ox: rect.left, oy: rect.top, moved: false
      };
      fc.style.transition = 'none';
      try { head.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      e.preventDefault();
    });
    head.addEventListener('pointermove', e => {
      if (!readingDragState || e.pointerId !== readingDragState.id) return;
      const dx = e.clientX - readingDragState.sx;
      const dy = e.clientY - readingDragState.sy;
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) readingDragState.moved = true;
      const w = fc.offsetWidth, h = fc.offsetHeight;
      fc.style.left = clamp(readingDragState.ox + dx, 6, Math.max(6, window.innerWidth - w - 6)) + 'px';
      fc.style.top = clamp(readingDragState.oy + dy, 8, Math.max(8, window.innerHeight - h - 8)) + 'px';
      fc.style.right = 'auto';
      fc.style.bottom = 'auto';
    });
    head.addEventListener('pointerup', e => {
      if (!readingDragState || e.pointerId !== readingDragState.id) return;
      const moved = readingDragState.moved;
      readingDragState = null;
      fc.style.transition = '';
      try { head.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      if (moved) {
        state.readData.fcPos = { left: fc.offsetLeft, top: fc.offsetTop, w: fc.offsetWidth };
        persist();
      } else {
        rdToggleChat();
      }
    });
    head.addEventListener('pointercancel', () => {
      readingDragState = null;
      fc.style.transition = '';
    });
  }
  const send = $('#rdFCSend');
  if (send && send.dataset.rdBound !== '1') {
    send.dataset.rdBound = '1';
    send.addEventListener('click', rdSendChat);
  }
  /* 悬浮窗专属回车发送：只绑定在 #rdFCText 上，不影响主聊天页 */
  const fcInput = $('#rdFCText');
  if (fcInput && fcInput.dataset.rdEnterBound !== '1') {
    fcInput.dataset.rdEnterBound = '1';
    fcInput.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      /* 中文输入法拼音选词中（含部分安卓的 keyCode 229）不发送 */
      if (e.isComposing || e.keyCode === 229) return;
      e.preventDefault();          /* 阻止换行 */
      e.stopPropagation();         /* 与主聊天页的 Enter 逻辑隔离 */
      if (!fcInput.value.trim()) return;   /* 空白内容不发送 */
      rdSendChat();
    });
  }
  const qx = $('#rdFCQX');
  if (qx && qx.dataset.rdBound !== '1') {
    qx.dataset.rdBound = '1';
    qx.addEventListener('click', rdClearQuote);
  }
  /* 情绪浮层：整层绑定一次。mousedown / touchstart 里 preventDefault 保住蓝框，
     触屏被 preventDefault 后不会再派发 click，所以用 touchend 补触发 */
  const pop = $('#rdEmotionPop');
  if (pop && pop.dataset.rdBound !== '1') {
    pop.dataset.rdBound = '1';
    /* 只对按钮阻止默认：保住蓝框，同时允许在面板空白处滑动查看 */
    pop.addEventListener('mousedown', e => {
      if (e.target && e.target.closest && e.target.closest('[data-emotion]')) e.preventDefault();
    });
    pop.addEventListener('touchstart', e => {
      if (e.target && e.target.closest && e.target.closest('[data-emotion]')) e.preventDefault();
    }, { passive: false });
    pop.addEventListener('touchend', e => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-emotion]') : null;
      if (!btn) return;
      e.preventDefault();
      rdLastEmotionTapAt = Date.now();
      rdSendQuoteEmotion(btn.dataset.emotion || '');
    }, { passive: false });
    pop.addEventListener('click', e => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-emotion]') : null;
      if (!btn) return;
      if (Date.now() - rdLastEmotionTapAt < 600) return;  /* touchend 已经发过 */
      rdSendQuoteEmotion(btn.dataset.emotion || '');
    });
  }
  /* 长按书本的删除确认框：遮罩与按钮只绑一次 */
  const delModal = $('#rdDelModal');
  if (delModal && delModal.dataset.rdBound !== '1') {
    delModal.dataset.rdBound = '1';
    delModal.addEventListener('click', e => {
      /* 全局状态锁：弹窗弹出瞬间的点击一律无效（松手穿透） */
      if (isPoppingUp) return;
      /* 时间戳硬锁：弹窗刚弹出的 1 秒内，遮罩上的任何点击都不关闭 */
      if (Date.now() - modalOpenedTime < RD_DEL_LOCK_MS) return;
      /* 长按松手后紧随的幽灵 click 也一律无效 */
      if (Date.now() - rdLongPressReleasedAt < RD_GHOST_CLICK_MS) return;
      /* 只有点到遮罩本身才关闭；卡片 / 按钮内部的点击一律不管 */
      if (e.target !== delModal) return;
      rdCloseDeleteModal();   /* 点遮罩空白处关闭 */
    });
    const delCancel = $('#rdDelCancel');
    if (delCancel) delCancel.addEventListener('click', e => {
      e.stopPropagation();
      rdCloseDeleteModal();
    });
    const delOk = $('#rdDelOk');
    if (delOk) delOk.addEventListener('click', e => {
      e.stopPropagation();
      const id = rdPendingDeleteBookId;
      rdCloseDeleteModal();       /* 内部会清空待删 id，所以先取出来 */
      if (id) rdDeleteBook(id);
    });
  }
  if (!rdBindGlobal.bound) {
    rdBindGlobal.bound = true;
    /* 捕获阶段吞掉长按松手后的幽灵 click：不论落到遮罩、卡片还是按钮，全部作废，
       保证松手那一下绝不会「点掉」确认框；400ms 后的正常点击照常生效 */
    document.addEventListener('click', e => {
      if (!rdLongPressReleasedAt) return;
      if (Date.now() - rdLongPressReleasedAt >= RD_GHOST_CLICK_MS) return;
      e.preventDefault();
      e.stopPropagation();
    }, true);
    /* 只在手指/鼠标离开后取选区，禁止 touchstart、禁止 selectionchange 早弹 */
    document.addEventListener('mouseup', e => {
      const t = e.target;
      if (!readingRoomMounted) return;
      if (!(t && t.closest && t.closest('.reading-text'))) return;
      rdHandleSelectionEnd();
    });
    document.addEventListener('touchend', e => {
      const t = e.target;
      if (!readingRoomMounted) return;
      if (!(t && t.closest && t.closest('.reading-text'))) return;
      rdHandleSelectionEnd();
    }, { passive: true });
    /* 在浮层以外的任何位置按下 → 收起浮层，不遮挡阅读 */
    document.addEventListener('pointerdown', e => {
      if (!readingRoomMounted) return;
      const t = e.target;
      const pop2 = $('#rdEmotionPop');
      if (pop2 && !pop2.classList.contains('hidden') &&
          !(t && t.closest && t.closest('#rdEmotionPop'))) {
        pop2.classList.add('hidden');
        readingSelText = '';
      }
    }, true);
    window.addEventListener('resize', () => {
      const el = $('#rdFChat');
      if (!el || el.classList.contains('hidden')) return;
      const w = el.offsetWidth, h = el.offsetHeight;
      if (el.offsetLeft + w > window.innerWidth - 6) {
        el.style.left = Math.max(6, window.innerWidth - w - 6) + 'px';
        el.style.right = 'auto';
      }
      if (el.offsetTop + h > window.innerHeight - 6) {
        el.style.top = Math.max(8, window.innerHeight - h - 8) + 'px';
        el.style.bottom = 'auto';
      }
    });
  }
}


/* =========================================================
 * 二十四·一、离线消息补发提示横幅
 * 极简两行纯文本：离线期间 TA 的新消息数 / 已超时的待办与提醒数；
 * 页面加载（DOMContentLoaded）与切回前台时结算一次，4 秒后自动滑出；
 * 点击横幅会关掉横幅并跳到对应页面（有未读消息 → 消息列表；只有超时待办 → 待办页）
 * ========================================================= */
let welcomeBannerTimer = null;
let welcomeBannerHideTimer = null;
/* 横幅点击的目标页：messages 消息列表 / todo 待办页面，空字符串表示无处可跳 */
let welcomeBannerTarget = '';

/* 显示横幅：先落文本再滑入，保证从顶部平滑进入 */
function welcomeBannerShow(html) {
  const el = $('#welcome-banner');
  if (!el) return;
  clearTimeout(welcomeBannerTimer);
  clearTimeout(welcomeBannerHideTimer);
  el.innerHTML = html;
  el.style.display = 'block';
  void el.offsetHeight;                 /* 强制一次重排，让 -100% 初始态生效，滑入才有动画 */
  el.classList.add('show');
  welcomeBannerTimer = setTimeout(welcomeBannerHide, 4000);   /* 显示 4 秒后自动滑出 */
}

/* 隐藏横幅：先播放滑出动画，动画结束再彻底隐藏并清空文本 */
function welcomeBannerHide() {
  const el = $('#welcome-banner');
  clearTimeout(welcomeBannerTimer);
  welcomeBannerTimer = null;
  if (!el) return;
  el.classList.remove('show');
  clearTimeout(welcomeBannerHideTimer);
  welcomeBannerHideTimer = setTimeout(() => {
    /* 期间又被新横幅唤出时不要误隐藏 */
    if (!el.classList.contains('show')) {
      el.style.display = 'none';
      el.innerHTML = '';
      welcomeBannerTarget = '';
    }
  }, 300);
}

/* 点击横幅：先读取要跳转的目标（点具体那行优先，否则用主目标），
 * 立刻关闭横幅，再打开消息列表或待办页面 */
function welcomeBannerClick(e) {
  const line = e.target && e.target.closest ? e.target.closest('[data-wbt]') : null;
  const target = (line && line.dataset.wbt) || welcomeBannerTarget;
  welcomeBannerHide();
  if (target === 'messages') switchTab('messages');
  else if (target === 'todo') navigate({ page: 'sub', name: 'todo' });
}

/* 记录「离开页面」的时间：切后台 / 关闭页面时调用，回前台时据此结算离线事件 */
function markOfflineStart() {
  if (!state) return;
  state.lastSeenAt = Date.now();
  persist(true);
}

/* 日常提醒的时刻：YYYY-MM-DD + HH:MM → 本地毫秒时间戳（无时间按 09:00，与待办一致） */
function welcomeReminderTs(dateKey, timeStr) {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ''));
  if (!dm) return 0;
  const tm = /^(\d{1,2}):(\d{2})$/.exec(String(timeStr || ''));
  const hh = tm ? Number(tm[1]) : 9;
  const mm = tm ? Number(tm[2]) : 0;
  return new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), hh, mm, 0, 0).getTime();
}

/* 离线窗口内已到点的日常提醒条数：
 * 从离开当天逐日检查到 today，只有提醒时刻落在 (seenAt, now] 才算「错过」；
 * 最多回溯 31 天，防止异常时间戳造成超大循环 */
function welcomeMissedReminderCount(seenAt, now) {
  const list = Array.isArray(state.dailyReminders) ? state.dailyReminders : [];
  if (!list.length || !(seenAt > 0)) return 0;
  const start = new Date(seenAt);
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const today = new Date();
  const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const DAY = 86400000;
  let count = 0;
  for (let i = 0; i < 31; i++) {
    const ms = cursor.getTime() + i * DAY;
    if (ms > todayMid) break;
    const d = new Date(ms);
    const key = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    list.forEach(r => {
      if (!r || !reminderActiveOn(r, key)) return;
      const ts = welcomeReminderTs(key, r.time);
      if (ts > seenAt && ts <= now) count++;
    });
  }
  return count;
}

/* 结算离线期间事件并显示横幅：
 * unreadMsgCount  = 这段时间内 TA（role:'dream'）新产生的消息条数（撤回的不算）
 * overdueTodoCount = 这段时间内到期且仍未完成的待办 + 这段时间内错过的日常提醒
 * 两者都为 0 时不显示横幅 */
function checkOfflineEvents() {
  if (!state) return;
  const el = $('#welcome-banner');
  if (!el) return;
  const now = Date.now();
  const seenAt = Number(state.lastSeenAt) || 0;
  /* 第一次运行 / 没有上次离开记录：只记录起点，不弹横幅 */
  if (!(seenAt > 0)) {
    state.lastSeenAt = now;
    persist();
    return;
  }

  /* ① TA 在离线期间生成的新消息（按真实字段 role:'dream' 判定） */
  let unreadMsgCount = 0;
  (state.roles || []).forEach(r => {
    const list = state.chats && state.chats[r.id];
    if (!Array.isArray(list)) return;
    list.forEach(m => {
      if (!m || m.recalled) return;
      if (m.role !== 'dream') return;
      const ts = Number(m.ts) || 0;
      if (ts > seenAt && ts <= now) unreadMsgCount++;
    });
  });

  /* ② 这段时间内到点、仍未完成的待办 */
  let overdueTodoCount = 0;
  (state.todos || []).forEach(t => {
    if (!t || t.isCompleted) return;
    const ts = Number(t.remindTime) || 0;
    if (ts > seenAt && ts <= now) overdueTodoCount++;
  });
  /* ③ 这段时间内错过的日常提醒 */
  overdueTodoCount += welcomeMissedReminderCount(seenAt, now);

  /* 结算完毕：更新离开时间，避免下一次切前台重复统计同一条消息 */
  state.lastSeenAt = now;
  persist();

  if (unreadMsgCount <= 0 && overdueTodoCount <= 0) {
    welcomeBannerHide();
    return;
  }
  /* 两行各自标注点击目标：点「消息未读」→ 消息列表，点「待办已超时」→ 待办页；
   * 没点中具体行时用主目标（有未读先看消息，否则看待办） */
  const lines = [];
  if (unreadMsgCount > 0) lines.push(`<span data-wbt="messages">你有 ${unreadMsgCount} 条消息未读</span>`);
  if (overdueTodoCount > 0) lines.push(`<span data-wbt="todo">${overdueTodoCount} 个待办已超时</span>`);
  welcomeBannerTarget = unreadMsgCount > 0 ? 'messages' : 'todo';
  welcomeBannerShow(lines.join('<br>'));
}

/* =========================================================
 * 二十四·二、单击头像查看 TA 心声胶囊
 * 触发入口：聊天页顶部头像 + 每条 TA 消息气泡旁的头像（均走 250ms 单击/双击判定）；
 * 单击 → 随机取 3 个不同情绪大类，各抽 1 个词，三色胶囊竖向排列；
 * 双击 → 仍走原有的拍一拍逻辑
 * ========================================================= */
const emotionCategories = {
  sweet: {
    name: "甜蜜心动", color: "#FF6B81", bg: "rgba(255, 107, 129, 0.15)",
    words: ["心动", "超想你", "小鹿乱撞", "满心欢喜", "被治愈了", "极致温柔", "满眼是你", "心软软", "疯狂心动", "怦然心动", "为你着迷"]
  },
  jealous: {
    name: "傲娇吃醋", color: "#FF8C00", bg: "rgba(255, 140, 0, 0.15)",
    words: ["偷偷吃醋", "委屈巴巴", "有点生气", "不想理你", "假装高冷", "想被哄", "占有欲", "患得患失", "极度黏人", "暗自赌气", "酸溜溜的", "傲娇中"]
  },
  emo: {
    name: "低落疲惫", color: "#6A5ACD", bg: "rgba(106, 90, 205, 0.15)",
    words: ["有点疲惫", "独自emo", "需要充电", "有点烦躁", "无精打采", "想静静", "放空中", "有点迷茫", "脑袋空空"]
  },
  focus: {
    name: "专注日常", color: "#3CB371", bg: "rgba(60, 179, 113, 0.15)",
    words: ["极度认真", "在忙勿扰", "专心致志", "发呆中", "偷得浮生", "听歌中", "懒洋洋", "想睡觉", "无聊中", "精神内耗"]
  },
  dark: {
    name: "腹黑暧昧", color: "#8A2BE2", bg: "rgba(138, 43, 226, 0.15)",
    words: ["胡思乱想", "被拿捏了", "毫无防备", "视线锁定", "想把你藏起", "暗自窃喜", "图谋不轨", "想入非非", "蓄谋已久"]
  }
};

/* 生成一组心声标签：随机取 3 个不同情绪大类，各抽 1 个词，
 * 同时把该分类的文字色 / 背景色一起存下来（纯数据，可直接写进消息对象）
 * 一轮连发只调用一次，整轮消息共用同一组 */
function makeHeartTags(n = 3) {
  const allKeys = Object.keys(emotionCategories);
  const keys = pickMany(allKeys, Math.min(n, allKeys.length));
  return keys.map(key => {
    const cat = emotionCategories[key];
    return { word: pickOne(cat.words || []), color: cat.color, bg: cat.bg };
  });
}

/* 读取某条 TA 消息的心声；旧数据没有 heartTags 时兜底生成一组并写回消息，
 * 这样同一条消息再次点击看到的还是同一组，不会每点一次就换 */
function heartTagsOfMessage(msg) {
  if (!msg) return null;
  if (Array.isArray(msg.heartTags) && msg.heartTags.length) return msg.heartTags;
  msg.heartTags = makeHeartTags();
  persist();
  return msg.heartTags;
}

/* 聊天记录里最后一条 TA 消息（跳过已撤回的，气泡已不可见） */
function lastTaMessage(roleId) {
  const list = chatOf(roleId);
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m && m.role === 'dream' && !m.recalled) return m;
  }
  return null;
}

/* 头像来源：梦角资料里的 avatar 可能是 Base64 / 图片链接，也可能只是 Emoji；
 * 统一转成 <img> 可用的 src（Emoji 用 SVG 包一层，避免空 src 出现裂图） */
function taStatusAvatarSrc(role) {
  const v = role && role.avatar ? String(role.avatar) : '🌙';
  if (/^(data:image|https?:|blob:)/.test(v)) return v;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80">` +
    `<rect width="80" height="80" fill="#eef2f7"/>` +
    `<text x="40" y="54" font-size="40" text-anchor="middle">${esc(v)}</text></svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

/* 打开卡片：优先使用传入的 heartTags（同一条 / 同一轮消息共用）；
 * 没传（旧数据 / 空记录）时兜底随机生成一组 */
function showTaStatusCard(roleId, tags) {
  const card = $('#ta-status-card');
  if (!card) return;
  /* 头像取自当前梦角资料 */
  const role = roleById(roleId) || (state.roles && state.roles[0]) || null;
  const avaImg = $('#status-avatar');
  if (avaImg) {
    /* 图片链接失效时兜底显示默认头像，避免出现裂图 */
    avaImg.onerror = () => { avaImg.onerror = null; avaImg.src = taStatusAvatarSrc(null); };
    avaImg.src = taStatusAvatarSrc(role);
  }
  const list = (Array.isArray(tags) && tags.length) ? tags : makeHeartTags(3);
  const box = $('#status-tags-container');
  if (box) {
    box.innerHTML = list.map(tag => {
      const t = tag || {};
      return `<span class="status-capsule" style="color:${esc(t.color || '#12b7f5')};background:${esc(t.bg || 'rgba(18,183,245,.12)')};">${esc(t.word || '')}</span>`;
    }).join('');
  }
  card.style.display = 'block';
  void card.offsetHeight;               /* 强制重排，保证从 scale(.92) 平滑放大到 1 */
  card.classList.add('show');
}

/* 关闭卡片：只有点右上角 × 才关闭，弹出后不自动消失 */
function hideTaStatusCard() {
  const card = $('#ta-status-card');
  if (!card) return;
  card.classList.remove('show');
  setTimeout(() => {
    /* 期间又被重新打开时不要误隐藏 */
    if (!card.classList.contains('show')) card.style.display = 'none';
  }, 240);
}

/* =========================================================
 * 二十四、启动与全局事件
 * ========================================================= */
function bindGlobalEvents() {
  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });
  /* 点击聊天页空白处关闭“+”面板、右上角快捷菜单与表情面板 */
  document.addEventListener('click', e => {
    if (!e.target.closest('#chatPlusPanel') && !e.target.closest('#btnPlus')) closeChatPlus();
    if (!e.target.closest('#chatKebabMenu') && !e.target.closest('#btnChatMenu')) {
      const kb = document.getElementById('chatKebabMenu');
      if (kb) kb.classList.remove('open');
    }
    /* 表情面板打开时，点击目标既不在面板内、也不是表情包按钮本身 → 收起面板并复位按钮态 */
    const ss = document.getElementById('stickerSheet');
    if (ss && ss.classList.contains('open') && !e.target.closest('#stickerSheet') && !e.target.closest('#btnSticker')) closeStickerSheet();
    if (e.target.closest('#spaceBackHome')) switchTab('home');
  });
  /* 表情面板内部点击不冒泡到上面的全局关闭逻辑（面板为静态元素，只需绑一次） */
  const stickerSheetEl = document.getElementById('stickerSheet');
  if (stickerSheetEl) stickerSheetEl.addEventListener('click', e => e.stopPropagation());
  bindCallMiniDrag();
  /* 点击离线提示横幅：关闭横幅并跳转到消息列表 / 待办页面 */
  const welcomeEl = document.getElementById('welcome-banner');
  if (welcomeEl) welcomeEl.addEventListener('click', welcomeBannerClick);
  /* 心声胶囊右上角 ×：必须 stopPropagation，避免冒泡触发页面其它点击逻辑 */
  const closeStatusBtn = document.getElementById('close-status-btn');
  if (closeStatusBtn) closeStatusBtn.addEventListener('click', e => {
    e.stopPropagation();
    hideTaStatusCard();
  });
  /* 表情包批量导入：常驻多选输入框的 change 只绑一次，避免页面重渲染后重复监听 */
  const stickerBatchInput = document.getElementById('stickerBatchInput');
  if (stickerBatchInput) stickerBatchInput.addEventListener('change', () => {
    const files = Array.from(stickerBatchInput.files || []);
    stickerBatchInput.value = '';            /* 立即清空，允许下次再选同一批文件 */
    if (files.length) importStickerFiles(files);
  });
  document.addEventListener('visibilitychange', () => {
    /* 切后台时记录离开时间；关闭页面时同样记录，供下次打开结算离线事件 */
    if (document.hidden) markOfflineStart();
    else persist(true);
  });
  window.addEventListener('beforeunload', () => markOfflineStart());
  document.addEventListener('click', () => {
    const ctx = getAudioCtx();
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }, { once: true });
}

async function boot() {
  await Storage.init();
  let saved = null;
  let legacy = false;
  try { saved = await Storage.get(STATE_KEY); } catch (e) { saved = null; }
  if (!saved) {
    try {
      const old = await Storage.get(LEGACY_KEY);
      if (old) { saved = old; legacy = true; }
    } catch (e) { /* 忽略 */ }
  }
  /* IndexedDB 可用但为空时，回读 localStorage 快照：
     上次启动若 IDB 打开超时会回退到 localStorage 写入，这里迁移回 IDB，刷新不丢数据 */
  if (!saved && Storage.mode === 'idb') {
    try {
      const raw = localStorage.getItem(STATE_KEY);
      if (raw) saved = JSON.parse(raw);
    } catch (e) { /* 忽略 */ }
    if (!saved) {
      try {
        const rawOld = localStorage.getItem(LEGACY_KEY);
        if (rawOld) { saved = JSON.parse(rawOld); legacy = true; }
      } catch (e) { /* 忽略 */ }
    }
  }

  state = mergeState(saved);
  /* 分表还原：聊天记录 / 字卡 / 书籍正文 / 图片资源全部来自 IndexedDB；
     kv 里只有轻量状态，所以这里补回完整数据后才允许渲染与落盘 */
  await hydrateHeavyData();
  rdSyncGlobals();      /* 一起读书：把持久化的共读状态同步到运行时全局变量 */
  musicTracksInit();    /* 一起听：还原歌单元数据（音频 Blob 不持久化） */
  musicBindInputs();    /* 绑定 index.html 中的隐藏音频 / 图片选择器 */
  applyTheme();
  bindGlobalEvents();
  bindUpdateFeature();  /* 检查更新：二次确认弹窗按钮只绑一次 */
  rdBindGlobal();       /* 一起读书：悬浮小聊天框与引用按钮的事件只绑一次 */
  jarCheckStreak();     /* 拾光瓶：断联超 2 天进入暗淡状态（须在首次渲染桌面之前） */
  routeStack = [];
  currentRoute = { page: 'home' };
  applyRoute();
  checkUpdateResult();  /* 检查更新：如果是「确定更新」后的刷新，弹出版本结果提示 */

  if (saved) persist(true);
  scheduleIncoming();
  startReminderPolling();  /* 提醒应用：闹钟轮询 + 经期预警（每分钟 tick，启动时立即检查一次） */

  /* 启动即补查 + 周期检查：信件回信、空间互动、字卡主动回复、自动留影、TA拍一拍、TA主动发空间、主动写信、待办提醒（不靠 setTimeout 单次调度，刷新不丢） */
  checkLetterReplies();
  checkAutoLetters();
  checkMomentInteractions();
  checkProactiveMessages();
  checkAutoSnapshots();
  checkTaGifts();
  checkTaRedPackets();
  checkTaPat();
  checkTaSpacePosts();
  checkTaReadInvite();  /* 一起读书：TA 主动邀请共读 */
  checkTodoReminders(); /* 页面加载完成时立刻补查一次错过的待办提醒 */
  /* 离线消息补发：结算上次离开后新产生的 TA 消息与超时待办，显示顶部纯文本横幅 */
  checkOfflineEvents();
  /* 24h 退回检查：延迟到 UI 渲染与全部事件绑定完成之后执行，绝不阻塞基础交互 */
  setTimeout(() => { try { checkExpiredTransactions(); } catch (e) { /* 忽略 */ } }, 800);
  setInterval(() => {
    checkLetterReplies();
    checkAutoLetters();
    checkMomentInteractions();
    checkProactiveMessages();
    checkAutoSnapshots();
    checkTaGifts();
    checkTaRedPackets();
    checkTaPat();
    checkTaSpacePosts();
    checkTaReadInvite();
    checkTodoReminders();
    try { checkExpiredTransactions(); } catch (e) { /* 容错：单次异常不影响后续轮询与其它任务 */ }
  }, 15000);

  /* 刷新后若保活开关为开启：浏览器通常会在无手势时拦截播放，
   * 先尝试一次，失败则绑定「首次点击自动恢复播放」 */
  if (state.settings.keepAliveEnabled === true) tryPlayKeepAlive();

  /* 页面重新可见时：补查待办提醒、主动来信、回信等切后台期间错过的任务 */
  document.addEventListener('visibilitychange', () => {
    if (!state) return;
    if (document.visibilityState === 'visible') {
      if (state.settings.keepAliveEnabled === true) {
        if (!keepAliveAudio || keepAliveAudio.paused) tryPlayKeepAlive();
      }
      checkTodoReminders(); /* 切后台期间错过的待办提醒，回前台立即补发 */
      checkLetterReplies(); /* 切后台期间到期的回信 */
      checkAutoLetters();   /* 时间戳已过期则立刻补发主动来信 */
      /* 全部补查完成后再结算离线事件：这样补发出来的 TA 消息也会被计入横幅 */
      checkOfflineEvents();
    }
    updateKeepAliveStatus();
  });

  /* bfcache 恢复（页面从后台缓存直接回到前台）时也补查一次，避免定时器被冻结后漏发 */
  window.addEventListener('pageshow', () => {
    if (!state) return;
    checkLetterReplies();
    checkAutoLetters();
  });

  /* 手动测试入口：控制台执行 forceAutoLetter() 或 rdForceAutoLetter() 即可强制收到一封主动来信 */
  window.forceAutoLetter = () => checkAutoLetters(true);
  window.rdForceAutoLetter = window.forceAutoLetter;
}

/* ===================== 开屏加载动画时序（Splash Screen） ===================== */
/* 遮罩与字母跳动由 HTML + CSS 在首帧自行开始，脚本只负责后续三段时序：
 *   1.5s：Loading 淡出，Logo / 拉丁文 / 中文上浮浮现
 *   3.5s：整块遮罩淡出（CSS transition 0.6s）
 *   4.1s：display:none，彻底露出主界面
 * 时序与数据初始化（boot）并行，任何一步异常都不会让遮罩卡死。 */
function runSplash() {
  const screen = $('#splash-screen');
  if (!screen) return;
  const content = $('#splash-content');
  const loading = $('#splash-loading');

  setTimeout(() => {
    if (loading) loading.classList.add('splash-out');   /* 加载文字淡出 */
    if (content) content.classList.add('show');         /* 浮现区上浮显现 */
  }, 1500);

  setTimeout(() => {
    screen.classList.add('splash-fade');                /* 整个遮罩淡出 */
    setTimeout(() => { screen.style.display = 'none'; }, 600);
  }, 3500);
}

/* 立即启动开屏动画；defer 加载保证此时 DOM 已就绪 */
runSplash();

/* 页面加载完成即启动：DOMContentLoaded 后立刻补查一次主动来信等任务，刷新不丢 */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

