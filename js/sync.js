// Мост между Google Apps Script API (gas/Code.gs) и внутренним форматом
// состояния app.js (state.projects[].sections[]/tasks[]). Не трогает
// внутренности app.js напрямую — только конвертирует данные туда-обратно
// и вызывается из нескольких маленьких "крючков", добавленных в app.js:
//   1) в конце flushSave() — window.TaskingSync.push(state)
//   2) в openDetail() — window.TaskingSync.markViewed(taskId)
//   3) window.TaskingApplyExternalState — уже существовавший в app.js
//      механизм межвкладочной синхронизации (тост "Обновить", если есть
//      несохранённые правки), переиспользуем его же для периодического
//      опроса сервера (см. startPolling) — правки от других людей приходят
//      так же безопасно, как и от другой вкладки этого же браузера.
// Обычный <script> (не ES-модуль) — приложение открывают и через file://.
(function () {
  "use strict";

  const PROJECT_COLORS = ["#6d5dfc", "#2fb380", "#e0a63a", "#e2554a", "#3aa0e0", "#c957c9"];
  const STORAGE_KEY = "tasking-state-v1";
  const POLL_INTERVAL_MS = 25000;

  function api(action, payload) {
    return window.TaskingAuth.api(action, payload);
  }

  // ---------- API -> локальный формат ----------

  function apiTaskToLocal(t) {
    return {
      id: t.id,
      sectionId: t.sectionId || "",
      parentTaskId: t.parentTaskId || null,
      title: t.title || "",
      notes: t.description || "",
      assigneeId: t.assigneeId || null,
      watchers: Array.isArray(t.watchers) ? t.watchers : [],
      start: t.startDate || "",
      due: t.dueDate || "",
      datesAuto: t.datesAuto !== false && t.datesAuto !== "false",
      priority: t.priority || "medium",
      tags: Array.isArray(t.tags) ? t.tags : [],
      dependsOn: Array.isArray(t.dependencies) ? t.dependencies : [],
      estimateHours: t.estimateHours === "" || t.estimateHours == null ? null : Number(t.estimateHours),
      completed: !!t.completed,
      order: t.order === "" || t.order == null ? 0 : Number(t.order),
      archived: t.archived === true || t.archived === "TRUE" || t.archived === "true",
      // Служебные поля для UI (бейджи "новое"/"изменено", права на
      // редактирование) — app.js их не знает и не трогает, но и не
      // выбрасывает при сохранении, так что спокойно живут вместе с
      // остальными полями задачи.
      _creatorId: t.creatorId || "",
      _canEdit: !!t.canEdit,
      _canComplete: !!t.canComplete,
      _isUnread: !!t.isUnread,
      _isChanged: !!t.isChanged
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
      name: p.name || "Проект",
      color: p.color || PROJECT_COLORS[i % PROJECT_COLORS.length],
      parentId: p.parentId || null,
      members: Array.isArray(p.members) ? p.members : [],
      _creatorId: p.creatorId || "",
      _canEdit: !!p.canEdit,
      sections: (sectionsByProject[p.id] || []).map((s) => ({ id: s.id, name: s.name })),
      tasks: tasksByProject[p.id] || []
    }));

    const users = usersList.slice();
    if (prevLocal && Array.isArray(prevLocal.users)) {
      prevLocal.users.forEach((u) => {
        if (!users.some((u2) => u2.id === u.id)) users.push(u);
      });
    }

    const activeStillExists = prevLocal && projects.some((p) => p.id === prevLocal.activeProjectId);

    return Object.assign({}, prevLocal, {
      users,
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
      updatedAt: Date.now()
    });
  }

  // Забирает текущее состояние пользователя с сервера и кладёт его в
  // localStorage под тем же ключом, который читает app.js при старте
  // (js/app.js, STORAGE_KEY = "tasking-state-v1") — так app.js не нужно
  // ничего знать про сеть, он как обычно читает "локальные" данные.
  // Приложение (app.js) никогда не рассчитывалось на состояние "вообще
  // нет ни одного проекта" — там есть места, которые просто берут
  // state.projects[0] и обращаются к его полям без проверки на undefined.
  // Раньше это было невозможно: даже у первого локального запуска всегда
  // есть демо-проект. А вот у совсем нового пользователя без единой своей
  // или назначенной задачи projects с сервера легитимно пустой — поэтому
  // при первом входе с пустым списком сразу создаём (и сохраняем на
  // сервере) один пустой стартовый проект, чтобы это состояние вообще не
  // возникало на экране.
  async function ensureStarterProject(stateRes) {
    // Один запрос вместо четырёх (проект + 3 раздела) — каждый запрос к
    // Apps Script ощутимо небыстрый сам по себе, так что объединение в
    // один вызов на сервере заметно ускоряет самый первый вход.
    const res = await api("createStarterProject", {});
    if (!res.ok) return;
    stateRes.projects.push(Object.assign({}, res.project, { canEdit: true }));
    res.sections.forEach((s) => stateRes.sections.push(Object.assign({}, s, { canEdit: true })));
  }

  async function pull() {
    const [stateRes, usersRes] = await Promise.all([api("getState", {}), api("listUsers", {})]);
    if (!stateRes.ok) throw new Error(stateRes.error || "Не удалось загрузить задачи");
    if (!stateRes.projects.length) await ensureStarterProject(stateRes);
    let prevLocal = null;
    try { prevLocal = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); } catch (e) { /* игнор */ }
    const local = apiStateToLocal(stateRes, usersRes.ok ? usersRes.users : [], prevLocal);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(local));
    resetSnapshot(local);
    return local;
  }

  // Считает задачи/разделы/проекты во всём состоянии — используется ниже
  // как защита от того, чтобы опрос сервера случайно не "стёр" с экрана
  // данные, которые на самом деле ещё просто не долетели до сервера (см.
  // isPushing) — даже если по какой-то другой причине эта защита не
  // сработает, опрос никогда не должен молча УМЕНЬШАТЬ количество задач.
  function countEntities(local) {
    let tasks = 0, sections = 0;
    (local.projects || []).forEach((p) => {
      tasks += (p.tasks || []).length;
      sections += (p.sections || []).length;
    });
    return { projects: (local.projects || []).length, sections, tasks };
  }

  let pollTimer = null;
  let polling = false;
  let isPushing = false; // true, пока doPush() ждёт ответы от сервера — см. push()/doPush()
  // Раз в POLL_INTERVAL_MS спрашивает у сервера, не появилось ли чего-то
  // нового от других людей (назначенная задача, изменения в своём же
  // проекте от совладельца и т.п.), и отдаёт свежие данные в app.js через
  // window.TaskingApplyExternalState — тот сам решает, применять сразу или
  // спросить (если у вас как раз есть несохранённые правки).
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      if (polling || isPushing || !window.TaskingAuth.getSession() || !window.TaskingApplyExternalState) return;
      polling = true;
      try {
        const [stateRes, usersRes] = await Promise.all([api("getState", {}), api("listUsers", {})]);
        if (!stateRes.ok) return;
        let prevLocal = null;
        try { prevLocal = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); } catch (e) { /* игнор */ }
        const fresh = apiStateToLocal(stateRes, usersRes.ok ? usersRes.users : [], prevLocal);
        // Ничего нового — не дёргаем UI зря (не меняем updatedAt, чтобы не
        // создавать ложных "конфликтов" при следующем локальном save()).
        if (prevLocal && JSON.stringify(fresh.projects) === JSON.stringify(prevLocal.projects)) return;
        // Опрос НИКОГДА не должен молча уменьшать число проектов/разделов/
        // задач на экране — если пришло МЕНЬШЕ, чем уже видно, это почти
        // наверняка означает, что часть локальных изменений ещё не успела
        // дойти до сервера (см. isPushing), а не то, что их кто-то удалил.
        // В этом случае просто пропускаем цикл и попробуем ещё раз позже.
        if (prevLocal && isPushing) return;
        if (prevLocal) {
          const before = countEntities(prevLocal);
          const after = countEntities(fresh);
          if (after.projects < before.projects || after.sections < before.sections || after.tasks < before.tasks) {
            console.warn("Опрос сервера пропущен: с сервера пришло меньше данных, чем сейчас на экране (похоже, часть изменений ещё не синхронизировалась).");
            return;
          }
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
        resetSnapshot(fresh);
        window.TaskingApplyExternalState(fresh);
      } catch (e) {
        console.error("Опрос сервера на новые данные не удался:", e);
      } finally {
        polling = false;
      }
    }, POLL_INTERVAL_MS);
  }

  // ---------- локальный формат -> API (диф и отправка) ----------

  // Снимок последнего успешно отправленного состояния каждой сущности —
  // чтобы на каждое сохранение отправлять на сервер только то, что реально
  // изменилось, а не весь список целиком.
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
      order: t.order || 0, tags: t.tags || [], dependencies: t.dependsOn || [], archived: !!t.archived
    });
  }

  let pushTimer = null;
  // Отправляет на сервер только изменившиеся с прошлого раза проекты,
  // разделы и задачи (создание НОВОГО в этот же диф тоже попадает — у него
  // просто не было записи в snapshot), а также то, что пропало из
  // локального состояния с прошлого раза (Корзина, удаление раздела/
  // проекта) — таким пропавшим id соответствующий deleteX уходит на
  // сервер. Если задачу потом восстановят из Корзины с тем же id — при
  // следующем сохранении она снова не найдётся в snapshot и будет
  // отправлена как новая (пересоздана).
  function push(state) {
    // isPushing поднимаем сразу (не дожидаясь срабатывания debounce) — это
    // и есть тот самый флаг, который не даёт опросу сервера (см.
    // startPolling выше) перезаписать экран, пока изменения ещё не
    // долетели до таблицы: см. инцидент с "исчезновением" задач сразу
    // после импорта большого JSON — опрос успевал сработать раньше, чем
    // все запросы на сохранение уходили на сервер.
    isPushing = true;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => doPush(state).catch((e) => console.error("Синхронизация с сервером не удалась:", e)), 500);
  }

  async function doPush(state) {
    try {
      if (!window.TaskingAuth.getSession()) return;
      await doPushInner(state);
    } finally {
      isPushing = false;
    }
  }

  // Выполняет thunks (функции без аргументов, возвращающие промис) не более
  // чем limit одновременно — при большом импорте изменений может набраться
  // сотня запросов сразу, а Apps Script плохо переносит такую конкурентность
  // (таймауты, случайные ошибки при параллельной записи в один лист).
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

  async function doPushInner(state) {
    const thunks = [];

    const currentProjectIds = new Set((state.projects || []).map((p) => p.id));
    const currentSectionIds = new Set();
    const currentTaskIds = new Set();
    (state.projects || []).forEach((p) => {
      (p.sections || []).forEach((s) => currentSectionIds.add(s.id));
      (p.tasks || []).forEach((t) => currentTaskIds.add(t.id));
    });

    // Удаления — раньше существовало (было в snapshot), сейчас пропало.
    Object.keys(snapshot.tasks).forEach((id) => {
      if (!currentTaskIds.has(id)) {
        thunks.push(() => api("deleteTask", { taskId: id }).then(() => { delete snapshot.tasks[id]; }));
      }
    });
    Object.keys(snapshot.sections).forEach((id) => {
      if (!currentSectionIds.has(id)) {
        thunks.push(() => api("deleteSection", { sectionId: id }).then(() => { delete snapshot.sections[id]; }));
      }
    });
    Object.keys(snapshot.projects).forEach((id) => {
      if (!currentProjectIds.has(id)) {
        thunks.push(() => api("deleteProject", { projectId: id }).then(() => { delete snapshot.projects[id]; }));
      }
    });

    // Создание/обновление.
    (state.projects || []).forEach((p) => {
      const pJson = projectPayload(p);
      if (p._canEdit !== false && snapshot.projects[p.id] !== pJson) {
        thunks.push(() => api("saveProject", { project: JSON.parse(pJson) }).then(() => { snapshot.projects[p.id] = pJson; }));
      }
      (p.sections || []).forEach((s, i) => {
        const sJson = sectionPayload(s, p.id, i);
        if (p._canEdit !== false && snapshot.sections[s.id] !== sJson) {
          thunks.push(() => api("saveSection", { section: JSON.parse(sJson) }).then(() => { snapshot.sections[s.id] = sJson; }));
        }
      });
      (p.tasks || []).forEach((t) => {
        const tJson = taskPayload(t, p.id);
        if (snapshot.tasks[t.id] !== tJson) {
          thunks.push(() => api("saveTask", { task: JSON.parse(tJson) }).then(() => { snapshot.tasks[t.id] = tJson; }));
        }
      });
    });

    await runLimited(thunks, 4);
  }

  // Помечает задачу просмотренной (снимает бейдж "новое"/"изменено") —
  // вызывается из openDetail() при открытии панели задачи. Не блокирует
  // UI: обновляет флаги в памяти сразу, а на сервер уходит в фоне.
  function markViewed(taskId) {
    if (!window.TaskingAuth.getSession()) return;
    api("markViewed", { taskId }).catch((e) => console.error("Не удалось отметить задачу просмотренной:", e));
  }

  window.TaskingSync = { pull, push, markViewed, resetSnapshot, startPolling };
})();
