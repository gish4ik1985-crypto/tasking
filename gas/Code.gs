/**
 * Tasking — бэкенд на Google Apps Script поверх Google Таблицы.
 *
 * Разворачивается как Web App (Deploy → New deployment → Web app,
 * Execute as: Me, Who has access: Anyone). Фронтенд стучится в /exec URL
 * через fetch(POST), Content-Type: text/plain, чтобы браузер не слал
 * CORS-preflight (Apps Script его не поддерживает).
 *
 * Один раз после создания таблицы: открыть этот скрипт в редакторе
 * (Расширения → Apps Script), выбрать функцию setup, нажать Run —
 * создаст листы Users/Sessions/Projects/Sections/Tasks/Views с шапками.
 *
 * Пользователей заводить вручную не нужно: при первом входе с новым
 * логином/паролем аккаунт создаётся автоматически (см. handleLogin).
 * Если кто-то забыл пароль — проще всего удалить его строку в листе
 * Users, тогда при следующем входе он "зарегистрируется" заново.
 *
 * Модель прав:
 *  - Любой залогиненный может создать проект/раздел/задачу.
 *  - Редактировать/удалять проект, раздел или задачу может только тот,
 *    кто их создал (creatorId).
 *  - Исключение: если задача назначена (assigneeId) на другого
 *    пользователя — он не создатель, но может отметить её выполненной и
 *    писать в описание/заметки. Остальные поля (сроки, приоритет,
 *    исполнитель, раздел, теги, зависимости) ему менять нельзя.
 *  - Пользователь видит только те задачи, которые сам создал, или те,
 *    что назначены на него — плюс минимальный контекст (название
 *    проекта/раздела) для этих задач.
 */

var SHEET_USERS = 'Users';
var SHEET_SESSIONS = 'Sessions';
var SHEET_PROJECTS = 'Projects';
var SHEET_SECTIONS = 'Sections';
var SHEET_TASKS = 'Tasks';
var SHEET_VIEWS = 'Views';

var SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней

var SCHEMAS = {};
SCHEMAS[SHEET_USERS] = ['id', 'login', 'passwordHash', 'name', 'color', 'weeklyHours', 'visibleViews'];
SCHEMAS[SHEET_SESSIONS] = ['token', 'userId', 'expiresAt'];
SCHEMAS[SHEET_PROJECTS] = ['id', 'name', 'color', 'parentId', 'creatorId', 'archived', 'createdAt', 'updatedAt'];
SCHEMAS[SHEET_SECTIONS] = ['id', 'projectId', 'name', 'order'];
SCHEMAS[SHEET_TASKS] = ['id', 'projectId', 'sectionId', 'parentTaskId', 'title', 'description', 'assigneeId', 'creatorId',
  'priority', 'completed', 'startDate', 'dueDate', 'datesAuto', 'estimateHours', 'order', 'tags', 'dependencies', 'archived',
  'createdAt', 'updatedAt'];
SCHEMAS[SHEET_VIEWS] = ['userId', 'taskId', 'viewedAt'];

// Поля задачи, которые разрешено менять не-создателю, если задача
// назначена на него (assigneeId === userId).
var ASSIGNEE_EDITABLE_TASK_FIELDS = ['completed', 'description'];

// Вкладки-виды (переключатель Доска/Список/По статусам/Структура/Гант) —
// пользователь сам решает, какие видеть, через профиль (см. handleUpdateProfile).
var ALL_VIEWS = ['board', 'list', 'tree', 'structure', 'gantt'];

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SCHEMAS).forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    var headers = SCHEMAS[name];
    // Шапку перезаписываем всегда (даже если лист не пустой) — так схему
    // можно менять и повторно запускать setup() без ручной правки листов.
    // Сами данные (строки ниже) при этом не трогаются.
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  });
  var defaultSheet = ss.getSheetByName('Sheet1') || ss.getSheetByName('Лист1');
  if (defaultSheet && defaultSheet.getLastRow() === 0) ss.deleteSheet(defaultSheet);
}

function sha256(text) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return digest.map(function (b) { return (b < 0 ? b + 256 : b).toString(16).padStart(2, '0'); }).join('');
}

function doGet(e) {
  return ContentService.createTextOutput('Tasking API работает. Обращения принимаются через POST.')
    .setMimeType(ContentService.MimeType.TEXT);
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) { /* пустое тело */ }
  var result;
  try {
    result = route(body.action, body);
  } catch (err) {
    result = { ok: false, error: String(err) };
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
    case 'updateProfile': return handleUpdateProfile(userId, body.profile);
    case 'listUsers': return handleListUsers();
    case 'getState': return handleGetState(userId);
    case 'createStarterProject': return handleCreateStarterProject(userId);
    case 'saveProject': return handleSaveProject(userId, body.project);
    case 'saveSection': return handleSaveSection(userId, body.section);
    case 'saveTask': return handleSaveTask(userId, body.task);
    case 'deleteTask': return handleDeleteTask(userId, body.taskId);
    case 'deleteProject': return handleDeleteProject(userId, body.projectId);
    case 'deleteSection': return handleDeleteSection(userId, body.sectionId);
    case 'markViewed': return handleMarkViewed(userId, body.taskId);
    default: return { ok: false, error: 'unknown action' };
  }
}

// ---------- Users / sessions ----------

function handleLogin(body) {
  var login = String(body.login || '').trim().toLowerCase();
  var password = String(body.password || '');
  var name = String(body.name || '').trim() || login;
  if (!login || !password) return { ok: false, error: 'Введите логин и пароль' };

  var users = readRows(SHEET_USERS);
  var user = users.find(function (u) { return String(u.login).trim().toLowerCase() === login; });

  if (!user) {
    // Первый вход с этим логином — регистрируем автоматически.
    var palette = ['#6d5dfc', '#2fb380', '#e0a63a', '#e2554a', '#3aa0e0', '#c957c9'];
    var existingCount = users.length;
    user = {
      id: Utilities.getUuid(), login: login, passwordHash: sha256(password), name: name,
      color: palette[existingCount % palette.length], weeklyHours: 40
    };
    appendRow(SHEET_USERS, user);
  } else if (user.passwordHash !== sha256(password)) {
    return { ok: false, error: 'Неверный пароль' };
  }

  var token = Utilities.getUuid();
  appendRow(SHEET_SESSIONS, { token: token, userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS });
  return { ok: true, token: token, user: publicUser(user) };
}

function handleWhoAmI(userId) {
  var user = findRow(SHEET_USERS, userId);
  if (!user) return { ok: false, error: 'Пользователь не найден' };
  return { ok: true, user: publicUser(user) };
}

function handleUpdateProfile(userId, profile) {
  if (!profile) return { ok: false, error: 'нет profile' };
  var user = findRow(SHEET_USERS, userId);
  if (!user) return { ok: false, error: 'Пользователь не найден' };
  var patch = {};
  if (typeof profile.name === 'string' && profile.name.trim()) patch.name = profile.name.trim();
  if (typeof profile.color === 'string') patch.color = profile.color;
  if (profile.weeklyHours !== undefined && profile.weeklyHours !== '') patch.weeklyHours = Number(profile.weeklyHours) || 0;
  if (Array.isArray(profile.visibleViews)) {
    var filtered = profile.visibleViews.filter(function (v) { return ALL_VIEWS.indexOf(v) !== -1; });
    if (filtered.length) patch.visibleViews = JSON.stringify(filtered);
  }
  var merged = Object.assign({}, user, patch);
  upsertRow(SHEET_USERS, merged);
  return { ok: true, user: publicUser(merged) };
}

function publicUser(user) {
  var views = safeJson(user.visibleViews, null);
  if (!Array.isArray(views) || !views.length) views = ALL_VIEWS.slice();
  return { id: user.id, login: user.login, name: user.name, color: user.color || '#6d5dfc', weeklyHours: user.weeklyHours === '' || user.weeklyHours === undefined ? 40 : Number(user.weeklyHours), visibleViews: views };
}

function handleListUsers() {
  var users = readRows(SHEET_USERS);
  return { ok: true, users: users.map(publicUser) };
}

function requireSession(token) {
  if (!token) return null;
  var sessions = readRows(SHEET_SESSIONS);
  var session = sessions.find(function (s) { return s.token === token; });
  if (!session) return null;
  if (Number(session.expiresAt) < Date.now()) return null;
  return session;
}

// ---------- State (только своё + то, что назначено) ----------

function handleGetState(userId) {
  var allTasks = readRows(SHEET_TASKS);
  var visibleTasks = allTasks.filter(function (t) { return t.creatorId === userId || t.assigneeId === userId; });

  var allProjects = readRows(SHEET_PROJECTS);
  var allSections = readRows(SHEET_SECTIONS);

  var refProjectIds = uniq(visibleTasks.map(function (t) { return t.projectId; }));
  var refSectionIds = uniq(visibleTasks.map(function (t) { return t.sectionId; }));

  var projectsById = {};
  allProjects.forEach(function (p) {
    var isOwn = p.creatorId === userId;
    var isRef = refProjectIds.indexOf(p.id) !== -1;
    if (isOwn || isRef) projectsById[p.id] = Object.assign({}, p, { canEdit: isOwn });
  });

  var sectionsById = {};
  allSections.forEach(function (s) {
    var parentProject = projectsById[s.projectId];
    var isOwn = parentProject && parentProject.canEdit;
    var isRef = refSectionIds.indexOf(s.id) !== -1;
    if (isOwn || isRef) sectionsById[s.id] = Object.assign({}, s, { canEdit: !!isOwn });
  });

  var views = readRows(SHEET_VIEWS).filter(function (v) { return v.userId === userId; });
  var viewedMap = {};
  views.forEach(function (v) { viewedMap[v.taskId] = Number(v.viewedAt); });

  var tasks = visibleTasks.map(function (t) {
    var viewedAt = viewedMap[t.id];
    var isOwn = t.creatorId === userId;
    return Object.assign({}, t, {
      tags: safeJson(t.tags, []),
      dependencies: safeJson(t.dependencies, []),
      completed: t.completed === true || t.completed === 'TRUE' || t.completed === 'true',
      canEdit: isOwn,
      canComplete: isOwn || t.assigneeId === userId,
      isUnread: !viewedAt,
      isChanged: !!viewedAt && Number(t.updatedAt) > viewedAt
    });
  });

  return {
    ok: true,
    projects: Object.values(projectsById),
    sections: Object.values(sectionsById),
    tasks: tasks
  };
}

// ---------- Запись (с проверкой прав) ----------

// Создаёт пустой стартовый проект с тремя разделами одним HTTP-запросом
// (а не четырьмя последовательными — см. js/sync.js, ensureStarterProject).
// Каждый вызов Apps Script — это отдельный медленный round-trip (секунды),
// а сама работа с листами внутри одного запуска — быстрая; объединение в
// один вызов сократило время первого входа примерно с 30 до ~8 секунд.
function handleCreateStarterProject(userId) {
  var project = { id: Utilities.getUuid(), name: 'Мои задачи', creatorId: userId, updatedAt: Date.now() };
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
  if (!project) return { ok: false, error: 'нет project' };
  // Решаем "создать или обновить" по тому, существует ли уже строка с
  // таким id, а НЕ по тому, прислал ли клиент id — app.js сам генерирует
  // id для новых проектов на клиенте (см. uid() в app.js), так что
  // присланный id ничего не говорит о том, знает ли о нём уже сервер.
  var existing = project.id ? findRow(SHEET_PROJECTS, project.id) : null;
  if (existing) {
    if (existing.creatorId !== userId) return { ok: false, error: 'Редактировать может только автор проекта' };
    var merged = Object.assign({}, existing, project, { creatorId: existing.creatorId, updatedAt: Date.now() });
    upsertRow(SHEET_PROJECTS, merged);
    return { ok: true, project: merged };
  }
  project.id = project.id || Utilities.getUuid();
  project.creatorId = userId;
  project.updatedAt = Date.now();
  project.createdAt = project.updatedAt;
  upsertRow(SHEET_PROJECTS, project);
  return { ok: true, project: project };
}

function handleSaveSection(userId, section) {
  if (!section || !section.projectId) return { ok: false, error: 'нет section/projectId' };
  var project = findRow(SHEET_PROJECTS, section.projectId);
  if (!project) return { ok: false, error: 'Проект не найден' };
  if (project.creatorId !== userId) return { ok: false, error: 'Разделы может менять только автор проекта' };
  section.id = section.id || Utilities.getUuid();
  upsertRow(SHEET_SECTIONS, section);
  return { ok: true, section: section };
}

function handleSaveTask(userId, task) {
  if (!task) return { ok: false, error: 'нет task' };

  // Как и в handleSaveProject — смотрим, есть ли уже такая запись на
  // сервере, а не полагаемся на то, прислал ли клиент id.
  var existing = task.id ? findRow(SHEET_TASKS, task.id) : null;

  if (!existing) {
    task.id = task.id || Utilities.getUuid();
    task.creatorId = userId;
    task.updatedAt = Date.now();
    task.createdAt = task.updatedAt;
    task.tags = JSON.stringify(task.tags || []);
    task.dependencies = JSON.stringify(task.dependencies || []);
    upsertRow(SHEET_TASKS, task);
    return { ok: true, taskId: task.id };
  }

  if (existing.creatorId === userId) {
    var merged = Object.assign({}, existing, task, { creatorId: existing.creatorId, id: existing.id, updatedAt: Date.now() });
    merged.tags = JSON.stringify(task.tags !== undefined ? task.tags : safeJson(existing.tags, []));
    merged.dependencies = JSON.stringify(task.dependencies !== undefined ? task.dependencies : safeJson(existing.dependencies, []));
    upsertRow(SHEET_TASKS, merged);
    return { ok: true, taskId: merged.id };
  }

  if (existing.assigneeId === userId) {
    var patch = { updatedAt: Date.now() };
    ASSIGNEE_EDITABLE_TASK_FIELDS.forEach(function (field) {
      if (task[field] !== undefined) patch[field] = task[field];
    });
    var mergedLimited = Object.assign({}, existing, patch);
    upsertRow(SHEET_TASKS, mergedLimited);
    return { ok: true, taskId: mergedLimited.id };
  }

  return { ok: false, error: 'Нет прав на редактирование этой задачи' };
}

function handleDeleteTask(userId, taskId) {
  if (!taskId) return { ok: false, error: 'нет taskId' };
  var existing = findRow(SHEET_TASKS, taskId);
  if (!existing) return { ok: true }; // уже удалена — считаем успехом
  if (existing.creatorId !== userId) return { ok: false, error: 'Удалить может только автор задачи' };
  deleteRow(SHEET_TASKS, taskId);
  return { ok: true };
}

function handleDeleteProject(userId, projectId) {
  if (!projectId) return { ok: false, error: 'нет projectId' };
  var existing = findRow(SHEET_PROJECTS, projectId);
  if (!existing) return { ok: true }; // уже удалён — считаем успехом
  if (existing.creatorId !== userId) return { ok: false, error: 'Удалить может только автор проекта' };
  // Каскад: разделы и задачи внутри проекта удаляем вместе с ним, даже
  // если некоторые задачи создал не сам автор проекта (см. модель прав) —
  // проект целиком в его власти.
  deleteRowsWhere(SHEET_SECTIONS, function (r) { return r.projectId === projectId; });
  deleteRowsWhere(SHEET_TASKS, function (r) { return r.projectId === projectId; });
  deleteRow(SHEET_PROJECTS, projectId);
  return { ok: true };
}

function handleDeleteSection(userId, sectionId) {
  if (!sectionId) return { ok: false, error: 'нет sectionId' };
  var existing = findRow(SHEET_SECTIONS, sectionId);
  if (!existing) return { ok: true };
  var project = findRow(SHEET_PROJECTS, existing.projectId);
  if (!project || project.creatorId !== userId) return { ok: false, error: 'Разделы может удалять только автор проекта' };
  deleteRow(SHEET_SECTIONS, sectionId);
  return { ok: true };
}

function handleMarkViewed(userId, taskId) {
  if (!taskId) return { ok: false, error: 'нет taskId' };
  var views = readRows(SHEET_VIEWS);
  var existing = views.find(function (v) { return v.userId === userId && v.taskId === taskId; });
  if (existing) {
    upsertRowByMatch(SHEET_VIEWS, { userId: userId, taskId: taskId, viewedAt: Date.now() }, function (r) {
      return r.userId === userId && r.taskId === taskId;
    });
  } else {
    appendRow(SHEET_VIEWS, { userId: userId, taskId: taskId, viewedAt: Date.now() });
  }
  return { ok: true };
}

// ---------- Утилиты работы с листами ----------

function getSheet(name) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error('Лист ' + name + ' не найден — запустите setup()');
  return sheet;
}

function readRows(name) {
  var sheet = getSheet(name);
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  return values.slice(1)
    .filter(function (row) { return row.some(function (c) { return c !== ''; }); })
    .map(function (row) {
      var obj = {};
      headers.forEach(function (h, i) { obj[h] = row[i]; });
      return obj;
    });
}

function findRow(name, id) {
  var rows = readRows(name);
  return rows.find(function (r) { return r.id === id; }) || null;
}

function appendRow(name, obj) {
  var sheet = getSheet(name);
  var headers = SCHEMAS[name];
  sheet.appendRow(headers.map(function (h) { return obj[h] !== undefined ? obj[h] : ''; }));
}

function upsertRow(name, obj) {
  upsertRowByMatch(name, obj, function (row) { return row.id === obj.id; });
}

function upsertRowByMatch(name, obj, matchFn) {
  var sheet = getSheet(name);
  var headers = SCHEMAS[name];
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    var row = {};
    headers.forEach(function (h, idx) { row[h] = values[i][idx]; });
    if (matchFn(row)) {
      var merged = Object.assign({}, row, obj);
      sheet.getRange(i + 1, 1, 1, headers.length).setValues([headers.map(function (h) { return merged[h] !== undefined ? merged[h] : ''; })]);
      return;
    }
  }
  appendRow(name, obj);
}

function deleteRowsWhere(name, predicate) {
  var sheet = getSheet(name);
  var headers = SCHEMAS[name];
  var values = sheet.getDataRange().getValues();
  for (var i = values.length - 1; i >= 1; i--) {
    var row = {};
    headers.forEach(function (h, idx) { row[h] = values[i][idx]; });
    if (predicate(row)) sheet.deleteRow(i + 1);
  }
}

function deleteRow(name, id) {
  var sheet = getSheet(name);
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (values[i][0] === id) {
      sheet.deleteRow(i + 1);
      return;
    }
  }
}

function uniq(arr) {
  var seen = {};
  return arr.filter(function (v) {
    if (v === undefined || v === '' || seen[v]) return false;
    seen[v] = true;
    return true;
  });
}

function safeJson(str, fallback) {
  try { return str ? JSON.parse(str) : fallback; } catch (e) { return fallback; }
}
