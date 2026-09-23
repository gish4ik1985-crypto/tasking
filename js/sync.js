// Мост между Google Apps Script API (gas/Code.gs) и внутренним форматом
// состояния app.js (state.projects[].sections[]/tasks[]). Не трогает
// внутренности app.js напрямую — только конвертирует данные туда-обратно
// и вызывается из нескольких "крючков" в app.js:
//   1) в конце flushSave() — window.TaskingSync.push(state)
//   2) в openDetail() — window.TaskingSync.markViewed(taskId)
//   3) window.TaskingApplyExternalState / TaskingApplyServerFlags — через
//      них опрос сервера отдаёт в app.js свежие данные от других людей.
// Работает и со старой версией сервера: что умеет сервер, клиент узнаёт
// из списка features в ответе getState и выбирает пути сам.
// Обычный <script> (не ES-модуль) — приложение открывают и через file://.
(function () {
  "use strict";

  const PROJECT_COLORS = ["#6d5dfc", "#2fb380", "#e0a63a", "#e2554a", "#3aa0e0", "#c957c9"];
  const STORAGE_KEY = "tasking-state-v1";
  const POLL_INTERVAL_MS = 20000;
  // Раз в столько времени состояние перечитывается целиком, даже если
  // ревизия не менялась (на случай правок прямо в таблице).
  const FULL_REFRESH_MS = 5 * 60 * 1000;
  const PUSH_DEBOUNCE_MS = 400;
  const BATCH_LIMIT = 150;
  const RETRY_DELAYS_MS = [3000, 10000, 30000, 60000];

  let features = new Set();
  let revision = null;
  let lastFullAt = 0;

  function api(action, payload) {
    return window.TaskingAuth.api(action, payload);
  }

  function emit(name, detail) {
    try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch (e) { /* старые браузеры */ }
  }

  function applyServerMeta(res) {
    if (Array.isArray(res.features)) features = new Set(res.features);
    if (res.revision) revision = res.revision;
    if (typeof res.inboxUnread === "number") emit("tasking:inbox", { unread: res.inboxUnread });
  }

  // ---------- API -> локальный формат ----------

  function str(v) {
    return v === undefined || v === null ? "" : String(v);
  }

  // Google Таблица могла вернуть дату как "2026-09-22T21:00:00.000Z" —
  // приводим к "ГГГГ-ММ-ДД" в локальном часовом поясе.
  function normalizeDate(v) {
    const s = str(v);
    if (!s || /^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    if (isNaN(d.getTime())) return "";
    return window.TaskingUtils.dateToStr(d);
  }

  function apiTaskToLocal(t) {
    return {
      id: t.id,
      sectionId: t.sectionId || "",
      parentTaskId: t.parentTaskId || null,
      title: str(t.title),
      notes: str(t.description),
      assigneeId: t.assigneeId || null,
      watchers: Array.isArray(t.watchers) ? t.watchers : [],
      start: normalizeDate(t.startDate),
      due: normalizeDate(t.dueDate),
      datesAuto: t.datesAuto !== false && t.datesAuto !== "false" && t.datesAuto !== "FALSE",
      priority: t.priority || "medium",
      tags: Array.isArray(t.tags) ? t.tags.map(str) : [],
      dependsOn: Array.isArray(t.dependencies) ? t.dependencies : [],
      estimateHours: t.estimateHours === "" || t.estimateHours == null ? null : Number(t.estimateHours),
      completed: !!t.completed,
      order: t.order === "" || t.order == null ? 0 : Number(t.order),
      archived: t.archived === true || t.archived === "TRUE" || t.archived === "true",
      recurrence: str(t.recurrence),
      milestone: t.milestone === true || t.milestone === "TRUE" || t.milestone === "true",
      approvers: Array.isArray(t.approvers) ? t.approvers : [],
      // Служебные поля для UI (права, бейджи, решения согласующих) —
      // приходят только с сервера, обратно не отправляются.
      _creatorId: t.creatorId || "",
      _canEdit: !!t.canEdit,
      _canComplete: !!t.canComplete,
      _isUnread: !!t.isUnread,
      _isChanged: !!t.isChanged,
      _approvals: t.approvals && typeof t.approvals === "object" && !Array.isArray(t.approvals) ? t.approvals : {}
    };
  }

  function apiStateToLocal(apiState, usersList, prevLocal) {
    const tasksByProject = {};
    apiState.tasks.forEach((t) => {
      (tasksByProject[t.projectId] = tasksByProject[t.projectId] || []).push(apiTaskToLocal(t));
    });
    const sectionsByProject = {};
    apiState.sections.forEach((s) => {
      (sectionsByProject[s.projectId] = sectionsByProject[s.projectId] || []).push(s);
    });
    Object.keys(sectionsByProject).forEach((pid) => {
      sectionsByProject[pid].sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
    });

    const projects = apiState.projects.map((p, i) => ({
      id: p.id,
      name: str(p.name) || "Проект",
      color: p.color || PROJECT_COLORS[i % PROJECT_COLORS.length],
      parentId: p.parentId || null,
      members: Array.isArray(p.members) ? p.members : [],
      _creatorId: p.creatorId || "",
      _canEdit: !!p.canEdit,
      sections: (sectionsByProject[p.id] || []).map((s) => ({ id: s.id, name: str(s.name) })),
      tasks: tasksByProject[p.id] || []
    }));

    const activeStillExists = prevLocal && projects.some((p) => p.id === prevLocal.activeProjectId);
    const session = window.TaskingAuth.getSession();

    return Object.assign({}, prevLocal, {
      users: usersList.slice(),
      projects,
      activeProjectId: activeStillExists ? prevLocal.activeProjectId : (projects[0] ? projects[0].id : null),
      screen: (prevLocal && prevLocal.screen) || "project",
      view: (prevLocal && prevLocal.view) || "board",
      showCompleted: prevLocal ? prevLocal.showCompleted !== false : true,
      ganttNameColWidth: (prevLocal && prevLocal.ganttNameColWidth) || 260,
      ganttDayWidth: (prevLocal && prevLocal.ganttDayWidth) || 30,
      uiByProject: (prevLocal && prevLocal.uiByProject) || {},
      collapsedProjectIds: (prevLocal && prevLocal.collapsedProjectIds) || [],
      collapsedTaskIds: (prevLocal && prevLocal.collapsedTaskIds) || [],
      trash: (prevLocal && prevLocal.trash) || [],
      schemaVersion: 1,
      _ownerId: session && session.user ? session.user.id : "",
      updatedAt: Date.now()
    });
  }

  function readLocal() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); } catch (e) { return null; }
  }

  // Совсем новому пользователю без единой задачи сразу создаём пустой
  // стартовый проект — app.js не рассчитан на состояние без проектов.
  async function ensureStarterProject(stateRes) {
    const res = await api("createStarterProject", {});
    if (!res.ok) return;
    stateRes.projects.push(Object.assign({}, res.project, { canEdit: true }));
    res.sections.forEach((s) => stateRes.sections.push(Object.assign({}, s, { canEdit: true })));
  }

  async function fetchUsers(stateRes) {
    if (Array.isArray(stateRes.users)) return stateRes.users;
    const usersRes = await api("listUsers", {});
    return usersRes.ok ? usersRes.users : null;
  }

  // Полная загрузка при входе: забирает состояние с сервера и кладёт его в
  // localStorage под ключом, который читает app.js при старте.
  async function pull() {
    const stateRes = await api("getState", {});
    if (!stateRes.ok) throw new Error(stateRes.error || "Не удалось загрузить задачи");
    applyServerMeta(stateRes);
    lastFullAt = Date.now();
    if (!stateRes.projects.length) await ensureStarterProject(stateRes);
    const usersList = (await fetchUsers(stateRes)) || [];
    // Кэш другого пользователя (вход под другим логином в этом браузере) —
    // его настройки и корзину не подмешиваем.
    let prevLocal = readLocal();
    const session = window.TaskingAuth.getSession();
    if (prevLocal && prevLocal._ownerId && session && session.user && prevLocal._ownerId !== session.user.id) prevLocal = null;
    const local = apiStateToLocal(stateRes, usersList, prevLocal);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(local));
    resetSnapshot(local);
    return local;
  }

  // Мгновенный старт: данные с прошлого раза уже лежат в localStorage —
  // считаем их последним известным состоянием сервера и открываем
  // приложение сразу, а свежие данные подтягиваем опросом в фоне.
  function initFromCache() {
    const local = readLocal();
    if (!local || !Array.isArray(local.projects) || !local.projects.length) return false;
    const session = window.TaskingAuth.getSession();
    if (!session || !session.user || (local._ownerId && local._ownerId !== session.user.id)) return false;
    resetSnapshot(local);
    return true;
  }

  // ---------- Сравнение состояний ----------

  function byId(a, b) {
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  // "Содержимое" — то, что пользователи реально редактируют. Если оно не
  // изменилось, а поменялись только служебные флаги (права, бейджи), экран
  // обновляется тихо, без сброса истории Ctrl+Z и без закрытия окон.
  function contentSignature(s) {
    return JSON.stringify((s.projects || []).slice().sort(byId).map((p) => [
      projectPayload(p),
      (p.sections || []).map((sec, i) => sectionPayload(sec, p.id, i)),
      (p.tasks || []).slice().sort(byId).map((t) => taskPayload(t, p.id))
    ]));
  }

  function flagsSignature(s) {
    return JSON.stringify({
      users: s.users || [],
      projects: (s.projects || []).slice().sort(byId).map((p) => [p.id, p._creatorId, p._canEdit,
        (p.tasks || []).slice().sort(byId).map((t) => [t.id, t._creatorId, t._canEdit, t._canComplete, t._isUnread, t._isChanged, t._approvals])])
    });
  }

  // ---------- Опрос сервера ----------

  let pollTimer = null;
  let polling = false;
  let authLost = false;

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => { pollOnce(false); }, POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) pollOnce(false);
    });
  }

  function handleAuthLost() {
    if (authLost) return;
    authLost = true;
    emit("tasking:auth-lost", {});
  }

  // Спрашивает сервер, нет ли нового от других людей. Пока есть свои
  // неотправленные изменения — не трогает экран вовсе (иначе можно было бы
  // на мгновение "откатить" только что сделанную правку).
  async function pollOnce(force) {
    if (polling || authLost || !window.TaskingAuth.getSession() || !window.TaskingApplyExternalState) return;
    if (hasPendingChanges()) return;
    polling = true;
    try {
      const needFull = force || !revision || !features.has("revision") || Date.now() - lastFullAt > FULL_REFRESH_MS;
      const stateRes = await api("getState", needFull ? {} : { sinceRevision: revision });
      if (!stateRes.ok) {
        if (stateRes.error === "unauthorized") handleAuthLost();
        return;
      }
      applyServerMeta(stateRes);
      if (stateRes.unchanged) return;
      lastFullAt = Date.now();
      const prevLocal = readLocal();
      const usersList = (await fetchUsers(stateRes)) || (prevLocal && prevLocal.users) || [];
      if (hasPendingChanges()) return;
      const fresh = apiStateToLocal(stateRes, usersList, prevLocal);
      const live = currentLive() || prevLocal;
      if (live && contentSignature(fresh) === contentSignature(live)) {
        if (flagsSignature(fresh) !== flagsSignature(live) && window.TaskingApplyServerFlags) {
          window.TaskingApplyServerFlags(fresh);
        }
        return;
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
      resetSnapshot(fresh);
      window.TaskingApplyExternalState(fresh, { fromServer: true });
    } catch (e) {
      console.error("Опрос сервера на новые данные не удался:", e);
    } finally {
      polling = false;
    }
  }

  // ---------- локальный формат -> API (диф и отправка) ----------

  // Последнее подтверждённое сервером состояние каждой сущности — от него
  // считается, что именно изменилось и что нужно отправить.
  let snapshot = { projects: {}, sections: {}, tasks: {} };

  function resetSnapshot(local) {
    snapshot = { projects: {}, sections: {}, tasks: {} };
    (local.projects || []).forEach((p) => {
      snapshot.projects[p.id] = projectPayload(p);
      (p.sections || []).forEach((s, i) => { snapshot.sections[s.id] = sectionPayload(s, p.id, i); });
      (p.tasks || []).forEach((t) => { snapshot.tasks[t.id] = taskPayload(t, p.id); });
    });
  }

  function projectPayload(p) {
    return JSON.stringify({ id: p.id, name: p.name, color: p.color, parentId: p.parentId || null, members: p.members || [] });
  }
  function sectionPayload(s, projectId, order) {
    return JSON.stringify({ id: s.id, projectId, name: s.name, order });
  }
  function taskPayload(t, projectId) {
    return JSON.stringify({
      id: t.id, projectId, sectionId: t.sectionId, parentTaskId: t.parentTaskId || "",
      title: t.title, description: t.notes || "", assigneeId: t.assigneeId || "", watchers: t.watchers || [],
      priority: t.priority || "medium", completed: !!t.completed,
      startDate: t.start || "", dueDate: t.due || "", datesAuto: !!t.datesAuto,
      estimateHours: t.estimateHours == null ? "" : t.estimateHours,
      order: t.order || 0, tags: t.tags || [], dependencies: t.dependsOn || [], archived: !!t.archived,
      recurrence: t.recurrence || "", milestone: !!t.milestone, approvers: t.approvers || []
    });
  }

  // Только изменившиеся поля (плюс id и projectId) — чтобы не затереть
  // чужие правки в полях, которые здесь никто не трогал.
  function partial(fullJson, prevJson, alwaysKeys) {
    const full = JSON.parse(fullJson);
    if (!prevJson) return full;
    const prev = JSON.parse(prevJson);
    const out = {};
    Object.keys(full).forEach((k) => {
      if (alwaysKeys.indexOf(k) !== -1 || JSON.stringify(full[k]) !== JSON.stringify(prev[k])) out[k] = full[k];
    });
    return out;
  }

  let liveState = null;
  // app.js при полной замене состояния создаёт новый объект — поэтому
  // берём актуальный через геттер, а не храним старую ссылку.
  function currentLive() {
    return window.TaskingGetState ? window.TaskingGetState() : liveState;
  }
  const opAttempts = {};
  const MAX_SERVER_ATTEMPTS = 6;
  let pushTimer = null;
  let pushRequested = false;
  let pushRunning = false;
  let retryTimer = null;
  let retryAttempt = 0;
  let failedCount = 0;
  let status = "saved";

  function setStatus(next, extra) {
    status = next;
    emit("tasking:sync-status", Object.assign({ status: next }, extra || {}));
  }

  function hasPendingChanges() {
    return pushRequested || pushRunning || !!pushTimer || failedCount > 0;
  }

  // Точка входа из app.js: каждое сохранение планирует отправку. Сама
  // отправка идёт строго по одной (очередь), за раз уходит всё накопленное.
  function push(state) {
    liveState = state;
    pushRequested = true;
    if (status !== "saving") setStatus("saving");
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      pushTimer = null;
      runPushLoop();
    }, PUSH_DEBOUNCE_MS);
  }

  async function runPushLoop() {
    if (pushRunning) return;
    pushRunning = true;
    let hadError = false;
    try {
      while (pushRequested) {
        pushRequested = false;
        const live = currentLive();
        if (!window.TaskingAuth.getSession() || !live) break;
        const result = await pushOnce(live);
        if (result.authLost) { handleAuthLost(); break; }
        if (result.failed) hadError = true;
      }
    } catch (e) {
      console.error("Синхронизация с сервером не удалась:", e);
      hadError = true;
      failedCount = Math.max(failedCount, 1);
    } finally {
      pushRunning = false;
    }
    if (hadError || failedCount > 0) scheduleRetry();
    else {
      retryAttempt = 0;
      setStatus("saved");
    }
  }

  function scheduleRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    const delay = RETRY_DELAYS_MS[Math.min(retryAttempt, RETRY_DELAYS_MS.length - 1)];
    retryAttempt++;
    setStatus("error", { retryInMs: delay });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      retryNow();
    }, delay);
  }

  function retryNow() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (!currentLive()) return;
    pushRequested = true;
    setStatus("saving");
    runPushLoop();
  }

  // Ошибка, которую бессмысленно повторять (нет прав, записи не
  // существует) — сервер помечает её permanent, для старого сервера
  // узнаём по тексту. Такие правки "отпускаем": следующий опрос вернёт
  // на экран то, что реально лежит на сервере.
  function isPermanent(res) {
    if (res.permanent) return true;
    return /прав|только автор|может только|Нельзя|не найден|Нет доступа|удалена|нет task|нет section|нет project/i.test(res.error || "");
  }

  function collectOps(state) {
    const ops = { projects: [], sections: [], tasks: [], deleteTasks: [], deleteSections: [], deleteProjects: [] };
    const currentProjectIds = new Set();
    const currentSectionIds = new Set();
    const currentTaskIds = new Set();
    (state.projects || []).forEach((p) => {
      currentProjectIds.add(p.id);
      const pJson = projectPayload(p);
      if (p._canEdit !== false && snapshot.projects[p.id] !== pJson) {
        ops.projects.push({ id: p.id, json: pJson, payload: partial(pJson, snapshot.projects[p.id], ["id"]) });
      }
      (p.sections || []).forEach((s, i) => {
        currentSectionIds.add(s.id);
        const sJson = sectionPayload(s, p.id, i);
        if (p._canEdit !== false && snapshot.sections[s.id] !== sJson) {
          ops.sections.push({ id: s.id, json: sJson, payload: JSON.parse(sJson) });
        }
      });
      (p.tasks || []).forEach((t) => {
        currentTaskIds.add(t.id);
        const tJson = taskPayload(t, p.id);
        if (snapshot.tasks[t.id] !== tJson) {
          ops.tasks.push({ id: t.id, json: tJson, payload: partial(tJson, snapshot.tasks[t.id], ["id", "projectId"]) });
        }
      });
    });
    Object.keys(snapshot.tasks).forEach((id) => { if (!currentTaskIds.has(id)) ops.deleteTasks.push({ id }); });
    Object.keys(snapshot.sections).forEach((id) => { if (!currentSectionIds.has(id)) ops.deleteSections.push({ id }); });
    Object.keys(snapshot.projects).forEach((id) => { if (!currentProjectIds.has(id)) ops.deleteProjects.push({ id }); });
    return ops;
  }

  const SNAPSHOT_KIND = {
    projects: "projects", sections: "sections", tasks: "tasks",
    deleteTasks: "tasks", deleteSections: "sections", deleteProjects: "projects"
  };

  // res === null — сетевой сбой: повторяем сколько угодно (данные не
  // должны теряться из-за пропавшего интернета). Ошибка же, которую вернул
  // сам сервер, повторяется не больше MAX_SERVER_ATTEMPTS раз — иначе одна
  // "застрявшая" запись навсегда блокировала бы получение чужих правок.
  function applyResult(kind, op, res) {
    const bucket = snapshot[SNAPSHOT_KIND[kind]];
    const key = kind + ":" + op.id;
    const settle = () => {
      delete opAttempts[key];
      if (kind.indexOf("delete") === 0) delete bucket[op.id];
      else bucket[op.id] = op.json;
    };
    if (res && res.ok) { settle(); return "ok"; }
    if (res && res.error === "unauthorized") return "auth";
    if (!res) return "retry";
    opAttempts[key] = (opAttempts[key] || 0) + 1;
    if (isPermanent(res) || opAttempts[key] >= MAX_SERVER_ATTEMPTS) {
      console.warn("Сервер отклонил изменение (" + kind + " " + op.id + "): " + res.error);
      settle();
      return "rejected";
    }
    return "retry";
  }

  async function pushOnce(state) {
    const ops = collectOps(state);
    const kinds = Object.keys(ops);
    const total = kinds.reduce((n, k) => n + ops[k].length, 0);
    if (!total) { failedCount = 0; return {}; }

    let outcomes;
    if (features.has("batch")) outcomes = await pushBatched(ops);
    else outcomes = await pushOneByOne(ops);

    const failed = outcomes.filter((o) => o === "retry").length;
    const rejected = outcomes.filter((o) => o === "rejected").length;
    failedCount = failed;
    if (rejected) emit("tasking:sync-rejected", { count: rejected });
    return { failed: failed > 0, authLost: outcomes.indexOf("auth") !== -1 };
  }

  async function pushBatched(ops) {
    const outcomes = [];
    const queue = [];
    Object.keys(ops).forEach((kind) => ops[kind].forEach((op) => queue.push({ kind, op })));
    for (let i = 0; i < queue.length; i += BATCH_LIMIT) {
      const chunk = queue.slice(i, i + BATCH_LIMIT);
      const body = { projects: [], sections: [], tasks: [], deleteTasks: [], deleteSections: [], deleteProjects: [] };
      chunk.forEach(({ kind, op }) => body[kind].push(kind.indexOf("delete") === 0 ? op.id : op.payload));
      const res = await api("saveBatch", body);
      if (!res.ok) {
        if (res.error === "unknown action") {
          // Сервер откатили на старую версию — дальше по одной записи.
          features.delete("batch");
          const rest = {};
          Object.keys(ops).forEach((k) => { rest[k] = []; });
          queue.slice(i).forEach(({ kind, op }) => rest[kind].push(op));
          return outcomes.concat(await pushOneByOne(rest));
        }
        if (res.error === "unauthorized") return outcomes.concat(["auth"]);
        chunk.forEach(({ kind, op }) => outcomes.push(applyResult(kind, op, { ok: false, error: res.error })));
        continue;
      }
      chunk.forEach(({ kind, op }) => outcomes.push(applyResult(kind, op, res.results[kind] && res.results[kind][op.id])));
    }
    return outcomes;
  }

  // Путь для старого сервера без saveBatch: по запросу на запись, не
  // больше 4 одновременно, группами (сначала проекты, потом их разделы и
  // задачи), чтобы задача не пришла раньше своего проекта.
  async function pushOneByOne(ops) {
    const outcomes = [];
    const call = { projects: "saveProject", sections: "saveSection", tasks: "saveTask",
      deleteTasks: "deleteTask", deleteSections: "deleteSection", deleteProjects: "deleteProject" };
    const argOf = {
      projects: (op) => ({ project: op.payload }), sections: (op) => ({ section: op.payload }), tasks: (op) => ({ task: op.payload }),
      deleteTasks: (op) => ({ taskId: op.id }), deleteSections: (op) => ({ sectionId: op.id }), deleteProjects: (op) => ({ projectId: op.id })
    };
    const groups = ["deleteTasks", "projects", "sections", "tasks", "deleteSections", "deleteProjects"];
    for (const kind of groups) {
      await runLimited((ops[kind] || []).map((op) => async () => {
        let res;
        try { res = await api(call[kind], argOf[kind](op)); } catch (e) { res = null; }
        outcomes.push(applyResult(kind, op, res));
      }), 4);
    }
    return outcomes;
  }

  async function runLimited(thunks, limit) {
    let i = 0;
    async function worker() {
      while (i < thunks.length) {
        const thunk = thunks[i++];
        await thunk();
      }
    }
    await Promise.all(new Array(Math.min(limit, thunks.length)).fill(0).map(worker));
  }

  // Дождаться отправки всего накопленного (например, перед выходом из
  // аккаунта) — не дольше timeoutMs.
  async function flush(timeoutMs) {
    if (pushTimer) {
      clearTimeout(pushTimer);
      pushTimer = null;
      runPushLoop();
    }
    const until = Date.now() + (timeoutMs || 8000);
    while ((pushRunning || pushRequested) && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return !hasPendingChanges();
  }

  // Снимает бейдж "новое/изменено" — в фоне, UI обновляется сразу в app.js.
  function markViewed(taskId) {
    if (!window.TaskingAuth.getSession()) return;
    api("markViewed", { taskId }).catch((e) => console.error("Не удалось отметить задачу просмотренной:", e));
  }

  // Окончательное удаление из корзины (сервер хранит удалённые задачи ещё
  // 60 дней, так что неудача здесь не страшна).
  function purgeTasks(taskIds) {
    if (!taskIds.length || !features.has("purge") || !window.TaskingAuth.getSession()) return;
    api("purgeTasks", { taskIds }).catch((e) => console.error("Не удалось очистить корзину на сервере:", e));
  }

  // ---------- Обсуждение задачи и лента событий ----------
  // Не хранятся в state/localStorage — подгружаются с сервера по запросу.

  function getComments(taskId) {
    return api("getComments", { taskId });
  }

  function saveComment(taskId, text, file, mentions) {
    const payload = { taskId, text };
    if (file) payload.file = { name: file.name, mimeType: file.mimeType, size: file.size, dataBase64: file.dataBase64 };
    if (mentions && mentions.length) payload.mentions = mentions;
    return api("saveComment", payload);
  }

  function deleteComment(commentId) {
    return api("deleteComment", { commentId });
  }

  function getInbox() {
    return api("getInbox", {});
  }

  function markInboxRead() {
    emit("tasking:inbox", { unread: 0 });
    return api("markInboxRead", {});
  }

  function decideApproval(taskId, decision, comment) {
    return api("decideApproval", { taskId, decision, comment });
  }

  function resetApprovals(taskId) {
    return api("resetApprovals", { taskId });
  }

  function has(feature) {
    return features.has(feature);
  }

  window.TaskingSync = {
    pull, push, flush, markViewed, purgeTasks, resetSnapshot, startPolling, initFromCache,
    refreshNow: () => pollOnce(true), retryNow, hasPendingChanges, getStatus: () => status, has,
    getComments, saveComment, deleteComment, getInbox, markInboxRead, decideApproval, resetApprovals,
    // Для тестов.
    _contentSignature: contentSignature
  };
})();
