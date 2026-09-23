/**
 * Tasking — бэкенд на Google Apps Script поверх Google Таблицы.
 *
 * Разворачивается как Web App (Deploy → New deployment → Web app,
 * Execute as: Me, Who has access: Anyone). Фронтенд стучится в /exec URL
 * через fetch(POST), Content-Type: text/plain, чтобы браузер не слал
 * CORS-preflight (Apps Script его не поддерживает).
 *
 * После вставки новой версии кода: один раз запустите функцию setup в
 * редакторе (выпадающий список функций → setup → Run) — Google спросит
 * разрешения (Таблица, Диск для файлов в чате, Почта для уведомлений),
 * их нужно подтвердить. Недостающие листы и столбцы сервер дальше
 * добавляет сам при первом обращении, руками править шапки не нужно.
 *
 * Регистрация: по умолчанию первый вход с новым логином создаёт аккаунт.
 * Администратор может закрыть регистрацию в панели «Пользователи» — тогда
 * новых людей заводит только он сам.
 *
 * Модель прав:
 *  - Любой залогиненный может создать проект, а задачу — в проекте, к
 *    которому у него есть доступ.
 *  - Редактировать/удалять проект, раздел или задачу может только тот,
 *    кто их создал (creatorId).
 *  - Исполнитель и наблюдатели задачи могут отметить её выполненной и
 *    писать в описание (ASSIGNEE_EDITABLE_TASK_FIELDS).
 *  - Согласующие (approvers) видят задачу и ставят своё решение через
 *    decideApproval, остальные поля им недоступны.
 *  - Участник проекта (project.members) видит весь проект целиком.
 *  - Администратор (Users.isAdmin = TRUE) видит и редактирует всё.
 *    Назначить администратора можно только вручную в самой таблице.
 */

var SHEET_USERS = 'Users';
var SHEET_SESSIONS = 'Sessions';
var SHEET_PROJECTS = 'Projects';
var SHEET_SECTIONS = 'Sections';
var SHEET_TASKS = 'Tasks';
var SHEET_VIEWS = 'Views';
var SHEET_COMMENTS = 'Comments';
var SHEET_EVENTS = 'Events';

var SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней
var MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 МБ
var MAX_LOGIN_FAILS = 5;
var LOGIN_FAIL_WINDOW_SEC = 15 * 60;
var PASSWORD_ROUNDS = 200;
var SOFT_DELETE_KEEP_MS = 60 * 24 * 60 * 60 * 1000; // корзина на сервере хранится 60 дней
var EVENTS_KEEP_MS = 120 * 24 * 60 * 60 * 1000;
var DEFAULT_COLOR = '#6d5dfc';
var DEFAULT_APP_URL = 'https://gish4ik1985-crypto.github.io/tasking/';

// Новые столбцы добавляются только В КОНЕЦ списков — сервер дописывает
// недостающие заголовки к существующим листам сам (см. tableOf).
var SCHEMAS = {};
SCHEMAS[SHEET_USERS] = ['id', 'login', 'passwordHash', 'name', 'color', 'weeklyHours', 'visibleViews', 'isAdmin',
  'email', 'notifyEmail', 'inboxReadAt'];
SCHEMAS[SHEET_SESSIONS] = ['token', 'userId', 'expiresAt'];
SCHEMAS[SHEET_PROJECTS] = ['id', 'name', 'color', 'parentId', 'creatorId', 'members', 'archived', 'createdAt', 'updatedAt'];
SCHEMAS[SHEET_SECTIONS] = ['id', 'projectId', 'name', 'order'];
SCHEMAS[SHEET_TASKS] = ['id', 'projectId', 'sectionId', 'parentTaskId', 'title', 'description', 'assigneeId', 'creatorId', 'watchers',
  'priority', 'completed', 'startDate', 'dueDate', 'datesAuto', 'estimateHours', 'order', 'tags', 'dependencies', 'archived',
  'createdAt', 'updatedAt', 'updatedBy', 'deletedAt', 'recurrence', 'milestone', 'approvers', 'approvals'];
SCHEMAS[SHEET_VIEWS] = ['userId', 'taskId', 'viewedAt'];
SCHEMAS[SHEET_COMMENTS] = ['id', 'taskId', 'authorId', 'text', 'fileName', 'fileMimeType', 'fileSize', 'fileId', 'fileUrl', 'createdAt',
  'mentions'];
SCHEMAS[SHEET_EVENTS] = ['id', 'ts', 'actorId', 'taskId', 'projectId', 'type', 'data', 'recipients'];

// Google Таблица превращает строки вида "2026-09-23" в даты — у этих
// столбцов ставим текстовый формат, а при чтении на всякий случай
// переводим объекты Date обратно в "ГГГГ-ММ-ДД" (см. normalizeCell).
var DATE_COLUMNS = {};
DATE_COLUMNS[SHEET_TASKS] = ['startDate', 'dueDate'];

var ASSIGNEE_EDITABLE_TASK_FIELDS = ['completed', 'description'];
var ALL_VIEWS = ['board', 'list', 'tree', 'structure', 'gantt', 'calendar'];

// Что умеет эта версия сервера — клиент по этому списку решает, какими
// путями пользоваться (и продолжает работать со старым сервером).
var FEATURES = ['batch', 'softDelete', 'purge', 'revision', 'usersInState', 'logout', 'events', 'approvals',
  'recurrence', 'milestone', 'email', 'mentions', 'adminUsers'];

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SCHEMAS).forEach(function (name) {
    var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
    var existing = sheet.getLastColumn() ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String) : [];
    var headers = existing.filter(function (h) { return h; });
    SCHEMAS[name].forEach(function (h) { if (headers.indexOf(h) === -1) headers.push(h); });
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    applyTextFormat(sheet, name, headers);
  });
  var defaultSheet = ss.getSheetByName('Sheet1') || ss.getSheetByName('Лист1');
  if (defaultSheet && defaultSheet.getLastRow() === 0) ss.deleteSheet(defaultSheet);
  // Эти вызовы ничего не меняют — они нужны, чтобы Google сразу спросил
  // разрешения на Диск и Почту при запуске setup, а не молча падал потом.
  try { DriveApp.getRootFolder(); } catch (e) { /* нет доступа — файлы в чате не будут работать */ }
  try { MailApp.getRemainingDailyQuota(); } catch (e) { /* нет доступа — письма не будут уходить */ }
}

function applyTextFormat(sheet, name, headers) {
  (DATE_COLUMNS[name] || []).forEach(function (col) {
    var idx = headers.indexOf(col);
    if (idx !== -1) sheet.getRange(1, idx + 1, Math.max(sheet.getMaxRows ? sheet.getMaxRows() : 1000, 1000), 1).setNumberFormat('@');
  });
}

function sha256(text) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return digest.map(function (b) { return (b < 0 ? b + 256 : b).toString(16).padStart(2, '0'); }).join('');
}

function doGet(e) {
  return ContentService.createTextOutput('Tasking API работает. Обращения принимаются через POST.')
    .setMimeType(ContentService.MimeType.TEXT);
}

// Действия, которые меняют таблицу, выполняются строго по одному (общая
// блокировка): Apps Script не изолирует параллельные запуски, и без неё два
// одновременных сохранения одной ещё не существующей записи дописывали две
// строки с одним id, а удаление строк сдвигало позиции чужой записи.
// markViewed сюда не входит: он только дописывает/обновляет строку в
// Views, где строки никогда не удаляются, а открытие задачи не должно
// стоять в одной очереди с сохранениями всех пользователей.
var WRITE_ACTIONS = ['login', 'logout', 'updateProfile', 'createStarterProject', 'saveProject', 'saveSection', 'saveTask',
  'deleteTask', 'deleteProject', 'deleteSection', 'adminUpdateUser', 'adminDeleteUser', 'adminCreateUser', 'adminSettings',
  'saveComment', 'deleteComment', 'saveBatch', 'purgeTasks', 'decideApproval', 'resetApprovals', 'markInboxRead'];

// После этих действий данные у других пользователей не меняются — номер
// ревизии (по нему клиенты понимают, что пора перечитать состояние) не трогаем.
var NO_REVISION_ACTIONS = ['logout', 'markInboxRead', 'adminSettings'];

function doPost(e) {
  resetExecutionCache();
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) { /* пустое тело */ }
  var result;
  var needsLock = WRITE_ACTIONS.indexOf(body.action) !== -1;
  var lock = needsLock ? LockService.getScriptLock() : null;
  try {
    if (lock) lock.waitLock(20000);
    result = route(body.action, body);
    if (needsLock && result && result.ok && NO_REVISION_ACTIONS.indexOf(body.action) === -1) bumpRevision();
  } catch (err) {
    result = { ok: false, error: String(err && err.message ? err.message : err) };
  } finally {
    if (lock) lock.releaseLock();
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

function route(action, body) {
  if (action === 'login') return handleLogin(body);
  var session = requireSession(body.token);
  if (!session) return { ok: false, error: 'unauthorized' };
  var userId = session.userId;
  switch (action) {
    case 'whoAmI': return handleWhoAmI(userId);
    case 'logout': return handleLogout(body.token);
    case 'updateProfile': return handleUpdateProfile(userId, body.profile);
    case 'listUsers': return handleListUsers(userId);
    case 'getState': return handleGetState(userId, body);
    case 'createStarterProject': return handleCreateStarterProject(userId);
    case 'saveProject': return handleSaveProject(userId, body.project);
    case 'saveSection': return handleSaveSection(userId, body.section);
    case 'saveTask': return handleSaveTask(userId, body.task);
    case 'deleteTask': return handleDeleteTask(userId, body.taskId);
    case 'deleteProject': return handleDeleteProject(userId, body.projectId);
    case 'deleteSection': return handleDeleteSection(userId, body.sectionId);
    case 'saveBatch': return handleSaveBatch(userId, body);
    case 'purgeTasks': return handlePurgeTasks(userId, body.taskIds);
    case 'markViewed': return handleMarkViewed(userId, body.taskId);
    case 'getComments': return handleGetComments(userId, body.taskId);
    case 'saveComment': return handleSaveComment(userId, body);
    case 'deleteComment': return handleDeleteComment(userId, body.commentId);
    case 'decideApproval': return handleDecideApproval(userId, body);
    case 'resetApprovals': return handleResetApprovals(userId, body.taskId);
    case 'getInbox': return handleGetInbox(userId);
    case 'markInboxRead': return handleMarkInboxRead(userId);
    case 'adminUpdateUser': return handleAdminUpdateUser(userId, body.targetUserId, body.patch);
    case 'adminDeleteUser': return handleAdminDeleteUser(userId, body.targetUserId);
    case 'adminCreateUser': return handleAdminCreateUser(userId, body);
    case 'adminSettings': return handleAdminSettings(userId, body.patch);
    default: return { ok: false, error: 'unknown action' };
  }
}

// ---------- Мелкие помощники ----------

function isTrue(v) {
  return v === true || v === 'TRUE' || v === 'true';
}

function sanitizeColor(value, fallback) {
  var s = String(value == null ? '' : value).trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) || /^#[0-9a-fA-F]{3}$/.test(s) ? s : (fallback || DEFAULT_COLOR);
}

function sanitizeEmail(value) {
  var s = String(value == null ? '' : value).trim();
  return /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(s) ? s : '';
}

function uniq(arr) {
  var seen = {};
  return arr.filter(function (v) {
    if (v === undefined || v === null || v === '' || seen[v]) return false;
    seen[v] = true;
    return true;
  });
}

// Если fallback — массив (tags/dependencies/members/watchers/approvers), а
// разобранное значение не массив (пустая ячейка нового столбца, мусор) —
// возвращаем fallback, а не что попало.
function safeJson(str, fallback) {
  try {
    var parsed = str ? JSON.parse(str) : fallback;
    if (Array.isArray(fallback) && !Array.isArray(parsed)) return fallback;
    return parsed;
  } catch (e) {
    return fallback;
  }
}

function safeObj(str) {
  var parsed = safeJson(str, null);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function appUrl() {
  return PropertiesService.getScriptProperties().getProperty('APP_URL') || DEFAULT_APP_URL;
}

// Номер ревизии данных — меняется после каждой записи. Клиент присылает
// последний известный, и если он не изменился, getState отвечает коротким
// "ничего нового", не читая листы проектов и задач. Хранится в кэше: если
// кэш сбросится, клиенты просто один раз перечитают всё целиком.
function currentRevision() {
  var cache = CacheService.getScriptCache();
  var rev = cache.get('REVISION');
  if (!rev) {
    rev = String(Date.now());
    cache.put('REVISION', rev, 21600);
  }
  return rev;
}

function bumpRevision() {
  CacheService.getScriptCache().put('REVISION', String(Date.now()) + '-' + Math.floor(Math.random() * 1e6), 21600);
}

// ---------- Пароли и сессии ----------

function hashPassword(password) {
  var salt = Utilities.getUuid().replace(/-/g, '').slice(0, 16);
  return 's1$' + salt + '$' + stretch(salt, password);
}

function stretch(salt, password) {
  var h = sha256(salt + ':' + password);
  for (var i = 1; i < PASSWORD_ROUNDS; i++) h = sha256(h + salt);
  return h;
}

function isSaltedHash(stored) {
  return String(stored || '').indexOf('s1$') === 0;
}

function verifyPassword(stored, password) {
  stored = String(stored || '');
  if (isSaltedHash(stored)) {
    var parts = stored.split('$');
    return parts.length === 3 && stretch(parts[1], password) === parts[2];
  }
  return stored === sha256(password);
}

function sessionKey(token) {
  return 'h:' + sha256(token);
}

function requireSession(token) {
  if (!token) return null;
  var key = sessionKey(token);
  var session = readRows(SHEET_SESSIONS).find(function (s) { return s.token === key || s.token === token; });
  if (!session) return null;
  if (Number(session.expiresAt) < Date.now()) return null;
  return session;
}

function isRegistrationOpen() {
  return PropertiesService.getScriptProperties().getProperty('REGISTRATION_OPEN') !== 'false';
}

function handleLogin(body) {
  var login = String(body.login || '').trim().toLowerCase();
  var password = String(body.password || '');
  var name = String(body.name || '').trim() || login;
  if (!login || !password) return { ok: false, error: 'Введите логин и пароль' };

  var cache = CacheService.getScriptCache();
  var failKey = 'loginfail:' + login;
  var fails = Number(cache.get(failKey) || 0);
  if (fails >= MAX_LOGIN_FAILS) return { ok: false, error: 'Слишком много неудачных попыток входа. Подождите 15 минут и попробуйте снова.' };

  var users = readRows(SHEET_USERS);
  var user = users.find(function (u) { return String(u.login).trim().toLowerCase() === login; });

  if (!user) {
    if (users.length && !isRegistrationOpen()) {
      return { ok: false, error: 'Регистрация закрыта. Попросите администратора создать вам аккаунт.' };
    }
    var palette = ['#6d5dfc', '#2fb380', '#e0a63a', '#e2554a', '#3aa0e0', '#c957c9'];
    user = {
      id: Utilities.getUuid(), login: login, passwordHash: hashPassword(password), name: name,
      color: palette[users.length % palette.length], weeklyHours: 40
    };
    appendRow(SHEET_USERS, user);
  } else if (!verifyPassword(user.passwordHash, password)) {
    cache.put(failKey, String(fails + 1), LOGIN_FAIL_WINDOW_SEC);
    return { ok: false, error: 'Неверный пароль' };
  } else if (!isSaltedHash(user.passwordHash)) {
    // Старый хеш без соли — при удачном входе тихо переводим на новый.
    upsertRow(SHEET_USERS, { id: user.id, passwordHash: hashPassword(password) });
  }
  cache.remove(failKey);

  var token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  appendRow(SHEET_SESSIONS, { token: sessionKey(token), userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS });
  maybeDailyCleanup();
  return { ok: true, token: token, user: publicUser(user, true) };
}

function handleLogout(token) {
  var key = sessionKey(token);
  deleteRowsWhere(SHEET_SESSIONS, function (r) { return r.token === key || r.token === token; });
  return { ok: true };
}

// Раз в сутки (при чьём-нибудь входе) убирает мусор: просроченные сессии,
// задачи, пролежавшие в корзине дольше 60 дней, и старые события ленты.
function maybeDailyCleanup() {
  var props = PropertiesService.getScriptProperties();
  var last = Number(props.getProperty('LAST_CLEANUP') || 0);
  var now = Date.now();
  if (now - last < 24 * 60 * 60 * 1000) return;
  props.setProperty('LAST_CLEANUP', String(now));
  deleteRowsWhere(SHEET_SESSIONS, function (r) { return Number(r.expiresAt) < now; });
  var stale = {};
  readRows(SHEET_TASKS).forEach(function (t) {
    if (t.deletedAt && now - Number(t.deletedAt) > SOFT_DELETE_KEEP_MS) stale[t.id] = true;
  });
  if (Object.keys(stale).length) {
    deleteRowsWhere(SHEET_TASKS, function (r) { return !!stale[r.id]; });
    deleteCommentsForTasks(stale);
  }
  deleteRowsWhere(SHEET_EVENTS, function (r) { return now - Number(r.ts) > EVENTS_KEEP_MS; });
}

// ---------- Пользователи ----------

function parseViews(raw) {
  var parsed = safeJson(raw, null);
  var list;
  // Старый формат — просто массив, сохранённый до появления вида
  // «Календарь»: считаем, что его не скрывали.
  if (Array.isArray(parsed)) list = parsed.concat(['calendar']);
  else if (parsed && Array.isArray(parsed.views)) list = parsed.views;
  else list = ALL_VIEWS.slice();
  list = uniq(list.filter(function (v) { return ALL_VIEWS.indexOf(v) !== -1; }));
  return list.length ? list : ALL_VIEWS.slice();
}

// withPrivate — логин и почта: только самому пользователю и админу. Логины
// других людей — половина данных для входа, раздавать их всем незачем.
function publicUser(user, withPrivate) {
  var out = {
    id: user.id, name: user.name, color: sanitizeColor(user.color),
    weeklyHours: user.weeklyHours === '' || user.weeklyHours === undefined ? 40 : Number(user.weeklyHours),
    visibleViews: parseViews(user.visibleViews), isAdmin: isTrue(user.isAdmin)
  };
  if (withPrivate) {
    out.login = user.login;
    out.email = user.email || '';
    out.notifyEmail = isTrue(user.notifyEmail);
  }
  return out;
}

function isUserAdmin(userId) {
  var user = findRow(SHEET_USERS, userId);
  return !!(user && isTrue(user.isAdmin));
}

function usersFor(viewerId) {
  var admin = isUserAdmin(viewerId);
  return readRows(SHEET_USERS).map(function (u) { return publicUser(u, admin || u.id === viewerId); });
}

function handleWhoAmI(userId) {
  var user = findRow(SHEET_USERS, userId);
  if (!user) return { ok: false, error: 'Пользователь не найден' };
  return { ok: true, user: publicUser(user, true), features: FEATURES };
}

function handleUpdateProfile(userId, profile) {
  if (!profile) return { ok: false, error: 'нет profile' };
  var user = findRow(SHEET_USERS, userId);
  if (!user) return { ok: false, error: 'Пользователь не найден' };
  var patch = { id: userId };
  if (typeof profile.name === 'string' && profile.name.trim()) patch.name = profile.name.trim().slice(0, 100);
  if (typeof profile.color === 'string') patch.color = sanitizeColor(profile.color, sanitizeColor(user.color));
  if (profile.weeklyHours !== undefined && profile.weeklyHours !== '') patch.weeklyHours = Number(profile.weeklyHours) || 0;
  if (Array.isArray(profile.visibleViews)) {
    var filtered = uniq(profile.visibleViews.filter(function (v) { return ALL_VIEWS.indexOf(v) !== -1; }));
    if (filtered.length) patch.visibleViews = JSON.stringify({ v: 2, views: filtered });
  }
  if (profile.email !== undefined) patch.email = sanitizeEmail(profile.email);
  if (profile.notifyEmail !== undefined) patch.notifyEmail = !!profile.notifyEmail;
  upsertRow(SHEET_USERS, patch);
  return { ok: true, user: publicUser(Object.assign({}, user, patch), true) };
}

function handleListUsers(userId) {
  return { ok: true, users: usersFor(userId) };
}

// ---------- Администрирование (только Users.isAdmin = TRUE) ----------

function handleAdminUpdateUser(userId, targetUserId, patch) {
  if (!isUserAdmin(userId)) return { ok: false, error: 'Только администратор может это делать' };
  if (!targetUserId) return { ok: false, error: 'нет targetUserId' };
  var target = findRow(SHEET_USERS, targetUserId);
  if (!target) return { ok: false, error: 'Пользователь не найден' };
  var p = { id: targetUserId };
  if (patch && typeof patch.name === 'string' && patch.name.trim()) p.name = patch.name.trim().slice(0, 100);
  if (patch && typeof patch.color === 'string' && patch.color) p.color = sanitizeColor(patch.color, sanitizeColor(target.color));
  if (patch && typeof patch.newPassword === 'string' && patch.newPassword) {
    p.passwordHash = hashPassword(patch.newPassword);
    // Смена пароля выкидывает человека со всех устройств — иначе украденный
    // токен продолжал бы работать ещё до 30 дней.
    deleteRowsWhere(SHEET_SESSIONS, function (r) { return r.userId === targetUserId; });
  }
  upsertRow(SHEET_USERS, p);
  return { ok: true, user: publicUser(Object.assign({}, target, p), true) };
}

function handleAdminDeleteUser(userId, targetUserId) {
  if (!isUserAdmin(userId)) return { ok: false, error: 'Только администратор может это делать' };
  if (!targetUserId) return { ok: false, error: 'нет targetUserId' };
  if (targetUserId === userId) return { ok: false, error: 'Нельзя удалить самого себя' };
  // Задачи/проекты удалённого человека НЕ удаляются и НЕ переназначаются —
  // осознанно, чтобы вместе с аккаунтом случайно не снести чужую работу.
  deleteRow(SHEET_USERS, targetUserId);
  deleteRowsWhere(SHEET_SESSIONS, function (r) { return r.userId === targetUserId; });
  return { ok: true };
}

function handleAdminCreateUser(userId, body) {
  if (!isUserAdmin(userId)) return { ok: false, error: 'Только администратор может это делать' };
  var login = String(body.login || '').trim().toLowerCase();
  var password = String(body.password || '');
  var name = String(body.name || '').trim() || login;
  if (!login || !password) return { ok: false, error: 'Укажите логин и пароль' };
  var users = readRows(SHEET_USERS);
  if (users.some(function (u) { return String(u.login).trim().toLowerCase() === login; })) {
    return { ok: false, error: 'Такой логин уже есть' };
  }
  var palette = ['#6d5dfc', '#2fb380', '#e0a63a', '#e2554a', '#3aa0e0', '#c957c9'];
  var user = {
    id: Utilities.getUuid(), login: login, passwordHash: hashPassword(password), name: name.slice(0, 100),
    color: palette[users.length % palette.length], weeklyHours: 40
  };
  appendRow(SHEET_USERS, user);
  return { ok: true, user: publicUser(user, true) };
}

function handleAdminSettings(userId, patch) {
  if (!isUserAdmin(userId)) return { ok: false, error: 'Только администратор может это делать' };
  var props = PropertiesService.getScriptProperties();
  if (patch && typeof patch.registrationOpen === 'boolean') {
    props.setProperty('REGISTRATION_OPEN', patch.registrationOpen ? 'true' : 'false');
  }
  if (patch && typeof patch.appUrl === 'string' && /^https:\/\//.test(patch.appUrl)) {
    props.setProperty('APP_URL', patch.appUrl);
  }
  return { ok: true, settings: { registrationOpen: isRegistrationOpen(), appUrl: appUrl() } };
}

// ---------- Доступ ----------

function canAccessTask(userId, task) {
  if (isUserAdmin(userId)) return true;
  if (task.creatorId === userId || task.assigneeId === userId) return true;
  if (safeJson(task.watchers, []).indexOf(userId) !== -1) return true;
  if (safeJson(task.approvers, []).indexOf(userId) !== -1) return true;
  var project = findRow(SHEET_PROJECTS, task.projectId);
  if (project && (project.creatorId === userId || safeJson(project.members, []).indexOf(userId) !== -1)) return true;
  return false;
}

// Можно ли создавать задачи в проекте (или переносить их туда): автор,
// участник, админ — или человек, которому в этом проекте уже что-то
// назначено (он видит проект и может, например, добавить подзадачу).
// Несуществующий проект не отклоняем: старые вкладки шлют новый проект и
// его задачи параллельно, и задача может прийти раньше самого проекта.
// Защита нужна от подброса задач в ЧУЖОЙ существующий проект.
function canUseProject(userId, projectId) {
  var project = findRow(SHEET_PROJECTS, projectId);
  if (!project) return true;
  if (project.creatorId === userId || safeJson(project.members, []).indexOf(userId) !== -1) return true;
  if (isUserAdmin(userId)) return true;
  return readRows(SHEET_TASKS).some(function (t) {
    if (t.projectId !== projectId || t.deletedAt) return false;
    return t.creatorId === userId || t.assigneeId === userId ||
      safeJson(t.watchers, []).indexOf(userId) !== -1 || safeJson(t.approvers, []).indexOf(userId) !== -1;
  });
}

// ---------- State ----------

function dedupeById(rows) {
  var seen = {};
  return rows.filter(function (r) {
    if (seen[r.id]) return false;
    seen[r.id] = true;
    return true;
  });
}

function taskOut(t, userId, viewedMap, canEdit, canComplete) {
  var viewedAt = viewedMap[t.id];
  var changedByOther = String(t.updatedBy || '') !== userId;
  return Object.assign({}, t, {
    tags: safeJson(t.tags, []),
    dependencies: safeJson(t.dependencies, []),
    watchers: safeJson(t.watchers, []),
    approvers: safeJson(t.approvers, []),
    approvals: safeObj(t.approvals),
    completed: isTrue(t.completed),
    milestone: isTrue(t.milestone),
    recurrence: String(t.recurrence || ''),
    canEdit: canEdit,
    canComplete: canComplete,
    isUnread: !viewedAt,
    isChanged: !!viewedAt && Number(t.updatedAt) > viewedAt && changedByOther
  });
}

function viewedMapFor(userId) {
  var map = {};
  readRows(SHEET_VIEWS).forEach(function (v) {
    if (v.userId === userId) map[v.taskId] = Math.max(map[v.taskId] || 0, Number(v.viewedAt) || 0);
  });
  return map;
}

function inboxUnreadCount(userId) {
  var user = findRow(SHEET_USERS, userId);
  var readAt = Number(user && user.inboxReadAt) || 0;
  return readRows(SHEET_EVENTS).filter(function (ev) {
    return Number(ev.ts) > readAt && safeJson(ev.recipients, []).indexOf(userId) !== -1;
  }).length;
}

function handleGetState(userId, body) {
  var revision = currentRevision();
  if (body && body.sinceRevision && body.sinceRevision === revision) {
    return { ok: true, unchanged: true, revision: revision };
  }
  var extra = { revision: revision, features: FEATURES, users: usersFor(userId), inboxUnread: inboxUnreadCount(userId), serverTime: Date.now() };

  var allProjects = dedupeById(readRows(SHEET_PROJECTS));
  var allSections = dedupeById(readRows(SHEET_SECTIONS));
  var allTasks = dedupeById(readRows(SHEET_TASKS)).filter(function (t) { return !t.deletedAt; });
  var viewedMap = viewedMapFor(userId);

  if (isUserAdmin(userId)) {
    return Object.assign({
      ok: true,
      projects: allProjects.map(function (p) { return Object.assign({}, p, { color: sanitizeColor(p.color), members: safeJson(p.members, []), canEdit: true }); }),
      sections: allSections.map(function (s) { return Object.assign({}, s, { canEdit: true }); }),
      tasks: allTasks.map(function (t) { return taskOut(t, userId, viewedMap, true, true); })
    }, extra);
  }

  var memberProjectIds = {};
  allProjects.forEach(function (p) {
    if (p.creatorId === userId || safeJson(p.members, []).indexOf(userId) !== -1) memberProjectIds[p.id] = true;
  });

  var visibleTasks = allTasks.filter(function (t) {
    if (t.creatorId === userId || t.assigneeId === userId) return true;
    if (safeJson(t.watchers, []).indexOf(userId) !== -1) return true;
    if (safeJson(t.approvers, []).indexOf(userId) !== -1) return true;
    return !!memberProjectIds[t.projectId];
  });

  // Видна задача — видны все её подзадачи; видна подзадача — видна вся
  // цепочка родителей (иначе в древовидных видах её не к чему подвесить).
  var taskById = {};
  allTasks.forEach(function (t) { taskById[t.id] = t; });
  var visibleTaskIds = {};
  visibleTasks.forEach(function (t) { visibleTaskIds[t.id] = true; });
  var addedMore = true;
  while (addedMore) {
    addedMore = false;
    allTasks.forEach(function (t) {
      if (!visibleTaskIds[t.id] && t.parentTaskId && visibleTaskIds[t.parentTaskId]) {
        visibleTaskIds[t.id] = true;
        addedMore = true;
      }
    });
    Object.keys(visibleTaskIds).forEach(function (id) {
      var t = taskById[id];
      if (t && t.parentTaskId && taskById[t.parentTaskId] && !visibleTaskIds[t.parentTaskId]) {
        visibleTaskIds[t.parentTaskId] = true;
        addedMore = true;
      }
    });
  }
  visibleTasks = allTasks.filter(function (t) { return visibleTaskIds[t.id]; });

  var refProjectIds = uniq(visibleTasks.map(function (t) { return t.projectId; }));
  var refSectionIds = uniq(visibleTasks.map(function (t) { return t.sectionId; }));

  var projectsById = {};
  allProjects.forEach(function (p) {
    var isOwn = p.creatorId === userId;
    if (isOwn || memberProjectIds[p.id] || refProjectIds.indexOf(p.id) !== -1) {
      projectsById[p.id] = Object.assign({}, p, { color: sanitizeColor(p.color), members: safeJson(p.members, []), canEdit: isOwn });
    }
  });

  var sectionsById = {};
  allSections.forEach(function (s) {
    var parentProject = projectsById[s.projectId];
    if (!parentProject) return;
    if (parentProject.canEdit || memberProjectIds[s.projectId] || refSectionIds.indexOf(s.id) !== -1) {
      sectionsById[s.id] = Object.assign({}, s, { canEdit: !!parentProject.canEdit });
    }
  });

  var tasks = visibleTasks.map(function (t) {
    var isOwn = t.creatorId === userId;
    var isWatcher = safeJson(t.watchers, []).indexOf(userId) !== -1;
    return taskOut(t, userId, viewedMap, isOwn, isOwn || t.assigneeId === userId || isWatcher);
  });

  return Object.assign({
    ok: true,
    projects: Object.values(projectsById),
    sections: Object.values(sectionsById),
    tasks: tasks
  }, extra);
}

// ---------- Запись (с проверкой прав) ----------

// Создаёт пустой стартовый проект с тремя разделами одним запросом.
// Идемпотентно: если у пользователя уже есть свой проект, отдаёт его, а
// не плодит ещё одну «Мои задачи» (getState мог мимолётно вернуть пустоту).
function handleCreateStarterProject(userId) {
  var existingProject = readRows(SHEET_PROJECTS).find(function (p) { return p.creatorId === userId; });
  if (existingProject) {
    var existingSections = readRows(SHEET_SECTIONS).filter(function (s) { return s.projectId === existingProject.id; });
    return { ok: true, project: existingProject, sections: existingSections };
  }

  var project = { id: Utilities.getUuid(), name: 'Мои задачи', creatorId: userId, updatedAt: Date.now(), color: DEFAULT_COLOR };
  project.createdAt = project.updatedAt;
  upsertRow(SHEET_PROJECTS, project);

  var sectionNames = ['К выполнению', 'В работе', 'Готово'];
  var sections = sectionNames.map(function (name, i) {
    var section = { id: Utilities.getUuid(), projectId: project.id, name: name, order: i };
    upsertRow(SHEET_SECTIONS, section);
    return section;
  });

  return { ok: true, project: project, sections: sections };
}

function handleSaveProject(userId, project) {
  if (!project) return { ok: false, error: 'нет project', permanent: true };
  if (project.color !== undefined) project.color = sanitizeColor(project.color);
  // "Создать или обновить" решаем по наличию строки, а не по тому, прислал
  // ли клиент id — клиент сам генерирует id новым проектам.
  var existing = project.id ? findRow(SHEET_PROJECTS, project.id) : null;
  if (existing) {
    if (existing.creatorId !== userId && !isUserAdmin(userId)) return { ok: false, error: 'Редактировать может только автор проекта', permanent: true };
    var merged = Object.assign({}, existing, project, { creatorId: existing.creatorId, updatedAt: Date.now() });
    merged.members = JSON.stringify(project.members !== undefined ? project.members : safeJson(existing.members, []));
    // Проект не может стать предком самого себя — иначе дерево зацикливается.
    if (merged.parentId) {
      var all = readRows(SHEET_PROJECTS);
      var cursor = merged.parentId;
      var guard = 0;
      while (cursor && guard < 1000) {
        if (cursor === merged.id) return { ok: false, error: 'Нельзя вложить проект сам в себя', permanent: true };
        var parentRow = all.find(function (r) { return r.id === cursor; });
        cursor = parentRow ? parentRow.parentId : null;
        guard++;
      }
    }
    upsertRow(SHEET_PROJECTS, merged);
    return { ok: true, project: Object.assign({}, merged, { members: safeJson(merged.members, []) }) };
  }
  if (!project.name) return { ok: false, error: 'Проект не найден', permanent: true };
  project.id = project.id || Utilities.getUuid();
  project.creatorId = userId;
  project.updatedAt = Date.now();
  project.createdAt = project.updatedAt;
  project.color = sanitizeColor(project.color);
  var membersList = project.members || [];
  project.members = JSON.stringify(membersList);
  upsertRow(SHEET_PROJECTS, project);
  return { ok: true, project: Object.assign({}, project, { members: membersList }) };
}

function handleSaveSection(userId, section) {
  if (!section || !section.projectId) return { ok: false, error: 'нет section/projectId', permanent: true };
  var project = findRow(SHEET_PROJECTS, section.projectId);
  if (!project) return { ok: false, error: 'Проект не найден', permanent: true };
  if (project.creatorId !== userId && !isUserAdmin(userId)) return { ok: false, error: 'Разделы может менять только автор проекта', permanent: true };
  section.id = section.id || Utilities.getUuid();
  upsertRow(SHEET_SECTIONS, section);
  return { ok: true, section: section };
}

function jsonField(task, existing, field) {
  return JSON.stringify(task[field] !== undefined ? task[field] : safeJson(existing ? existing[field] : null, []));
}

function handleSaveTask(userId, task) {
  if (!task) return { ok: false, error: 'нет task', permanent: true };
  // Эти поля клиент никогда не задаёт напрямую.
  delete task.approvals;
  delete task.updatedBy;
  delete task.deletedAt;
  delete task.creatorId;

  var now = Date.now();
  var existing = task.id ? findRow(SHEET_TASKS, task.id) : null;

  if (!existing) {
    // Клиент шлёт только изменённые поля. Если задачи на сервере нет
    // (её удалили насовсем), такое частичное сохранение не должно
    // создавать пустую задачу без названия.
    if (task.title === undefined) return { ok: false, error: 'Задача не найдена', permanent: true };
    if (!task.projectId || !canUseProject(userId, task.projectId)) return { ok: false, error: 'Нет доступа к этому проекту', permanent: true };
    task.id = task.id || Utilities.getUuid();
    task.creatorId = userId;
    task.updatedAt = now;
    task.updatedBy = userId;
    task.createdAt = now;
    task.tags = jsonField(task, null, 'tags');
    task.dependencies = jsonField(task, null, 'dependencies');
    task.watchers = jsonField(task, null, 'watchers');
    task.approvers = jsonField(task, null, 'approvers');
    upsertRow(SHEET_TASKS, task);
    logTaskCreated(userId, task);
    return { ok: true, taskId: task.id };
  }

  var isAdmin = isUserAdmin(userId);
  if (existing.creatorId === userId || isAdmin) {
    if (task.projectId && task.projectId !== existing.projectId && !canUseProject(userId, task.projectId)) {
      return { ok: false, error: 'Нет доступа к этому проекту', permanent: true };
    }
    var merged = Object.assign({}, existing, task, { creatorId: existing.creatorId, id: existing.id, updatedAt: now, updatedBy: userId });
    if (existing.deletedAt) merged.deletedAt = ''; // сохранение удалённой задачи = восстановление из корзины
    merged.tags = jsonField(task, existing, 'tags');
    merged.dependencies = jsonField(task, existing, 'dependencies');
    merged.watchers = jsonField(task, existing, 'watchers');
    merged.approvers = jsonField(task, existing, 'approvers');
    if (task.approvers !== undefined) {
      // Убрали человека из согласующих — убираем и его решение.
      var keep = safeJson(merged.approvers, []);
      var approvals = safeObj(existing.approvals);
      Object.keys(approvals).forEach(function (id) { if (keep.indexOf(id) === -1) delete approvals[id]; });
      merged.approvals = JSON.stringify(approvals);
    }
    upsertRow(SHEET_TASKS, merged);
    logTaskChanges(userId, existing, merged);
    return { ok: true, taskId: merged.id };
  }

  if (existing.deletedAt) return { ok: false, error: 'Задача удалена', permanent: true };

  // Исполнитель или наблюдатель: только «выполнено» и описание.
  var isAssignee = existing.assigneeId === userId;
  var isWatcher = safeJson(existing.watchers, []).indexOf(userId) !== -1;
  if (isAssignee || isWatcher) {
    var patch = { id: existing.id, updatedAt: now, updatedBy: userId };
    ASSIGNEE_EDITABLE_TASK_FIELDS.forEach(function (field) {
      if (task[field] !== undefined) patch[field] = task[field];
    });
    upsertRow(SHEET_TASKS, patch);
    logTaskChanges(userId, existing, Object.assign({}, existing, patch));
    return { ok: true, taskId: existing.id };
  }

  return { ok: false, error: 'Нет прав на редактирование этой задачи', permanent: true };
}

function collectDescendants(allTasks, rootIds) {
  var ids = {};
  rootIds.forEach(function (id) { ids[id] = true; });
  var addedMore = true;
  while (addedMore) {
    addedMore = false;
    allTasks.forEach(function (t) {
      if (!ids[t.id] && t.parentTaskId && ids[t.parentTaskId]) {
        ids[t.id] = true;
        addedMore = true;
      }
    });
  }
  return ids;
}

// Удаление задачи — «мягкое»: строка остаётся с отметкой deletedAt, чат и
// файлы не трогаются. Восстановление из корзины (повторное сохранение
// той же задачи автором) возвращает её как была — с автором и перепиской.
// Насовсем задача стирается только через purgeTasks (очистка корзины) или
// сама через 60 дней (maybeDailyCleanup).
function handleDeleteTask(userId, taskId) {
  if (!taskId) return { ok: false, error: 'нет taskId', permanent: true };
  var existing = findRow(SHEET_TASKS, taskId);
  if (!existing || existing.deletedAt) return { ok: true };
  if (existing.creatorId !== userId && !isUserAdmin(userId)) return { ok: false, error: 'Удалить может только автор задачи', permanent: true };
  var now = Date.now();
  var ids = collectDescendants(readRows(SHEET_TASKS), [taskId]);
  readRows(SHEET_TASKS).forEach(function (t) {
    if (ids[t.id] && !t.deletedAt) upsertRow(SHEET_TASKS, { id: t.id, deletedAt: now, updatedAt: now, updatedBy: userId });
  });
  addEvent(userId, existing, 'deleted', {}, []);
  return { ok: true };
}

function handlePurgeTasks(userId, taskIds) {
  if (!Array.isArray(taskIds) || !taskIds.length) return { ok: true, purged: 0 };
  var admin = isUserAdmin(userId);
  var all = readRows(SHEET_TASKS);
  var allowed = taskIds.filter(function (id) {
    var t = all.find(function (x) { return x.id === id; });
    return t && t.deletedAt && (t.creatorId === userId || admin);
  });
  if (!allowed.length) return { ok: true, purged: 0 };
  var ids = collectDescendants(all, allowed);
  deleteRowsWhere(SHEET_TASKS, function (r) { return !!ids[r.id]; });
  deleteCommentsForTasks(ids);
  return { ok: true, purged: Object.keys(ids).length };
}

// Удаляет строки Comments и файлы в Drive для задач из idsToDelete.
function deleteCommentsForTasks(idsToDelete) {
  readRows(SHEET_COMMENTS).forEach(function (c) {
    if (idsToDelete[c.taskId] && c.fileId) {
      try { DriveApp.getFileById(c.fileId).setTrashed(true); } catch (e) { /* файл уже удалён вручную */ }
    }
  });
  deleteRowsWhere(SHEET_COMMENTS, function (r) { return !!idsToDelete[r.taskId]; });
}

function handleDeleteProject(userId, projectId) {
  if (!projectId) return { ok: false, error: 'нет projectId', permanent: true };
  var existing = findRow(SHEET_PROJECTS, projectId);
  if (!existing) return { ok: true };
  if (existing.creatorId !== userId && !isUserAdmin(userId)) return { ok: false, error: 'Удалить может только автор проекта', permanent: true };
  // Проект удаляется насовсем вместе с разделами, задачами и перепиской —
  // это явное действие с подтверждением в интерфейсе.
  var ids = {};
  readRows(SHEET_TASKS).forEach(function (t) { if (t.projectId === projectId) ids[t.id] = true; });
  deleteRowsWhere(SHEET_SECTIONS, function (r) { return r.projectId === projectId; });
  deleteRowsWhere(SHEET_TASKS, function (r) { return r.projectId === projectId; });
  deleteCommentsForTasks(ids);
  deleteRow(SHEET_PROJECTS, projectId);
  return { ok: true };
}

function handleDeleteSection(userId, sectionId) {
  if (!sectionId) return { ok: false, error: 'нет sectionId', permanent: true };
  var existing = findRow(SHEET_SECTIONS, sectionId);
  if (!existing) return { ok: true };
  var project = findRow(SHEET_PROJECTS, existing.projectId);
  if (!project || (project.creatorId !== userId && !isUserAdmin(userId))) return { ok: false, error: 'Разделы может удалять только автор проекта', permanent: true };
  deleteRow(SHEET_SECTIONS, sectionId);
  return { ok: true };
}

function runSafely(fn) {
  try {
    return fn();
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

// Пакетное сохранение: всё, что клиент накопил, одним запросом, под одной
// блокировкой и с одним чтением каждого листа (см. кэш в tableOf).
// Результат — по каждой записи отдельно, чтобы клиент повторил только
// то, что не прошло.
function handleSaveBatch(userId, body) {
  var results = { projects: {}, sections: {}, tasks: {}, deleteTasks: {}, deleteSections: {}, deleteProjects: {} };
  (body.projects || []).forEach(function (p) { results.projects[p.id] = runSafely(function () { return handleSaveProject(userId, p); }); });
  (body.sections || []).forEach(function (s) { results.sections[s.id] = runSafely(function () { return handleSaveSection(userId, s); }); });
  (body.tasks || []).forEach(function (t) { results.tasks[t.id] = runSafely(function () { return handleSaveTask(userId, t); }); });
  (body.deleteTasks || []).forEach(function (id) { results.deleteTasks[id] = runSafely(function () { return handleDeleteTask(userId, id); }); });
  (body.deleteSections || []).forEach(function (id) { results.deleteSections[id] = runSafely(function () { return handleDeleteSection(userId, id); }); });
  (body.deleteProjects || []).forEach(function (id) { results.deleteProjects[id] = runSafely(function () { return handleDeleteProject(userId, id); }); });
  return { ok: true, results: results };
}

function handleMarkViewed(userId, taskId) {
  if (!taskId) return { ok: false, error: 'нет taskId' };
  var row = { userId: userId, taskId: taskId, viewedAt: Date.now() };
  upsertRowByMatch(SHEET_VIEWS, row, function (r) { return r.userId === userId && r.taskId === taskId; });
  return { ok: true };
}

// ---------- События: лента «Входящие», история задачи, письма ----------

function taskRecipients(task, actorId) {
  var ids = [task.creatorId, task.assigneeId].concat(safeJson(task.watchers, []));
  return uniq(ids).filter(function (id) { return id !== actorId; });
}

var EVENT_TEXT = {
  created: 'создал(а) задачу',
  assigned: 'назначил(а) вам задачу',
  completed: 'отметил(а) задачу выполненной',
  reopened: 'вернул(а) задачу в работу',
  due_changed: 'изменил(а) срок задачи',
  start_changed: 'изменил(а) начало задачи',
  comment: 'написал(а) в задаче',
  mention: 'упомянул(а) вас в задаче',
  approval_requested: 'просит согласовать задачу',
  approval_decision: 'принял(а) решение по согласованию задачи',
  approvals_reset: 'запросил(а) согласование заново по задаче',
  deleted: 'удалил(а) задачу',
  restored: 'восстановил(а) задачу'
};

function addEvent(actorId, task, type, data, recipients) {
  var ev = {
    id: Utilities.getUuid(), ts: Date.now(), actorId: actorId, taskId: task.id, projectId: task.projectId || '',
    type: type, data: JSON.stringify(data || {}), recipients: JSON.stringify(uniq(recipients || []))
  };
  appendRow(SHEET_EVENTS, ev);
  if (recipients && recipients.length) sendEmails(actorId, task, type, data || {}, uniq(recipients));
}

function sendEmails(actorId, task, type, data, recipients) {
  var users = readRows(SHEET_USERS);
  var actor = users.find(function (u) { return u.id === actorId; });
  var targets = users.filter(function (u) {
    return recipients.indexOf(u.id) !== -1 && isTrue(u.notifyEmail) && sanitizeEmail(u.email);
  });
  if (!targets.length) return;
  try {
    if (MailApp.getRemainingDailyQuota() < targets.length) return;
    var who = actor ? actor.name : 'Кто-то';
    var title = String(task.title || 'Без названия');
    var line = who + ' ' + (EVENT_TEXT[type] || 'изменил(а) задачу') + ' «' + title + '»';
    var extraText = data.text ? '\n\n' + String(data.text).slice(0, 1000) : '';
    if (type === 'approval_decision') extraText = '\n\nРешение: ' + (data.decision === 'approved' ? 'согласовано' : 'отклонено') + (data.comment ? ' — ' + data.comment : '');
    var link = appUrl() + '#task/' + task.id;
    targets.forEach(function (u) {
      MailApp.sendEmail({ to: sanitizeEmail(u.email), subject: 'Tasking: ' + line, body: line + extraText + '\n\nОткрыть: ' + link, name: 'Tasking' });
    });
  } catch (e) { /* нет разрешения на почту или кончилась квота — уведомление внутри приложения всё равно есть */ }
}

function logTaskCreated(actorId, task) {
  addEvent(actorId, task, 'created', {}, []);
  if (task.assigneeId && task.assigneeId !== actorId) addEvent(actorId, task, 'assigned', {}, [task.assigneeId]);
  var approvers = safeJson(task.approvers, []).filter(function (id) { return id !== actorId; });
  if (approvers.length) addEvent(actorId, task, 'approval_requested', {}, approvers);
}

function logTaskChanges(actorId, before, after) {
  if (before.deletedAt && !after.deletedAt) addEvent(actorId, after, 'restored', {}, []);
  if (String(after.assigneeId || '') !== String(before.assigneeId || '') && after.assigneeId) {
    addEvent(actorId, after, 'assigned', { from: before.assigneeId || '' }, after.assigneeId !== actorId ? [after.assigneeId] : []);
  }
  if (isTrue(after.completed) !== isTrue(before.completed)) {
    addEvent(actorId, after, isTrue(after.completed) ? 'completed' : 'reopened', {}, taskRecipients(after, actorId));
  }
  if (String(after.dueDate || '') !== String(before.dueDate || '')) {
    addEvent(actorId, after, 'due_changed', { from: String(before.dueDate || ''), to: String(after.dueDate || '') }, taskRecipients(after, actorId));
  }
  if (String(after.startDate || '') !== String(before.startDate || '')) {
    addEvent(actorId, after, 'start_changed', { from: String(before.startDate || ''), to: String(after.startDate || '') }, []);
  }
  var oldApprovers = safeJson(before.approvers, []);
  var added = safeJson(after.approvers, []).filter(function (id) { return oldApprovers.indexOf(id) === -1 && id !== actorId; });
  if (added.length) addEvent(actorId, after, 'approval_requested', {}, added);
}

function handleGetInbox(userId) {
  var user = findRow(SHEET_USERS, userId);
  var readAt = Number(user && user.inboxReadAt) || 0;
  var tasksById = {};
  readRows(SHEET_TASKS).forEach(function (t) { tasksById[t.id] = t; });
  var events = readRows(SHEET_EVENTS)
    .filter(function (ev) { return safeJson(ev.recipients, []).indexOf(userId) !== -1; })
    .sort(function (a, b) { return Number(b.ts) - Number(a.ts); })
    .slice(0, 150)
    .map(function (ev) {
      var t = tasksById[ev.taskId];
      return {
        id: ev.id, ts: Number(ev.ts), actorId: ev.actorId, taskId: ev.taskId, projectId: ev.projectId, type: ev.type,
        data: safeObj(ev.data), taskTitle: t ? t.title : '', taskDeleted: !t || !!t.deletedAt
      };
    });
  return { ok: true, events: events, readAt: readAt };
}

function handleMarkInboxRead(userId) {
  upsertRow(SHEET_USERS, { id: userId, inboxReadAt: Date.now() });
  return { ok: true };
}

// ---------- Согласования ----------

function handleDecideApproval(userId, body) {
  var decision = body.decision;
  if (decision !== 'approved' && decision !== 'rejected') return { ok: false, error: 'Неизвестное решение' };
  var task = body.taskId ? findRow(SHEET_TASKS, body.taskId) : null;
  if (!task || task.deletedAt) return { ok: false, error: 'Задача не найдена' };
  if (safeJson(task.approvers, []).indexOf(userId) === -1) return { ok: false, error: 'Вы не в списке согласующих этой задачи' };
  var approvals = safeObj(task.approvals);
  var comment = String(body.comment || '').trim().slice(0, 1000);
  approvals[userId] = { d: decision, at: Date.now(), c: comment };
  upsertRow(SHEET_TASKS, { id: task.id, approvals: JSON.stringify(approvals), updatedAt: Date.now(), updatedBy: userId });
  var recipients = taskRecipients(task, userId);
  addEvent(userId, task, 'approval_decision', { decision: decision, comment: comment }, recipients);
  return { ok: true, approvals: approvals };
}

function handleResetApprovals(userId, taskId) {
  var task = taskId ? findRow(SHEET_TASKS, taskId) : null;
  if (!task || task.deletedAt) return { ok: false, error: 'Задача не найдена' };
  if (task.creatorId !== userId && !isUserAdmin(userId)) return { ok: false, error: 'Запросить заново может только автор задачи' };
  upsertRow(SHEET_TASKS, { id: task.id, approvals: JSON.stringify({}), updatedAt: Date.now(), updatedBy: userId });
  var approvers = safeJson(task.approvers, []).filter(function (id) { return id !== userId; });
  addEvent(userId, task, 'approvals_reset', {}, approvers);
  return { ok: true, approvals: {} };
}

// ---------- Обсуждение задачи (чат) ----------

function handleGetComments(userId, taskId) {
  var task = taskId ? findRow(SHEET_TASKS, taskId) : null;
  if (!task) return { ok: false, error: 'Задача не найдена' };
  if (!canAccessTask(userId, task)) return { ok: false, error: 'Нет доступа к этой задаче' };
  var comments = readRows(SHEET_COMMENTS)
    .filter(function (c) { return c.taskId === taskId; })
    .map(function (c) { return Object.assign({}, c, { mentions: safeJson(c.mentions, []) }); });
  comments.sort(function (a, b) { return Number(a.createdAt) - Number(b.createdAt); });
  // Системные события («Иван сдвинул срок») показываются в ленте задачи
  // вперемешку с сообщениями; сами сообщения и упоминания уже есть выше.
  var events = readRows(SHEET_EVENTS)
    .filter(function (ev) { return ev.taskId === taskId && ev.type !== 'comment' && ev.type !== 'mention'; })
    .map(function (ev) { return { id: ev.id, ts: Number(ev.ts), actorId: ev.actorId, type: ev.type, data: safeObj(ev.data) }; });
  return { ok: true, comments: comments, events: events };
}

// Папка в Drive для вложений. Доступ «по ссылке» ставится один раз на саму
// папку при её создании — файлы внутри его наследуют.
function getAttachmentsFolder() {
  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty('ATTACHMENTS_FOLDER_ID');
  if (folderId) {
    try { return DriveApp.getFolderById(folderId); } catch (e) { /* папку удалили вручную — создадим заново */ }
  }
  var existing = DriveApp.getFoldersByName('Tasking Attachments');
  var folder;
  if (existing.hasNext()) {
    folder = existing.next();
  } else {
    folder = DriveApp.createFolder('Tasking Attachments');
    folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  }
  props.setProperty('ATTACHMENTS_FOLDER_ID', folder.getId());
  return folder;
}

function handleSaveComment(userId, body) {
  var taskId = body.taskId;
  var task = taskId ? findRow(SHEET_TASKS, taskId) : null;
  if (!task || task.deletedAt) return { ok: false, error: 'Задача не найдена' };
  if (!canAccessTask(userId, task)) return { ok: false, error: 'Нет доступа к этой задаче' };

  var text = String(body.text || '').trim().slice(0, 10000);
  var file = body.file;
  if (!text && !file) return { ok: false, error: 'Пустое сообщение' };

  var mentions = uniq(Array.isArray(body.mentions) ? body.mentions : []).filter(function (id) {
    return id !== userId && findRow(SHEET_USERS, id) && canAccessTask(id, task);
  });
  var comment = {
    id: Utilities.getUuid(), taskId: taskId, authorId: userId, text: text, createdAt: Date.now(),
    mentions: JSON.stringify(mentions)
  };

  if (file && file.dataBase64) {
    var declaredSize = Number(file.size) || 0;
    if (declaredSize > MAX_ATTACHMENT_BYTES) return { ok: false, error: 'Файл слишком большой (максимум 10 МБ)' };
    try {
      var bytes = Utilities.base64Decode(file.dataBase64);
      if (bytes.length > MAX_ATTACHMENT_BYTES) return { ok: false, error: 'Файл слишком большой (максимум 10 МБ)' };
      var blob = Utilities.newBlob(bytes, file.mimeType || 'application/octet-stream', String(file.name || 'file').slice(0, 200));
      var driveFile = getAttachmentsFolder().createFile(blob);
      comment.fileName = String(file.name || driveFile.getName()).slice(0, 200);
      comment.fileMimeType = file.mimeType || blob.getContentType() || '';
      comment.fileSize = bytes.length;
      comment.fileId = driveFile.getId();
      comment.fileUrl = 'https://drive.google.com/uc?id=' + driveFile.getId() + '&export=download';
    } catch (err) {
      return { ok: false, error: 'Не удалось загрузить файл: ' + err };
    }
  }

  appendRow(SHEET_COMMENTS, comment);
  var others = taskRecipients(task, userId).filter(function (id) { return mentions.indexOf(id) === -1; });
  var preview = text || (comment.fileName ? '📎 ' + comment.fileName : '');
  if (others.length) addEvent(userId, task, 'comment', { text: preview }, others);
  if (mentions.length) addEvent(userId, task, 'mention', { text: preview }, mentions);
  return { ok: true, comment: Object.assign({}, comment, { mentions: mentions }) };
}

function handleDeleteComment(userId, commentId) {
  if (!commentId) return { ok: false, error: 'нет commentId' };
  var existing = findRow(SHEET_COMMENTS, commentId);
  if (!existing) return { ok: true };
  if (existing.authorId !== userId && !isUserAdmin(userId)) return { ok: false, error: 'Удалить можно только своё сообщение' };
  if (existing.fileId) {
    try { DriveApp.getFileById(existing.fileId).setTrashed(true); } catch (e) { /* файл уже удалён вручную */ }
  }
  deleteRow(SHEET_COMMENTS, commentId);
  return { ok: true };
}

// ---------- Работа с листами ----------
// Каждый лист читается один раз за запрос (дальше — из кэша EXEC), записи
// сразу обновляют и лист, и кэш. Это делает пакетное сохранение дешёвым:
// 30 задач — одно чтение листа, а не 30.

var EXEC = { tables: {} };

function resetExecutionCache() {
  EXEC = { tables: {} };
}

function getSheet(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    if (!SCHEMAS[name]) throw new Error('Лист ' + name + ' не найден');
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, SCHEMAS[name].length).setValues([SCHEMAS[name]]);
    applyTextFormat(sheet, name, SCHEMAS[name]);
  }
  return sheet;
}

function tableOf(name) {
  var t = EXEC.tables[name];
  if (t) return t;
  var sheet = getSheet(name);
  var values = sheet.getDataRange().getValues();
  var headers = values[0].map(String);
  if (headers.length === 1 && headers[0] === '') headers = [];
  var missing = (SCHEMAS[name] || []).filter(function (h) { return headers.indexOf(h) === -1; });
  if (missing.length) {
    sheet.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
    headers = headers.concat(missing);
    applyTextFormat(sheet, name, headers);
  }
  t = { sheet: sheet, headers: headers, rows: values.slice(1) };
  EXEC.tables[name] = t;
  return t;
}

function normalizeCell(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return isNaN(v.getTime()) ? '' : Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return v;
}

function isEmptyRow(row) {
  return !row.some(function (c) { return c !== '' && c !== null && c !== undefined; });
}

function rowToObj(headers, row) {
  var obj = {};
  headers.forEach(function (h, i) { obj[h] = normalizeCell(row[i] === undefined ? '' : row[i]); });
  return obj;
}

function objToRow(headers, obj) {
  return headers.map(function (h) { return obj[h] !== undefined && obj[h] !== null ? obj[h] : ''; });
}

function readRows(name) {
  var t = tableOf(name);
  return t.rows.filter(function (row) { return !isEmptyRow(row); }).map(function (row) { return rowToObj(t.headers, row); });
}

function findRow(name, id) {
  if (id === undefined || id === null || id === '') return null;
  return readRows(name).find(function (r) { return r.id === id; }) || null;
}

function appendRow(name, obj) {
  var t = tableOf(name);
  var row = objToRow(t.headers, obj);
  t.sheet.appendRow(row);
  t.rows.push(row);
}

function upsertRow(name, obj) {
  upsertRowByMatch(name, obj, function (row) { return row.id === obj.id; });
}

// obj может содержать только часть полей — остальные берутся из строки.
function upsertRowByMatch(name, obj, matchFn) {
  var t = tableOf(name);
  for (var i = 0; i < t.rows.length; i++) {
    if (isEmptyRow(t.rows[i])) continue;
    var current = rowToObj(t.headers, t.rows[i]);
    if (matchFn(current)) {
      var row = objToRow(t.headers, Object.assign(current, obj));
      t.sheet.getRange(i + 2, 1, 1, t.headers.length).setValues([row]);
      t.rows[i] = row;
      return;
    }
  }
  appendRow(name, obj);
}

// Удаляет подходящие строки одной перезаписью листа (а не deleteRow на
// каждую строку, что на большом проекте упиралось в лимит времени).
// Вызывается только из действий под общей блокировкой.
function deleteRowsWhere(name, predicate) {
  var t = tableOf(name);
  var width = t.headers.length;
  t.rows.forEach(function (r) { width = Math.max(width, r.length); });
  var keep = [];
  var removed = 0;
  t.rows.forEach(function (row) {
    if (isEmptyRow(row)) return;
    if (predicate(rowToObj(t.headers, row))) { removed++; return; }
    keep.push(row);
  });
  if (!removed) return 0;
  var oldCount = t.rows.length;
  var padded = keep.map(function (r) {
    var copy = r.slice(0, width);
    while (copy.length < width) copy.push('');
    return copy;
  });
  if (padded.length) t.sheet.getRange(2, 1, padded.length, width).setValues(padded);
  if (oldCount > padded.length) t.sheet.getRange(padded.length + 2, 1, oldCount - padded.length, width).clearContent();
  t.rows = padded;
  return removed;
}

function deleteRow(name, id) {
  deleteRowsWhere(name, function (r) { return r.id === id; });
}
