// Эмулятор среды Google Apps Script для локальной разработки и тестов:
// гоняет НАСТОЯЩИЙ gas/Code.gs (без единой правки) поверх таблиц в памяти.
// Нужен, чтобы проверять серверную логику, не трогая боевую Google Таблицу.
//
// Повторяет важные для нас особенности реальной платформы:
//  - Range.setValues()/appendRow() интерпретируют строки как ввод
//    пользователя: "123" -> число, "TRUE" -> boolean, "2026-09-23" -> Date
//    (если у столбца не задан текстовый формат "@");
//  - getDataRange() пустого листа возвращает [[""]];
//  - Utilities.computeDigest() возвращает массив знаковых байтов.
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODE_PATH = path.resolve(__dirname, "../gas/Code.gs");

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function interpret(value, textFormat) {
  if (typeof value !== "string" || textFormat) return value;
  if (value === "") return "";
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^-?\d+(\.\d+)?$/.test(value) && value.length < 16) return Number(value);
  const m = DATE_RE.exec(value);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return value;
}

class Range {
  constructor(sheet, row, col, numRows, numCols) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const src = this.sheet.rows[this.row - 1 + r] || [];
      const line = [];
      for (let c = 0; c < this.numCols; c++) {
        const v = src[this.col - 1 + c];
        line.push(v === undefined ? "" : v);
      }
      out.push(line);
    }
    return out;
  }
  setValues(values) {
    if (values.length !== this.numRows || values.some((r) => r.length !== this.numCols)) {
      throw new Error(`setValues: размер данных не совпадает с диапазоном (${this.numRows}x${this.numCols})`);
    }
    values.forEach((line, r) => {
      const idx = this.row - 1 + r;
      while (this.sheet.rows.length <= idx) this.sheet.rows.push([]);
      line.forEach((v, c) => {
        const colIdx = this.col - 1 + c;
        this.sheet.rows[idx][colIdx] = interpret(v, this.sheet.textColumns.has(colIdx + 1));
      });
    });
    return this;
  }
  clearContent() {
    for (let r = 0; r < this.numRows; r++) {
      const src = this.sheet.rows[this.row - 1 + r];
      if (!src) continue;
      for (let c = 0; c < this.numCols; c++) src[this.col - 1 + c] = "";
    }
    return this;
  }
  setNumberFormat(fmt) {
    for (let c = 0; c < this.numCols; c++) {
      if (fmt === "@") this.sheet.textColumns.add(this.col + c);
      else this.sheet.textColumns.delete(this.col + c);
    }
    return this;
  }
}

class Sheet {
  constructor(name) {
    this.name = name;
    this.rows = [];
    this.textColumns = new Set();
  }
  getName() { return this.name; }
  getLastRow() {
    for (let i = this.rows.length - 1; i >= 0; i--) {
      if ((this.rows[i] || []).some((v) => v !== "" && v !== undefined)) return i + 1;
    }
    return 0;
  }
  getLastColumn() {
    let max = 0;
    this.rows.forEach((r) => {
      for (let c = (r || []).length - 1; c >= 0; c--) {
        if (r[c] !== "" && r[c] !== undefined) { max = Math.max(max, c + 1); break; }
      }
    });
    return max;
  }
  getRange(row, col, numRows = 1, numCols = 1) {
    if (row < 1 || col < 1) throw new Error("getRange: координаты начинаются с 1");
    return new Range(this, row, col, numRows, numCols);
  }
  getDataRange() {
    const lr = Math.max(1, this.getLastRow());
    const lc = Math.max(1, this.getLastColumn());
    return new Range(this, 1, 1, lr, lc);
  }
  appendRow(values) {
    const idx = this.getLastRow();
    this.rows.length = Math.max(this.rows.length, idx);
    this.rows.splice(idx, 0, []);
    this.rows[idx] = values.map((v, c) => interpret(v, this.textColumns.has(c + 1)));
    return this;
  }
  deleteRow(rowPosition) {
    this.rows.splice(rowPosition - 1, 1);
  }
}

class Spreadsheet {
  constructor() { this.sheets = new Map(); }
  getSheetByName(name) { return this.sheets.get(name) || null; }
  insertSheet(name) {
    const s = new Sheet(name);
    this.sheets.set(name, s);
    return s;
  }
  deleteSheet(sheet) { this.sheets.delete(sheet.name); }
  getSheets() { return [...this.sheets.values()]; }
}

function signedBytes(buf) {
  return Array.from(buf, (b) => (b > 127 ? b - 256 : b));
}

function makeGlobals(world) {
  const Utilities = {
    DigestAlgorithm: { SHA_256: "sha256" },
    Charset: { UTF_8: "utf8" },
    getUuid: () => randomUUID(),
    computeDigest(alg, text) {
      return signedBytes(createHash(alg).update(String(text), "utf8").digest());
    },
    base64Decode(str) { return signedBytes(Buffer.from(str, "base64")); },
    base64Encode(bytes) { return Buffer.from(bytes.map((b) => (b < 0 ? b + 256 : b))).toString("base64"); },
    newBlob(bytes, contentType, name) {
      return { getBytes: () => bytes, getContentType: () => contentType, getName: () => name };
    },
    formatDate(date, _tz, fmt) {
      const p = (n) => String(n).padStart(2, "0");
      return fmt
        .replace("yyyy", date.getFullYear())
        .replace("MM", p(date.getMonth() + 1))
        .replace("dd", p(date.getDate()))
        .replace("HH", p(date.getHours()))
        .replace("mm", p(date.getMinutes()));
    },
    sleep() {}
  };

  const Session = { getScriptTimeZone: () => "Europe/Moscow" };

  const LockService = {
    getScriptLock: () => ({
      waitLock() { world.lockAcquired++; },
      tryLock() { return true; },
      releaseLock() {},
      hasLock() { return true; }
    })
  };

  const PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (k in world.props ? world.props[k] : null),
      setProperty(k, v) { world.props[k] = String(v); return this; },
      deleteProperty(k) { delete world.props[k]; return this; },
      getProperties: () => ({ ...world.props })
    })
  };

  const CacheService = {
    getScriptCache: () => ({
      get(k) {
        const e = world.cache[k];
        if (!e) return null;
        if (e.exp < world.now()) { delete world.cache[k]; return null; }
        return e.v;
      },
      put(k, v, ttl = 600) { world.cache[k] = { v: String(v), exp: world.now() + ttl * 1000 }; },
      remove(k) { delete world.cache[k]; }
    })
  };

  let driveSeq = 0;
  const makeFile = (blob) => {
    const id = "file" + ++driveSeq;
    const file = {
      id, name: blob.getName(), bytes: blob.getBytes(), trashed: false,
      getId: () => id,
      getName: () => file.name,
      setTrashed(v) { file.trashed = v; return file; },
      setSharing() { file.shared = true; return file; }
    };
    world.drive.files.set(id, file);
    return file;
  };
  const makeFolder = (name) => {
    const id = "folder" + ++driveSeq;
    const folder = {
      id, name,
      getId: () => id,
      getName: () => name,
      createFile: (blob) => makeFile(blob),
      setSharing() { folder.shared = true; return folder; }
    };
    world.drive.folders.set(id, folder);
    return folder;
  };
  const DriveApp = {
    Access: { ANYONE_WITH_LINK: "ANYONE_WITH_LINK" },
    Permission: { VIEW: "VIEW" },
    getFolderById(id) {
      const f = world.drive.folders.get(id);
      if (!f) throw new Error("Нет папки " + id);
      return f;
    },
    getFoldersByName(name) {
      const list = [...world.drive.folders.values()].filter((f) => f.name === name);
      return { hasNext: () => list.length > 0, next: () => list.shift() };
    },
    createFolder: (name) => makeFolder(name),
    getFileById(id) {
      const f = world.drive.files.get(id);
      if (!f) throw new Error("Нет файла " + id);
      return f;
    },
    getRootFolder: () => ({ getId: () => "root" })
  };

  const MailApp = {
    getRemainingDailyQuota: () => world.mailQuota,
    sendEmail(arg) {
      if (world.mailQuota <= 0) throw new Error("Service invoked too many times: email");
      world.mailQuota--;
      world.mail.push(typeof arg === "object" ? arg : { to: arguments[0], subject: arguments[1], body: arguments[2] });
    }
  };

  const ContentService = {
    MimeType: { JSON: "JSON", TEXT: "TEXT" },
    createTextOutput(content) {
      const out = { content, getContent: () => content, setMimeType: () => out };
      return out;
    }
  };

  const SpreadsheetApp = { getActiveSpreadsheet: () => world.ss };

  return { Utilities, Session, LockService, PropertiesService, CacheService, DriveApp, MailApp, ContentService, SpreadsheetApp };
}

// Создаёт изолированный "мир": своя таблица, свойства, кэш, Drive. Код
// Code.gs загружается в отдельный vm-контекст и видит только эти объекты.
export function createGasWorld({ setup = true, code } = {}) {
  let clock = null;
  const world = {
    ss: new Spreadsheet(),
    props: {},
    cache: {},
    drive: { files: new Map(), folders: new Map() },
    mail: [],
    mailQuota: 100,
    lockAcquired: 0,
    now: () => (clock === null ? Date.now() : clock)
  };
  const globals = makeGlobals(world);
  const context = vm.createContext({
    ...globals,
    console,
    Date: class extends Date {
      constructor(...args) { if (args.length === 0 && clock !== null) super(clock); else super(...args); }
      static now() { return world.now(); }
    }
  });
  vm.runInContext(code || readFileSync(CODE_PATH, "utf-8"), context, { filename: "Code.gs" });
  if (setup) context.setup();

  function rawCall(body) {
    const out = context.doPost({ postData: { contents: JSON.stringify(body) } });
    return JSON.parse(out.getContent());
  }

  return {
    world,
    context,
    // Вызов API ровно так, как это делает браузер (action + token + поля).
    call: (action, payload = {}, token) => rawCall(Object.assign({ action }, payload, token ? { token } : {})),
    rawCall,
    setNow(ms) { clock = ms; },
    // Строки листа в виде объектов (по шапке) — для проверок в тестах.
    rows(name) {
      const sheet = world.ss.getSheetByName(name);
      if (!sheet) return [];
      const values = sheet.getDataRange().getValues();
      const headers = values[0];
      return values.slice(1)
        .filter((r) => r.some((v) => v !== ""))
        .map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i]])));
    },
    sheet: (name) => world.ss.getSheetByName(name),
    async login(login, password = "pass1234", name) {
      const res = rawCall({ action: "login", login, password, name });
      if (!res.ok) throw new Error("login failed: " + res.error);
      return res;
    }
  };
}
