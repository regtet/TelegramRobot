const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'apk-pending.json');

function readDb() {
  try {
    if (!fs.existsSync(DB_FILE)) return [];
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    if (!raw.trim()) return [];
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data;
  } catch {
    return [];
  }
}

function writeDb(list) {
  const safe = Array.isArray(list) ? list : [];
  fs.writeFileSync(DB_FILE, JSON.stringify(safe, null, 2), 'utf8');
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

function addOrUpdate(branch, extra = {}) {
  const b = normalizeBranch(branch);
  if (!b) return;
  const list = readDb();
  const now = new Date().toISOString();

  const idx = list.findIndex(item => branchEquals(item.branch, b));
  const record = {
    branch: b,
    source: extra.source || 'auto', // auto | manual
    fileName: extra.fileName ?? list[idx]?.fileName ?? null,
    chatId: extra.chatId ?? list[idx]?.chatId ?? null,
    messageId: extra.messageId ?? list[idx]?.messageId ?? null,
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

