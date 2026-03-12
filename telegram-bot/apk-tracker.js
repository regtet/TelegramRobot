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

function addOrUpdate(branch, extra = {}) {
  const b = normalizeBranch(branch);
  if (!b) return;
  const list = readDb();
  const now = new Date().toISOString();

  const idx = list.findIndex(item => item.branch === b);
  const record = {
    branch: b,
    source: extra.source || 'auto', // auto | manual
    fileName: extra.fileName || null,
    chatId: extra.chatId || null,
    messageId: extra.messageId || null,
    updatedAt: now,
    createdAt: extra.createdAt || now,
  };

  if (idx >= 0) {
    // 保留原 createdAt
    record.createdAt = list[idx].createdAt || record.createdAt;
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
  const next = list.filter(item => item.branch !== b);
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

