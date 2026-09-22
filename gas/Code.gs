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
 *    пользователя, или он в списке наблюдателей (watchers) этой задачи —
 *    он не создатель, но может отметить её выполненной и писать в
 *    описание/заметки. Остальные поля (сроки, приоритет, исполнитель,
 *    раздел, теги, зависимости) ему менять нельзя.
 *  - Пользователь видит только те задачи, которые сам создал, назначены
 *    на него, или где он наблюдатель — плюс минимальный контекст (название
 *    проекта/раздела) для этих задач.
 *  - Участник проекта (project.members, управляет только автор проекта)
 *    видит ВСЕ задачи и разделы этого проекта целиком (а не только свои/
 *    назначенные), но редактировать может только то, что создал сам или
 *    на что назначен/где наблюдатель — как обычно.
 *  - Администратор (Users.isAdmin = TRUE) видит и может редактировать/
 *    удалять АБСОЛЮТНО ВСЁ у ВСЕХ пользователей, как будто он автор.
 *    Плюс ему доступны adminUpdateUser/adminDeleteUser для управления
 *    самими пользователями. Ставить isAdmin можно только вручную в самой
 *    таблице (лист Users, столбец isAdmin = TRUE) — через приложение или
 *    API назначить администратора нельзя, это осознанно.
 */

var SHEET_USERS = 'Users';
var SHEET_SESSIONS = 'Sessions';
var SHEET_PROJECTS = 'Projects';
var SHEET_SECTIONS = 'Sections';
var SHEET_TASKS = 'Tasks';
var SHEET_VIEWS = 'Views';

var SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней

var SCHEMAS = {};
SCHEMAS[SHEET_USERS] = ['id', 'login', 'passwordHash', 'name', 'color', 'weeklyHours', 'visibleViews', 'isAdmin'];
SCHEMAS[SHEET_SESSIONS] = ['token', 'userId', 'expiresAt'];
SCHEMAS[SHEET_PROJECTS] = ['id', 'name', 'color', 'parentId', 'creatorId', 'members', 'archived', 'createdAt', 'updatedAt'];
SCHEMAS[SHEET_SECTIONS] = ['id', 'projectId', 'name', 'order'];
SCHEMAS[SHEET_TASKS] = ['id', 'projectId', 'sectionId', 'parentTaskId', 'title', 'description', 'assigneeId', 'creatorId', 'watchers',
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

// Действия, которые пишут в таблицу — для них нужна блокировка (см. ниже).
// Чтения (getState/listUsers/whoAmI) в неё не берём, чтобы не тормозить
// параллельную работу нескольких людей без необходимости.
var WRITE_ACTIONS = ['login', 'updateProfile', 'createStarterProject', 'saveProject', 'saveSection', 'saveTask',
  'deleteTask', 'deleteProject', 'deleteSection', 'markViewed', 'adminUpdateUser', 'adminDeleteUser'];

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) { /* пустое тело */ }
  var result;
  // Apps Script не гарантирует, что два одновременных запроса не увидят
  // одно и то же "старое" состояние листа — без блокировки два почти
  // синхронных вызова saveProject/saveTask/... для ЕЩЁ НЕ существующей
  // записи оба решают, что её нужно создать, и оба дописывают строку с
  // одним и тем же id (реальный случай: два экземпляра одной "Брусники"
  // в листе Projects). Из-за этого же retry-логика на клиенте (при
  // потере ответа после реально успешной записи) могла задваивать
  // данные — с локом повторный запрос увидит уже сохранённую строку и
  // корректно её обновит, а не создаст вторую.
  var needsLock = WRITE_ACTIONS.indexOf(body.action) !== -1;
  var lock = needsLock ? LockService.getScriptLock() : null;
  try {
    if (lock) lock.waitLock(15000);
    result = route(body.action, body);
  } catch (err) {
    result = { ok: false, error: String(err) };
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
    case 'adminUpdateUser': return handleAdminUpdateUser(userId, body.targetUserId, body.patch);
    case 'adminDeleteUser': return handleAdminDeleteUser(userId, body.targetUserId);
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
  return {
    id: user.id, login: user.login, name: user.name, color: user.color || '#6d5dfc',
    weeklyHours: user.weeklyHours === '' || user.weeklyHours === undefined ? 40 : Number(user.weeklyHours),
    visibleViews: views, isAdmin: isAdminValue(user.isAdmin)
  };
}

function isAdminValue(v) {
  return v === true || v === 'TRUE' || v === 'true';
}

function isUserAdmin(userId) {
  var user = findRow(SHEET_USERS, userId);
  return !!(user && isAdminValue(user.isAdmin));
}

function handleListUsers() {
  var users = readRows(SHEET_USERS);
  return { ok: true, users: users.map(publicUser) };
}

// ---------- Администрирование (только Users.isAdmin = TRUE) ----------

function handleAdminUpdateUser(userId, targetUserId, patch) {
  if (!isUserAdmin(userId)) return { ok: false, error: 'Только администратор может это делать' };
  if (!targetUserId) return { ok: false, error: 'нет targetUserId' };
  var target = findRow(SHEET_USERS, targetUserId);
  if (!target) return { ok: false, error: 'Пользователь не найден' };
  var p = {};
  if (patch && typeof patch.name === 'string' && patch.name.trim()) p.name = patch.name.trim();
  if (patch && typeof patch.color === 'string' && patch.color) p.color = patch.color;
  if (patch && typeof patch.newPassword === 'string' && patch.newPassword) p.passwordHash = sha256(patch.newPassword);
  var merged = Object.assign({}, target, p);
  upsertRow(SHEET_USERS, merged);
  return { ok: true, user: publicUser(merged) };
}

function handleAdminDeleteUser(userId, targetUserId) {
  if (!isUserAdmin(userId)) return { ok: false, error: 'Только администратор может это делать' };
  if (!targetUserId) return { ok: false, error: 'нет targetUserId' };
  if (targetUserId === userId) return { ok: false, error: 'Нельзя удалить самого себя' };
  // Задачи/проекты удалённого человека НЕ удаляются и НЕ переназначаются —
  // это осознанно (чтобы админ случайно не снёс чужую работу вместе с
  // аккаунтом); они просто останутся с его старым creatorId/assigneeId.
  deleteRow(SHEET_USERS, targetUserId);
  deleteRowsWhere(SHEET_SESSIONS, function (r) { return r.userId === targetUserId; });
  return { ok: true };
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
  // dedupeById — на случай, если в листе всё же оказались две строки с
  // одинаковым id (см. WRITE_ACTIONS/LockService в doPost — обычно такого
  // больше не будет, но старые задвоенные строки, если где-то остались,
  // отфильтровать не помешает). Обычная (не админская) ветка ниже и так
  // защищена от этого — там записи собираются в объект по id, что само по
  // себе схлопывает дубли; админский режим отдавал все строки как есть.
  function dedupeById(rows) {
    var seen = {};
    return rows.filter(function (r) {
      if (seen[r.id]) return false;
      seen[r.id] = true;
      return true;
    });
  }
  var allProjects = dedupeById(readRows(SHEET_PROJECTS));
  var allSections = dedupeById(readRows(SHEET_SECTIONS));
  var allTasks = dedupeById(readRows(SHEET_TASKS));

  // Администратор видит и может редактировать абсолютно всё у всех —
  // короткий путь в обход обычной фильтрации по правам.
  if (isUserAdmin(userId)) {
    var adminViews = readRows(SHEET_VIEWS).filter(function (v) { return v.userId === userId; });
    var adminViewedMap = {};
    adminViews.forEach(function (v) { adminViewedMap[v.taskId] = Number(v.viewedAt); });
    return {
      ok: true,
      projects: allProjects.map(function (p) { return Object.assign({}, p, { members: safeJson(p.members, []), canEdit: true }); }),
      sections: allSections.map(function (s) { return Object.assign({}, s, { canEdit: true }); }),
      tasks: allTasks.map(function (t) {
        var viewedAt = adminViewedMap[t.id];
        return Object.assign({}, t, {
          tags: safeJson(t.tags, []), dependencies: safeJson(t.dependencies, []), watchers: safeJson(t.watchers, []),
          completed: t.completed === true || t.completed === 'TRUE' || t.completed === 'true',
          canEdit: true, canComplete: true,
          isUnread: !viewedAt, isChanged: !!viewedAt && Number(t.updatedAt) > viewedAt
        });
      })
    };
  }

  // Проекты, где userId — автор или в списке участников (project.members):
  // такой пользователь видит ВЕСЬ проект целиком, а не только свои задачи.
  var memberProjectIds = {};
  allProjects.forEach(function (p) {
    var isOwn = p.creatorId === userId;
    var isMember = safeJson(p.members, []).indexOf(userId) !== -1;
    if (isOwn || isMember) memberProjectIds[p.id] = true;
  });

  var visibleTasks = allTasks.filter(function (t) {
    if (t.creatorId === userId || t.assigneeId === userId) return true;
    if (safeJson(t.watchers, []).indexOf(userId) !== -1) return true;
    return !!memberProjectIds[t.projectId];
  });

  // Если видна родительская задача — все её подзадачи (и подзадачи
  // подзадач) должны быть видны тоже, иначе назначенный/наблюдающий
  // пользователь видит саму задачу пустой, без разбивки на подзадачи.
  // И наоборот: если видна ТОЛЬКО подзадача (например, назначили именно
  // её, а не родителя) — вся цепочка родителей вверх тоже должна попасть
  // в ответ, иначе в древовидных видах (Структура/Гант) эта подзадача
  // ни к чему не подвешена и просто не рисуется, хотя формально приходит
  // с сервера (родители при этом остаются нередактируемыми — canEdit
  // считается ниже как обычно, по creatorId).
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
    var isRef = refProjectIds.indexOf(p.id) !== -1;
    if (isOwn || memberProjectIds[p.id] || isRef) {
      projectsById[p.id] = Object.assign({}, p, { members: safeJson(p.members, []), canEdit: isOwn });
    }
  });

  var sectionsById = {};
  allSections.forEach(function (s) {
    var parentProject = projectsById[s.projectId];
    if (!parentProject) return;
    var isRef = refSectionIds.indexOf(s.id) !== -1;
    if (parentProject.canEdit || memberProjectIds[s.projectId] || isRef) {
      sectionsById[s.id] = Object.assign({}, s, { canEdit: !!parentProject.canEdit });
    }
  });

  var views = readRows(SHEET_VIEWS).filter(function (v) { return v.userId === userId; });
  var viewedMap = {};
  views.forEach(function (v) { viewedMap[v.taskId] = Number(v.viewedAt); });

  var tasks = visibleTasks.map(function (t) {
    var viewedAt = viewedMap[t.id];
    var isOwn = t.creatorId === userId;
    var isWatcher = safeJson(t.watchers, []).indexOf(userId) !== -1;
    return Object.assign({}, t, {
      tags: safeJson(t.tags, []),
      dependencies: safeJson(t.dependencies, []),
      watchers: safeJson(t.watchers, []),
      completed: t.completed === true || t.completed === 'TRUE' || t.completed === 'true',
      canEdit: isOwn,
      canComplete: isOwn || t.assigneeId === userId || isWatcher,
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
    if (existing.creatorId !== userId && !isUserAdmin(userId)) return { ok: false, error: 'Редактировать может только автор проекта' };
    var merged = Object.assign({}, existing, project, { creatorId: existing.creatorId, updatedAt: Date.now() });
    merged.members = JSON.stringify(project.members !== undefined ? project.members : safeJson(existing.members, []));
    // Не даём проекту стать предком самого себя (например, гонка двух
    // одновременных перетаскиваний в разных вкладках) — иначе дерево
    // подпроектов зацикливается и вешает рендер на клиенте.
    if (merged.parentId) {
      var allProjectsForCycleCheck = readRows(SHEET_PROJECTS);
      var cursor = merged.parentId;
      var guard = 0;
      while (cursor && guard < 1000) {
        if (cursor === merged.id) return { ok: false, error: 'Нельзя вложить проект сам в себя' };
        var parentRow = allProjectsForCycleCheck.find(function (r) { return r.id === cursor; });
        cursor = parentRow ? parentRow.parentId : null;
        guard++;
      }
    }
    upsertRow(SHEET_PROJECTS, merged);
    return { ok: true, project: Object.assign({}, merged, { members: safeJson(merged.members, []) }) };
  }
  project.id = project.id || Utilities.getUuid();
  project.creatorId = userId;
  project.updatedAt = Date.now();
  project.createdAt = project.updatedAt;
  var membersList = project.members || [];
  project.members = JSON.stringify(membersList);
  upsertRow(SHEET_PROJECTS, project);
  return { ok: true, project: Object.assign({}, project, { members: membersList }) };
}

function handleSaveSection(userId, section) {
  if (!section || !section.projectId) return { ok: false, error: 'нет section/projectId' };
  var project = findRow(SHEET_PROJECTS, section.projectId);
  if (!project) return { ok: false, error: 'Проект не найден' };
  if (project.creatorId !== userId && !isUserAdmin(userId)) return { ok: false, error: 'Разделы может менять только автор проекта' };
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
    task.watchers = JSON.stringify(task.watchers || []);
    upsertRow(SHEET_TASKS, task);
    return { ok: true, taskId: task.id };
  }

  if (existing.creatorId === userId || isUserAdmin(userId)) {
    var merged = Object.assign({}, existing, task, { creatorId: existing.creatorId, id: existing.id, updatedAt: Date.now() });
    merged.tags = JSON.stringify(task.tags !== undefined ? task.tags : safeJson(existing.tags, []));
    merged.dependencies = JSON.stringify(task.dependencies !== undefined ? task.dependencies : safeJson(existing.dependencies, []));
    merged.watchers = JSON.stringify(task.watchers !== undefined ? task.watchers : safeJson(existing.watchers, []));
    upsertRow(SHEET_TASKS, merged);
    return { ok: true, taskId: merged.id };
  }

  // Не создатель — но назначен исполнителем ИЛИ в списке наблюдателей:
  // можно отметить выполненной и написать заметку, остальное нельзя.
  var isAssignee = existing.assigneeId === userId;
  var isWatcher = safeJson(existing.watchers, []).indexOf(userId) !== -1;
  if (isAssignee || isWatcher) {
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
  if (existing.creatorId !== userId && !isUserAdmin(userId)) return { ok: false, error: 'Удалить может только автор задачи' };
  // Каскад по подзадачам на любую глубину — клиент обычно и сам шлёт
  // отдельный deleteTask на каждую из них, но если один из вызовов не
  // дойдёт (обрыв сети, гонка), подзадачи иначе остаются висящими
  // строками со ссылкой на несуществующего родителя (parentTaskId),
  // которые ни один вид на клиенте не умеет отрисовать.
  var allTasks = readRows(SHEET_TASKS);
  var idsToDelete = {};
  idsToDelete[taskId] = true;
  var addedMore = true;
  while (addedMore) {
    addedMore = false;
    allTasks.forEach(function (t) {
      if (!idsToDelete[t.id] && t.parentTaskId && idsToDelete[t.parentTaskId]) {
        idsToDelete[t.id] = true;
        addedMore = true;
      }
    });
  }
  deleteRowsWhere(SHEET_TASKS, function (r) { return !!idsToDelete[r.id]; });
  return { ok: true };
}

function handleDeleteProject(userId, projectId) {
  if (!projectId) return { ok: false, error: 'нет projectId' };
  var existing = findRow(SHEET_PROJECTS, projectId);
  if (!existing) return { ok: true }; // уже удалён — считаем успехом
  if (existing.creatorId !== userId && !isUserAdmin(userId)) return { ok: false, error: 'Удалить может только автор проекта' };
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
  if (!project || (project.creatorId !== userId && !isUserAdmin(userId))) return { ok: false, error: 'Разделы может удалять только автор проекта' };
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

// Если fallback — массив (как почти везде: tags/dependencies/members/
// watchers), а результат разбора почему-то не массив (пустая ячейка после
// добавления нового столбца, старые данные, случайное не-JSON значение) —
// всё равно возвращаем fallback, а не что попало. Раньше из-за этого падало
// с "TypeError: ....indexOf is not a function" на старых задачах/проектах,
// у которых новый столбец (например watchers) ещё пустой.
function safeJson(str, fallback) {
  try {
    var parsed = str ? JSON.parse(str) : fallback;
    if (Array.isArray(fallback) && !Array.isArray(parsed)) return fallback;
    return parsed;
  } catch (e) {
    return fallback;
  }
}
