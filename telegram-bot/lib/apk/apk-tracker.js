const { apkPendingFile: DB_FILE } = require('../paths');
const { readJson, writeJsonAtomic, bigintReplacer } = require('../core/json-store');

function readDb() {
  const data = readJson(DB_FILE, []);
  return Array.isArray(data) ? data : [];
}

function toJsonSafe(value) {
  if (value == null) return null;
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function writeDb(list) {
  const safe = Array.isArray(list) ? list : [];
  writeJsonAtomic(DB_FILE, safe, { newline: false, replacer: bigintReplacer });
}

function normalizeBranch(branch) {
  return (branch || '').trim();
}

function getAll() {
  return readDb();
}

// 分支名比较：不区分大小写，避免 7ktigre / 7kTigre 重复或删不掉
function branchEquals(a, b) {
  return (a || '').toLowerCase() === (b || '').toLowerCase();
}

function formatDateTime(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hour = pad(d.getHours());
  const minute = pad(d.getMinutes());
  const second = pad(d.getSeconds());
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function addOrUpdate(branch, extra = {}) {
  const b = normalizeBranch(branch);
  if (!b) return;
  const list = readDb();
  const now = formatDateTime();

  const idx = list.findIndex(item => branchEquals(item.branch, b));
  const record = {
    branch: b,
    source: extra.source || 'auto', // auto | manual
    fileName: extra.fileName ?? list[idx]?.fileName ?? null,
    chatId: toJsonSafe(extra.chatId ?? list[idx]?.chatId ?? null),
    messageId: toJsonSafe(extra.messageId ?? list[idx]?.messageId ?? null),
    // 下面这些字段用于 APK 打包所需的上下文信息（根据需要逐步补充）
    packageId: extra.packageId ?? list[idx]?.packageId ?? null,
    appName: extra.appName ?? list[idx]?.appName ?? null,
    appNameSlug: extra.appNameSlug ?? list[idx]?.appNameSlug ?? null,
    primaryDomain: extra.primaryDomain ?? list[idx]?.primaryDomain ?? null,
    updatedAt: now,
    createdAt: extra.createdAt || (idx >= 0 ? list[idx].createdAt : now),
  };

  if (idx >= 0) {
    list[idx] = record;
  } else {
    list.push(record);
  }

  writeDb(list);
}

function remove(branch) {
  const b = normalizeBranch(branch);
  if (!b) return;
  const list = readDb();
  const next = list.filter(item => !branchEquals(item.branch, b));
  if (next.length !== list.length) {
    writeDb(next);
  }
}

function clear() {
  writeDb([]);
}

module.exports = {
  getAll,
  addOrUpdate,
  remove,
  clear,
};

