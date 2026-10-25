const vm = require('vm'), fs = require('fs'), crypto = require('crypto');
const dir = require('path').join(__dirname, '..', 'apps-script') + '/';

function makeSheet(name) {
  const rows = []; // array of arrays
  const sh = {
    name, rows,
    getLastRow: () => rows.length,
    getMaxRows: () => 1000,
    getRange(r, c, nr = 1, nc = 1) {
      return {
        getValues: () => { const out = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) row.push((rows[r - 1 + i] || [])[c - 1 + j] ?? ''); out.push(row); } return out; },
        setValues(v) { for (let i = 0; i < v.length; i++) { rows[r - 1 + i] = rows[r - 1 + i] || []; for (let j = 0; j < v[i].length; j++) rows[r - 1 + i][c - 1 + j] = v[i][j]; } return this; },
        setFontWeight() { return this; }, setBackground() { return this; }, setFontColor() { return this; }, setNumberFormat() { return this; }
      };
    },
    appendRow(v) { rows.push(v.slice()); },
    deleteRow(r) { rows.splice(r - 1, 1); },
    setFrozenRows() {}
  };
  return sh;
}
const sheets = {};
const ss = {
  getSheetByName: n => sheets[n] || null,
  insertSheet: n => (sheets[n] = makeSheet(n)),
  getSheets: () => Object.values(sheets), getId: () => 'ssid', getUrl: () => 'url', deleteSheet() {}
};
const props = {};
const cacheStore = {};
const ctx = {
  console, Logger: { log() {} },
  SpreadsheetApp: { openById: () => ss, getActiveSpreadsheet: () => ss, create: () => ss },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] ?? null, setProperty: (k, v) => { props[k] = v; } }) },
  CacheService: { getScriptCache: () => ({ get: k => cacheStore[k] ?? null, put: (k, v) => { cacheStore[k] = v; }, remove: k => { delete cacheStore[k]; } }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ s, setMimeType() { return this; }, getContent() { return s; } }) },
  Utilities: {
    getUuid: () => crypto.randomUUID(),
    DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
    computeDigest: (a, s) => Array.from(crypto.createHash('sha256').update(s).digest()).map(b => b > 127 ? b - 256 : b),
    computeHmacSha256Signature: (p, k) => Array.from(crypto.createHmac('sha256', k).update(p).digest()),
    base64EncodeWebSafe: bytes => Buffer.from(bytes.map(b => b & 255)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_')
  }
};
vm.createContext(ctx);
const files = ['Database.gs', 'Auth.gs', 'Notifications.gs', 'Queue.gs', 'Matches.gs', 'Code.gs'];
for (const f of files) vm.runInContext(fs.readFileSync(dir + f, 'utf8'), ctx, { filename: f });
vm.runInContext('setupDatabase()', ctx);

function call(method, body) {
  const out = method === 'GET' ? ctx.doGet({ parameter: body }) : ctx.doPost({ postData: { contents: JSON.stringify(body) } });
  return JSON.parse(out.s);
}
module.exports = { call, ctx, sheets };
