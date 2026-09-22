// Весь код приложения "Задачник" находится в одном файле и обёрнут в
// самовызывающуюся функцию (IIFE), чтобы ничего не утекало в глобальную
// область видимости. Файл организован по разделам сверху вниз:
// состояние и хранение -> ссылки на DOM -> вспомогательные функции ->
// отрисовка каждого экрана/вида -> обработчики событий в самом низу.
//
// Обычный (не ES-модульный) <script> — намеренно: приложение открывают
// и через file:// (двойным кликом по index.html), а браузеры блокируют
// загрузку ES-модулей с file://. Обычные <script src="..."> такого
// ограничения не имеют, поэтому то немногое, что не завязано на
// состояние приложения (даты, escapeHtml), вынесено в отдельный файл
// js/utils.js и переиспользуется отсюда и из analytics.js через
// window.TaskingUtils — вместо буквального дублирования, как было раньше.
(function () {
  "use strict";

  const { dateToStr, strToDate, todayStr, addDays, escapeHtml } = window.TaskingUtils;

  // Ключ, под которым всё состояние приложения хранится в localStorage браузера.
  const STORAGE_KEY = "tasking-state-v1";
  // Версия СТРУКТУРЫ данных (не путать с ключом хранилища выше). Отличие от
  // простого "добавили новое поле" (это по-прежнему безопасно чинить прямо
  // в normalizeState, задавая значение по умолчанию) — сюда попадают
  // изменения, которые нельзя обработать одной строкой: переименование
  // поля, перенос данных в другое место, смена формата значения. Любое
  // такое изменение должно: 1) увеличить SCHEMA_VERSION, 2) добавить в
  // MIGRATIONS функцию-миграцию с ключом на СТАРУЮ версию (см. ниже).
  const SCHEMA_VERSION = 1;
  // Префикс ключей автоматического бэкапа состояния — делается один раз
  // перед первой же миграцией конкретной вкладки (см. migrateState), чтобы
  // при ошибке в миграции можно было руками вытащить исходные данные из
  // localStorage (DevTools -> Application -> Local Storage).
  const BACKUP_KEY_PREFIX = "tasking-backup-v";
  // Сколько таких бэкапов хранить одновременно — старые вытесняются новыми.
  const MAX_BACKUPS = 3;
  // Палитра цветов, которая по кругу раздаётся новым проектам и людям.
  const PROJECT_COLORS = ["#6d5dfc", "#2fb380", "#e0a63a", "#e2554a", "#3aa0e0", "#c957c9"];
  // Сколько последних удалённых записей хранить в корзине — чтобы она не
  // росла бесконечно и не раздувала localStorage.
  const TRASH_LIMIT = 50;
  // Заголовок проекта — contenteditable <h1>, а не обычный input, поэтому
  // ограничение длины и запрет форматирования/переносов строк приходится
  // проставлять руками (см. обработчики paste/blur у projectTitleEl).
  const PROJECT_TITLE_MAX_LEN = 200;

  // Генератор случайного уникального идентификатора для задач/проектов/людей.
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

  // ---------- состояние приложения ----------

  // Демо-данные, которые показываются при самом первом запуске (когда в
  // localStorage ещё ничего не сохранено). Наглядно демонстрируют все
  // возможности: подзадачи, подпроект, авторасчёт дат, исполнителей.
  function seedState() {
    const today = todayStr();
    const projectId = uid();
    const subProjectId = uid();
    const sTodo = uid(), sProgress = uid(), sDone = uid();
    const sSubTodo = uid(), sSubDone = uid();
    const taskWithSub = uid();
    const userAnyaId = uid();
    const userBorisId = uid();

    return {
      users: [
        { id: userAnyaId, name: "Аня", color: PROJECT_COLORS[0], weeklyHours: 40 },
        { id: userBorisId, name: "Борис", color: PROJECT_COLORS[3], weeklyHours: 20 }
      ],
      projects: [
        {
          id: projectId,
          name: "Мой первый проект",
          color: PROJECT_COLORS[0],
          parentId: null,
          sections: [
            { id: sTodo, name: "К выполнению" },
            { id: sProgress, name: "В работе" },
            { id: sDone, name: "Готово" }
          ],
          tasks: [
            { id: taskWithSub, sectionId: sTodo, parentTaskId: null, title: "Крупная задача с подзадачами", notes: "Даты начала/срока у этой задачи вычисляются автоматически по датам подзадач (как summary-задача в MS Project) — смотрите на вкладке «Гант». Можно переключить на ручной ввод в панели справа.", assigneeId: userAnyaId, start: "", due: "", datesAuto: true, priority: "medium", tags: [], estimateHours: 8, completed: false, order: 0 },
            { id: uid(), sectionId: sTodo, parentTaskId: taskWithSub, title: "Пример подзадачи", notes: "", assigneeId: null, start: addDays(today, 0), due: addDays(today, 2), datesAuto: true, priority: "low", tags: [], estimateHours: null, completed: false, order: 0 },
            { id: uid(), sectionId: sTodo, parentTaskId: taskWithSub, title: "Вторая подзадача", notes: "", assigneeId: userBorisId, start: addDays(today, 3), due: addDays(today, 5), datesAuto: true, priority: "medium", tags: [], estimateHours: 3, completed: false, order: 1 },
            { id: uid(), sectionId: sTodo, parentTaskId: null, title: "Перетащите эту карточку на другую", notes: "", assigneeId: userBorisId, start: addDays(today, 1), due: addDays(today, 2), datesAuto: true, priority: "low", tags: ["демо"], estimateHours: 4, completed: false, order: 1 },
            { id: uid(), sectionId: sProgress, parentTaskId: null, title: "Откройте «Дашборд» слева", notes: "Сводка по всем проектам и подпроектам, включая загрузку людей.", assigneeId: userAnyaId, start: addDays(today, -2), due: addDays(today, 1), datesAuto: true, priority: "medium", tags: [], estimateHours: 2, completed: false, order: 0 },
            { id: uid(), sectionId: sDone, parentTaskId: null, title: "Создать подпроект кнопкой «+» у проекта", notes: "", assigneeId: null, start: "", due: "", datesAuto: true, priority: "low", tags: [], estimateHours: null, completed: true, order: 0 }
          ]
        },
        {
          id: subProjectId,
          name: "Подпроект: дизайн",
          color: PROJECT_COLORS[1],
          parentId: projectId,
          sections: [
            { id: sSubTodo, name: "К выполнению" },
            { id: sSubDone, name: "Готово" }
          ],
          tasks: [
            { id: uid(), sectionId: sSubTodo, parentTaskId: null, title: "Это подпроект — вложен в «Мой первый проект»", notes: "", assigneeId: userBorisId, start: addDays(today, 2), due: addDays(today, 6), datesAuto: true, priority: "medium", tags: [], estimateHours: 6, completed: false, order: 0 }
          ]
        }
      ],
      activeProjectId: projectId,
      view: "board",
      showCompleted: true,
      screen: "project",
      ganttNameColWidth: 260,
      ganttDayWidth: 30,
      trash: []
    };
  }

  // migrations[N] переводит состояние из версии схемы N в версию N+1 и
  // возвращает его же (мутирует на месте). Пока схема только одна (v1 — она
  // же нынешняя, со всеми полями, которые normalizeState() ниже умеет
  // доопределять по умолчанию) — миграций ещё не было. Как только появится
  // первая по-настоящему несовместимая перестройка данных, она добавится
  // сюда же под ключом версии, ИЗ которой мигрирует.
  const MIGRATIONS = {
    // 1: (s) => { ...; return s; },
  };

  // Удаляет самые старые бэкапы сверх MAX_BACKUPS, оставляя только
  // последние (ключи бэкапа заканчиваются меткой времени, поэтому обычная
  // сортировка строк даёт хронологический порядок).
  function pruneOldBackups() {
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf(BACKUP_KEY_PREFIX) === 0) keys.push(k);
      }
      keys.sort();
      while (keys.length > MAX_BACKUPS) localStorage.removeItem(keys.shift());
    } catch (e) { /* бэкапы — подстраховка, а не критичная функциональность */ }
  }

  // Прогоняет состояние через все нужные миграции по очереди, от версии,
  // сохранённой в нём самом, до SCHEMA_VERSION. Перед первой же миграцией
  // сохраняет копию исходных (немигрированных) данных отдельным ключом в
  // localStorage — чтобы при ошибке в миграции их можно было найти и
  // восстановить руками. Если для очередной версии миграции ещё не
  // написано — останавливается как есть, не пытаясь угадать дальше.
  function migrateState(s) {
    let version = s.schemaVersion || 1;
    if (version >= SCHEMA_VERSION) {
      s.schemaVersion = SCHEMA_VERSION;
      return s;
    }
    try {
      localStorage.setItem(`${BACKUP_KEY_PREFIX}${version}-${Date.now()}`, JSON.stringify(s));
      pruneOldBackups();
    } catch (e) { /* бэкап — подстраховка, а не критичная функциональность */ }
    while (version < SCHEMA_VERSION && MIGRATIONS[version]) {
      s = MIGRATIONS[version](s);
      version++;
    }
    s.schemaVersion = version;
    return s;
  }

  // Приводит загруженные из localStorage (возможно, старые) данные к
  // актуальной структуре: прогоняет версионные миграции (см. выше), затем
  // добавляет новые поля с значениями по умолчанию, если их не было
  // (например, когда приложение обновилось и в сохранённых задачах ещё нет
  // поля "datesAuto"), и переносит старое текстовое поле "исполнитель" в
  // новый справочник людей.
  function normalizeState(s) {
    s = migrateState(s);
    if (!Array.isArray(s.users)) s.users = [];
    s.projects.forEach((p) => {
      if (p.parentId === undefined) p.parentId = null;
      if (!Array.isArray(p.members)) p.members = [];
      p.tasks.forEach((t) => {
        if (t.parentTaskId === undefined) t.parentTaskId = null;
        if (t.assigneeId === undefined) {
          if (t.assignee) {
            let u = s.users.find((u2) => u2.name === t.assignee);
            if (!u) {
              u = { id: uid(), name: t.assignee, color: PROJECT_COLORS[s.users.length % PROJECT_COLORS.length], weeklyHours: 40 };
              s.users.push(u);
            }
            t.assigneeId = u.id;
          } else {
            t.assigneeId = null;
          }
        }
        delete t.assignee;
        if (t.start === undefined) t.start = "";
        if (t.estimateHours === undefined) t.estimateHours = null;
        if (t.datesAuto === undefined) t.datesAuto = true;
        if (!Array.isArray(t.dependsOn)) t.dependsOn = [];
        if (!Array.isArray(t.tags)) t.tags = [];
        if (!Array.isArray(t.watchers)) t.watchers = [];
        if (t.archived === undefined) t.archived = false;
      });
    });
    if (!s.screen) s.screen = "project";
    if (!s.view) s.view = "board";
    if (!s.ganttNameColWidth) s.ganttNameColWidth = 260;
    if (!s.ganttDayWidth) s.ganttDayWidth = 30;
    if (!Array.isArray(s.trash)) s.trash = [];
    // Вид и "показывать выполненные" — отдельно для каждого проекта (см.
    // saveUiPrefsForProject/loadUiPrefsForProject); свёрнутость сайдбара и
    // деревьев задач — сквозная, но должна переживать перезагрузку страницы.
    if (!s.uiByProject || typeof s.uiByProject !== "object") s.uiByProject = {};
    if (!Array.isArray(s.collapsedProjectIds)) s.collapsedProjectIds = [];
    if (!Array.isArray(s.collapsedTaskIds)) s.collapsedTaskIds = [];
    // Метка времени последней записи — нужна, чтобы разные вкладки могли
    // заметить, что где-то ещё сохранили более новую версию (см. save()/
    // flushSave() и обработчик "storage" ниже).
    if (!s.updatedAt) s.updatedAt = Date.now();
    return s;
  }

  // Читает состояние из localStorage при старте страницы; если там пусто
  // или данные повреждены — возвращает демо-данные (seedState).
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        // Пустой массив projects — это ЗАКОННОЕ состояние (например, только
        // что вошедший пользователь без единой своей/назначенной задачи,
        // см. js/sync.js), а не признак "тут ничего не сохранено". Раньше
        // пустой массив тоже уходил в демо-данные — это было бы не только
        // не к месту при входе через API, но и странно для обычного
        // локального пользователя, удалившего последний проект.
        if (parsed && Array.isArray(parsed.projects)) return normalizeState(parsed);
      }
    } catch (e) { /* повреждённые данные в хранилище — просто начинаем заново */ }
    return normalizeState(seedState());
  }

  // Главный объект состояния всего приложения (проекты, задачи, люди и
  // текущий экран/вид). Живёт в памяти и на каждое изменение сохраняется
  // в localStorage функцией save().
  let state = loadState();
  // ---------- история отмены/повтора (Ctrl+Z / Ctrl+Shift+Z) ----------
  // Объявлены здесь (а не рядом с функциями undo()/redo() ниже), потому что
  // baselineSnapshot нужно проинициализировать сразу после state, до первого
  // вызова save(). Сами функции — см. блок сразу после commit().
  const UNDO_LIMIT = 50;
  const CHECKPOINT_DEBOUNCE_MS = 500;
  let undoStack = [];
  let redoStack = [];
  let checkpointTimer = null;
  let baselineSnapshot = contentSnapshot(state);
  let openTaskId = null;// id задачи, открытой в панели деталей справа (или null)
  let openTaskProjectId = null;   // id проекта, которому принадлежит открытая задача (может отличаться от активного проекта — см. findTaskOwnerProject)
  let dragTaskId = null;          // id задачи, которую сейчас перетаскивают мышью
  let dragProjectId = null;       // id проекта, который сейчас перетаскивают в сайдбаре
  let addingTaskSection = null;   // id раздела, где сейчас открыта строка быстрого добавления задачи
  let addingProject = false;      // открыта ли строка добавления нового (глобального) проекта
  let addingSubprojectOf = null;  // id проекта, для которого сейчас открыта строка добавления подпроекта
  let collapsedProjects = new Set(state.collapsedProjectIds);  // какие проекты свёрнуты в дереве сайдбара (переживает перезагрузку — см. state.collapsedProjectIds)
  let collapsedTreeTasks = new Set(state.collapsedTaskIds); // какие задачи свёрнуты в видах "Дерево"/"Структура"/"Гант" (state.collapsedTaskIds)
  let skipNextBlur = false;       // служебный флаг, чтобы не закрывать поле ввода дважды при Enter+blur подряд
  let lastUiProjectId = null;     // id проекта, для которого сейчас загружены state.view/showCompleted (см. saveUiPrefsForProject)

  // Сворачивает/разворачивает проект в дереве сайдбара и сразу планирует
  // сохранение (см. save()) — раньше collapsedProjects жил только в памяти
  // вкладки и терялся при перезагрузке страницы.
  function setProjectCollapsed(id, collapsed) {
    if (collapsed) collapsedProjects.add(id); else collapsedProjects.delete(id);
    state.collapsedProjectIds = [...collapsedProjects];
    save();
  }

  // То же самое для свёрнутости задач в видах "Дерево"/"Структура"/"Гант".
  function setTreeTaskCollapsed(id, collapsed) {
    if (collapsed) collapsedTreeTasks.add(id); else collapsedTreeTasks.delete(id);
    state.collapsedTaskIds = [...collapsedTreeTasks];
    save();
  }

  // Снимок вида/фильтра "показывать выполненные" для одного проекта —
  // раньше state.view/state.showCompleted были общими на все проекты сразу,
  // и переключение проекта сбрасывало привычную настройку.
  function saveUiPrefsForProject(projectId) {
    if (!projectId) return;
    state.uiByProject[projectId] = { view: state.view, showCompleted: state.showCompleted };
  }

  function loadUiPrefsForProject(projectId) {
    const prefs = state.uiByProject[projectId];
    // Если для этого проекта ещё ничего не сохранялось (первый рендер после
    // загрузки/импорта состояния, или проект, который ни разу не открывали
    // после этой правки) — не трогаем state.view/showCompleted: они уже
    // несут то значение, с которым состояние было загружено, и сбрасывать
    // его на дефолт "board" здесь было бы неверно.
    if (!prefs) return;
    state.view = prefs.view || "board";
    state.showCompleted = !!prefs.showCompleted;
  }

  // Переключает активный проект, сохраняя view/showCompleted старого и
  // загружая сохранённые для нового (см. выше) — используется там, где сразу
  // после переключения нужно ещё и принудительно выставить конкретный вид
  // (forcedView), не дав его тут же перезаписать сохранёнными префами.
  // Места, где после смены activeProjectId вид не форсируется, в этот
  // хелпер заворачивать не нужно — тот же перезапуск prefs произойдёт лениво
  // в начале renderAll().
  function switchActiveProject(projectId, forcedView) {
    if (state.activeProjectId !== projectId) {
      if (state.activeProjectId) saveUiPrefsForProject(state.activeProjectId);
      state.activeProjectId = projectId;
      loadUiPrefsForProject(projectId);
      lastUiProjectId = projectId;
    }
    if (forcedView) state.view = forcedView;
  }

  // Увеличивается при каждом изменении данных (см. save()/replaceState()) —
  // по нему инвалидируются кэши в getSubtasks()/getEffectiveDates() ниже:
  // пока это число не изменилось, состояние гарантированно то же самое,
  // что и на предыдущий рендер, и пересчитывать индексы заново не нужно.
  let stateVersion = 0;

  // Показываем предупреждение о неудачном сохранении не чаще одного раза за
  // "сессию ошибок" — иначе при частых изменениях модалка всплывала бы на
  // каждый клик, пока хранилище переполнено.
  let saveErrorShown = false;
  // Таймер отложенной записи в localStorage — см. save()/flushSave() ниже.
  let saveTimer = null;
  // Есть ли изменения в памяти, которые ещё не записаны в localStorage —
  // используется, чтобы не затереть молча более свежую версию, которую
  // тем временем сохранила другая открытая вкладка (см. ниже).
  let dirty = false;
  // state.updatedAt той версии, которую эта вкладка последний раз записала
  // или считала своей "текущей". Если в localStorage появляется версия с
  // другим updatedAt — значит, её сохранила другая вкладка.
  let lastAppliedUpdatedAt = state.updatedAt;
  // Версия состояния из другой вкладки, которую предложили применить через
  // тост, пока пользователь не подтвердил (см. applyExternalState).
  let pendingExternalState = null;

  // Полностью заменяет состояние в памяти на newState (используется и при
  // импорте JSON-файла, и при подхвате версии, сохранённой другой
  // вкладкой) — закрывает открытые панели (их содержимое могло исчезнуть
  // или устареть) и сбрасывает то, что осмысленно только для старого
  // состояния (свёрнутые ветки дерева, "грязный" флаг).
  function replaceState(newState) {
    closeDetail();
    closeProjectAnalytics();
    state = normalizeState(newState);
    lastAppliedUpdatedAt = state.updatedAt;
    dirty = false;
    stateVersion++;
    collapsedProjects = new Set(state.collapsedProjectIds);
    collapsedTreeTasks = new Set(state.collapsedTaskIds);
    lastUiProjectId = null; // заставит renderAll() перечитать view/showCompleted для активного проекта заново
    if (!state.projects.some((p) => p.id === state.activeProjectId)) {
      state.activeProjectId = state.projects[0].id;
    }
    resetUndoHistory(); // импорт/чужая вкладка — отменять переход к этому состоянию бессмысленно
  }

  // Пришла версия состояния, сохранённая другой открытой вкладкой (через
  // событие "storage" или через обнаруженный конфликт при записи — см.
  // flushSave). Если в ЭТОЙ вкладке нет собственных несохранённых
  // изменений — можно спокойно подхватить её сразу. Если есть — молча
  // подменять их нельзя (пользователь может как раз что-то печатать),
  // поэтому показываем тост и ждём явного решения.
  function applyExternalState(incoming) {
    if (dirty) {
      pendingExternalState = incoming;
      showToast(
        "Данные изменились в другой открытой вкладке — здесь есть несохранённые правки, поэтому автоматически они не подхвачены",
        () => {
          const toApply = pendingExternalState;
          pendingExternalState = null;
          if (!toApply) return;
          if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
          replaceState(toApply);
          renderAll();
        },
        "Обновить",
        15000
      );
      return;
    }
    pendingExternalState = null;
    replaceState(incoming);
    renderAll();
  }

  // js/sync.js периодически опрашивает сервер (другие люди могли что-то
  // поменять) и, если данные новее, отдаёт их сюда через этот же самый
  // механизм, что и обычная межвкладочная синхронизация — значит,
  // несохранённые правки не затираются молча, а спрашиваются через тост.
  window.TaskingApplyExternalState = applyExternalState;

  // Действительно пишет состояние в localStorage прямо сейчас (без
  // задержки) и обрабатывает ошибку переполнения/недоступности хранилища.
  // force=true пропускает проверку конфликта с другой вкладкой (см. ниже) —
  // нужно там, где state только что был осознанно заменён целиком (импорт
  // JSON) и его в любом случае необходимо записать поверх того, что сейчас
  // лежит в localStorage, а не подхватывать это старое содержимое обратно.
  function flushSave(force) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    saveUiPrefsForProject(state.activeProjectId);
    try {
      // Прежде чем писать поверх — проверяем, что в хранилище всё ещё та
      // версия, от которой мы отталкивались. Если нет (другая вкладка
      // успела сохраниться раньше нас), не затираем её молча.
      const existingRaw = force ? null : localStorage.getItem(STORAGE_KEY);
      if (existingRaw) {
        let existing = null;
        try { existing = JSON.parse(existingRaw); } catch (e) { existing = null; }
        if (existing && Array.isArray(existing.projects) && existing.updatedAt !== undefined && existing.updatedAt !== lastAppliedUpdatedAt) {
          applyExternalState(existing);
          return;
        }
      }
      state.updatedAt = Date.now();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      lastAppliedUpdatedAt = state.updatedAt;
      dirty = false;
      // Синхронизация с сервером (js/sync.js) — если приложение открыто с
      // входом (не гостевой локальный режим), эта же единая точка
      // сохранения отправляет изменённые проекты/разделы/задачи в API.
      if (window.TaskingSync) window.TaskingSync.push(state);
    } catch (e) {
      console.error("Не удалось сохранить состояние в localStorage:", e);
      if (!saveErrorShown) {
        saveErrorShown = true;
        showAlert("Не удалось сохранить изменения — не хватает места в хранилище браузера (или оно недоступно). Текущие изменения видны на экране, но пропадут при перезагрузке страницы. Откройте «Корзину» и очистите её кнопкой «Очистить корзину», чтобы освободить место.")
          .then(() => { saveErrorShown = false; });
      }
    }
  }

  // Помечает состояние как изменённое — вызывается после КАЖДОГО изменения
  // данных, зачастую по многу раз подряд (перетаскивание, печать в поле,
  // движение ползунка масштаба Ганта). Сама запись в localStorage при этом
  // не выполняется мгновенно, а откладывается на короткую паузу и
  // объединяет соседние вызовы в одну запись — экран всегда отражает
  // актуальное состояние (renderAll читает его из памяти, а не из
  // хранилища), поэтому задержка самой записи на диск не видна пользователю.
  function save() {
    dirty = true;
    stateVersion++;
    noteContentChange();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 400);
  }

  // Единая точка фиксации изменений: раньше почти каждый обработчик
  // заканчивался вручную набранной парой save() + renderAll(...), и было
  // легко забыть одно из двух или перепутать renderAll()/renderAll(true).
  // commit() — то же самое одним вызовом; используется везде, где после
  // мутации данных нужен обычный полный рендер (для более точечных
  // перерисовок — например, только сайдбара при переименовании проекта,
  // или только Ганта при изменении масштаба — по-прежнему используются
  // save() и нужная render-функция напрямую, без commit()). Как единая
  // точка, через которую проходит любое обычное изменение состояния, это
  // естественное место для будущей истории изменений (отмена/повтор) — см.
  // блок отмены/повтора сразу ниже, построенный поверх save().
  function commit(keepDetail) {
    save();
    renderAll(keepDetail);
  }

  // Проверено вручную (2026): оставшиеся ~20 мест, где мутация проекта
  // вызывает save() без немедленного commit()/renderAll() тут же рядом —
  // это функции-хелперы (createTask, addDependency/removeDependency,
  // reorderProject, nestTaskUnder, reorderTask и т.п.), и каждый их
  // вызывающий код рендерит сам, часто составным рендером (например,
  // renderAll(true) + renderSubtaskSection()), которого commit() один
  // сделать не может. Других мест, где save() был бы вызван без рендера
  // где-либо после него, не найдено — сводить их в commit() насильно
  // не стал: часть из них (например, сброс перетаскивания в сайдбаре)
  // сохраняет данные УСЛОВНО, а перерисовывает БЕЗУСЛОВНО (чтобы снять
  // визуальное состояние драга даже когда данные не менялись), и
  // механическая замена на commit() слегка изменила бы это поведение.

  // ---------- отмена/повтор действий (Ctrl+Z / Ctrl+Shift+Z) ----------
  // save() вызывается после любого содержательного изменения данных (см.
  // комментарий выше), так что это и есть тот самый единый шлюз, через
  // который проходит вообще всё, что стоит уметь отменять — не нужно
  // отдельно помечать каждое место мутации. Историю не снимаем со всего
  // state целиком: заголовок окна, текущий вид, фильтры, свёрнутые ветки
  // дерева и ширина колонок Ганта — это настройки экрана, а не данные
  // пользователя, и отменять их вместе с содержимым задач было бы странно
  // (сдвинул ползунок масштаба — и вдруг открылся другой проект). Сами
  // переменные (undoStack, redoStack, baselineSnapshot, checkpointTimer,
  // UNDO_LIMIT, CHECKPOINT_DEBOUNCE_MS) объявлены раньше, сразу после state.

  function contentSnapshot(s) {
    return JSON.stringify({ projects: s.projects, users: s.users, trash: s.trash, activeProjectId: s.activeProjectId });
  }

  // Сбрасывает всю историю отмены и берёт текущее состояние за новую
  // отправную точку — используется, когда состояние подменяется целиком и
  // не имеет смысла "отменять" переход к нему (импорт JSON, применение
  // версии из другой вкладки).
  function resetUndoHistory() {
    if (checkpointTimer) { clearTimeout(checkpointTimer); checkpointTimer = null; }
    undoStack = [];
    redoStack = [];
    baselineSnapshot = contentSnapshot(state);
  }

  function scheduleCheckpointSettle() {
    if (checkpointTimer) clearTimeout(checkpointTimer);
    checkpointTimer = setTimeout(() => {
      checkpointTimer = null;
      baselineSnapshot = contentSnapshot(state);
    }, CHECKPOINT_DEBOUNCE_MS);
  }

  // Вызывается из save() при каждом изменении данных. Если реального
  // изменения "содержимого" (в отличие от настроек экрана) не произошло —
  // ничего не делает. Если произошло и это первое изменение новой серии —
  // фиксирует состояние ДО неё как шаг для отмены.
  function noteContentChange() {
    const snap = contentSnapshot(state);
    if (snap === baselineSnapshot) return;
    if (checkpointTimer === null) {
      undoStack.push(baselineSnapshot);
      if (undoStack.length > UNDO_LIMIT) undoStack.shift();
      redoStack = [];
    }
    scheduleCheckpointSettle();
  }

  function applyContentSnapshot(snapJson) {
    const data = JSON.parse(snapJson);
    state.projects = data.projects;
    state.users = data.users;
    state.trash = data.trash;
    state.activeProjectId = state.projects.some((p) => p.id === data.activeProjectId) ? data.activeProjectId : state.projects[0].id;
  }

  function undo() {
    if (!undoStack.length) { showToast("Нечего отменять"); return; }
    if (checkpointTimer) { clearTimeout(checkpointTimer); checkpointTimer = null; }
    const current = contentSnapshot(state);
    const prev = undoStack.pop();
    redoStack.push(current);
    if (redoStack.length > UNDO_LIMIT) redoStack.shift();
    applyContentSnapshot(prev);
    baselineSnapshot = prev;
    commit();
    showToast("Отменено", () => redo(), "Повторить");
  }

  function redo() {
    if (!redoStack.length) { showToast("Нечего повторять"); return; }
    if (checkpointTimer) { clearTimeout(checkpointTimer); checkpointTimer = null; }
    const current = contentSnapshot(state);
    const next = redoStack.pop();
    undoStack.push(current);
    applyContentSnapshot(next);
    baselineSnapshot = next;
    commit();
    showToast("Повторено");
  }

  // Если вкладку закрывают до истечения задержки — дописываем сразу же,
  // чтобы последние несохранённые изменения не потерялись. Исключение —
  // когда сейчас показан тост с предложением подхватить версию из другой
  // вкладки: тогда лучше промолчать (потерять правки этой вкладки), чем
  // записать их поверх более новой версии, которую пользователь ещё не
  // успел применить.
  window.addEventListener("beforeunload", () => {
    if (dirty && !pendingExternalState) flushSave();
  });

  // Другая открытая вкладка этого же приложения сохранила изменения —
  // событие "storage" срабатывает только в ДРУГИХ вкладках (не в той, что
  // сама записала localStorage), так что здесь можно быть уверенным, что
  // это действительно чужое изменение, а не эхо собственного.
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY || !e.newValue) return;
    let incoming;
    try {
      incoming = JSON.parse(e.newValue);
    } catch (err) {
      return;
    }
    if (!incoming || !Array.isArray(incoming.projects) || incoming.updatedAt === lastAppliedUpdatedAt) return;
    applyExternalState(incoming);
  });

  // Проект, который сейчас открыт на экране (или первый попавшийся, если
  // активный id почему-то не найден).
  function getActiveProject() {
    return state.projects.find((p) => p.id === state.activeProjectId) || state.projects[0];
  }

  // Проект, которому реально принадлежит задача с этим id. Нужен, потому
  // что виды "Структура" и "Гантт" показывают задачи не только активного
  // проекта, но и всех его подпроектов — простое getActiveProject() для
  // такой задачи вернёт не тот проект, и её данные просто не найдутся.
  function findTaskOwnerProject(taskId) {
    return state.projects.find((p) => p.tasks.some((t) => t.id === taskId)) || null;
  }

  // ---------- ссылки на элементы страницы (DOM) ----------
  // Один раз находим все нужные HTML-элементы по id и складываем в
  // константы — дальше по коду обращаемся к ним напрямую, без повторного
  // document.getElementById().

  const projectListEl = document.getElementById("projectList");
  const addProjectBtn = document.getElementById("addProjectBtn");
  const addProjectInline = document.getElementById("addProjectInline");
  const addProjectInput = document.getElementById("addProjectInput");
  const deleteProjectBtn = document.getElementById("deleteProjectBtn");
  const showCompletedToggle = document.getElementById("showCompletedToggle");
  const exportDataBtn = document.getElementById("exportDataBtn");
  const importDataBtn = document.getElementById("importDataBtn");
  const importDataInput = document.getElementById("importDataInput");
  const dashboardNavBtn = document.getElementById("dashboardNavBtn");
  const peopleNavBtn = document.getElementById("peopleNavBtn");
  const trashNavBtn = document.getElementById("trashNavBtn");
  const trashCountEl = document.getElementById("trashCount");
  const archiveNavBtn = document.getElementById("archiveNavBtn");
  const archiveCountEl = document.getElementById("archiveCount");
  const unreadCountEl = document.getElementById("unreadCount");
  const archiveCompletedBtn = document.getElementById("archiveCompletedBtn");
  const membersToggleBtn = document.getElementById("membersToggleBtn");
  const membersPanel = document.getElementById("membersPanel");
  const membersList = document.getElementById("membersList");

  const modalOverlay = document.getElementById("modalOverlay");
  const modalMessage = document.getElementById("modalMessage");
  const modalActions = document.getElementById("modalActions");

  const topbar = document.getElementById("topbar");
  const projectTitleEl = document.getElementById("projectTitle");
  const currentProjectDot = document.getElementById("currentProjectDot");
  const searchInput = document.getElementById("searchInput");
  const filterToggleBtn = document.getElementById("filterToggleBtn");
  const filterCountEl = document.getElementById("filterCount");
  const filterPanel = document.getElementById("filterPanel");
  const filterAssignee = document.getElementById("filterAssignee");
  const filterPriority = document.getElementById("filterPriority");
  const filterDue = document.getElementById("filterDue");
  const filterTag = document.getElementById("filterTag");
  const filterResetBtn = document.getElementById("filterResetBtn");
  const viewSwitch = document.getElementById("viewSwitch");

  const boardWrap = document.getElementById("boardWrap");
  const boardEl = document.getElementById("board");
  const listWrap = document.getElementById("listWrap");
  const listEl = document.getElementById("list");
  const treeWrap = document.getElementById("treeWrap");
  const treeEl = document.getElementById("tree");
  const treeCollapseAllBtn = document.getElementById("treeCollapseAllBtn");
  const treeExpandAllBtn = document.getElementById("treeExpandAllBtn");
  const ganttWrap = document.getElementById("ganttWrap");
  const ganttEl = document.getElementById("gantt");
  const ganttZoomSlider = document.getElementById("ganttZoomSlider");
  const ganttZoomValueEl = document.getElementById("ganttZoomValue");
  const ganttZoomOutBtn = document.getElementById("ganttZoomOutBtn");
  const ganttZoomInBtn = document.getElementById("ganttZoomInBtn");
  const ganttCollapseAllBtn = document.getElementById("ganttCollapseAllBtn");
  const ganttExpandAllBtn = document.getElementById("ganttExpandAllBtn");
  const dashboardWrap = document.getElementById("dashboardWrap");
  const dashboardEl = document.getElementById("dashboard");
  const peopleWrap = document.getElementById("peopleWrap");
  const peopleEl = document.getElementById("people");
  const trashWrap = document.getElementById("trashWrap");
  const trashEl = document.getElementById("trash");
  const archiveWrap = document.getElementById("archiveWrap");
  const archiveEl = document.getElementById("archive");

  const detailPanel = document.getElementById("detailPanel");
  const detailBreadcrumb = document.getElementById("detailBreadcrumb");
  const detailReadonlyBanner = document.getElementById("detailReadonlyBanner");
  const detailComplete = document.getElementById("detailComplete");
  const detailClose = document.getElementById("detailClose");
  const detailTitle = document.getElementById("detailTitle");
  const detailSection = document.getElementById("detailSection");
  const detailAssignee = document.getElementById("detailAssignee");
  const detailWatchers = document.getElementById("detailWatchers");
  const detailStart = document.getElementById("detailStart");
  const detailDue = document.getElementById("detailDue");
  const datesAutoRow = document.getElementById("datesAutoRow");
  const datesAutoText = document.getElementById("datesAutoText");
  const datesAutoToggleBtn = document.getElementById("datesAutoToggleBtn");
  const detailPriority = document.getElementById("detailPriority");
  const detailEstimate = document.getElementById("detailEstimate");
  const detailAutoTags = document.getElementById("detailAutoTags");
  const detailTags = document.getElementById("detailTags");
  const detailNotes = document.getElementById("detailNotes");
  const detailDelete = document.getElementById("detailDelete");
  const subtaskProgress = document.getElementById("subtaskProgress");
  const subtaskList = document.getElementById("subtaskList");
  const subtaskAddInput = document.getElementById("subtaskAddInput");
  const depsList = document.getElementById("depsList");
  const depsAddSelect = document.getElementById("depsAddSelect");
  const conflictWarning = document.getElementById("conflictWarning");
  const dateOrderWarning = document.getElementById("dateOrderWarning");
  const analyticsPanel = document.getElementById("analyticsPanel");
  const analyticsTitle = document.getElementById("analyticsTitle");
  const analyticsBody = document.getElementById("analyticsBody");
  const analyticsClose = document.getElementById("analyticsClose");
  const toastEl = document.getElementById("toast");
  const toastMessageEl = document.getElementById("toastMessage");
  const toastUndoBtn = document.getElementById("toastUndoBtn");
  const paletteOverlay = document.getElementById("paletteOverlay");
  const paletteInput = document.getElementById("paletteInput");
  const paletteResults = document.getElementById("paletteResults");

  // ---------- вспомогательные функции ----------

  // Дата "ГГГГ-ММ-ДД" -> короткая подпись "ДД.ММ" для бейджей на карточках.
  function formatDue(due) {
    if (!due) return "";
    const [, m, d] = due.split("-");
    return `${d}.${m}`;
  }

  // ---------- кэш дерева подзадач (см. stateVersion выше) ----------
  // getSubtasks()/getEffectiveDates() раньше пересчитывались линейным
  // поиском по всем задачам проекта на КАЖДЫЙ вызов — а вызываются они
  // рекурсивно и по многу раз за один рендер (для каждой строки списка,
  // дерева, Ганта, дашборда, аналитики). На большом числе задач это
  // становится заметно медленно. Вместо этого индекс "id родителя -> его
  // подзадачи" и кэш вычисленных дат строятся один раз и переиспользуются,
  // пока stateVersion не изменится (то есть пока данные реально те же).
  // Дети всегда лежат в том же проекте, что и родитель (см. createSubtask),
  // поэтому индекс общий для всех проектов сразу — искать по taskId
  // (глобально уникальному) в нём можно без привязки к конкретному proj.
  let childrenIndex = null;
  let childrenIndexVersion = -1;
  let effectiveDatesCache = null;
  let effectiveDatesCacheVersion = -1;
  // Кэш getProjectStats()/getUserStats() (см. их определения ниже) — те же
  // числа сейчас пересчитываются с нуля на каждый вызов, а вызываются они
  // по разу на КАЖДУЮ строку сайдбара/дашборда/справочника людей за один
  // renderAll(). Инвалидация по stateVersion, как и остальные кэши здесь, +
  // отдельно по календарному дню: "просрочено" зависит от todayStr(), а не
  // только от данных, поэтому если вкладка простояла открытой через
  // полночь без единого изменения — кэш всё равно должен обновиться.
  let statsCache = null; // Map: "project:ID" | "user:ID" -> посчитанная статистика
  let statsCacheVersion = -1;
  let statsCacheDay = "";

  function getStatsCache() {
    const today = todayStr();
    if (statsCache && statsCacheVersion === stateVersion && statsCacheDay === today) return statsCache;
    statsCache = new Map();
    statsCacheVersion = stateVersion;
    statsCacheDay = today;
    return statsCache;
  }

  function getChildrenIndex() {
    if (childrenIndex && childrenIndexVersion === stateVersion) return childrenIndex;
    childrenIndex = new Map();
    state.projects.forEach((p) => {
      p.tasks.forEach((t) => {
        if (!t.parentTaskId) return;
        let arr = childrenIndex.get(t.parentTaskId);
        if (!arr) { arr = []; childrenIndex.set(t.parentTaskId, arr); }
        arr.push(t);
      });
    });
    childrenIndexVersion = stateVersion;
    return childrenIndex;
  }

  // Немедленно инвалидирует кэши дерева подзадач, не дожидаясь следующего
  // save() (который меняет stateVersion). Нужен в тех редких местах, где
  // после прямого изменения parentTaskId код в ЭТОЙ ЖЕ функции снова читает
  // дерево через getSubtasks()/getEffectiveDates() — без явного сброса он
  // увидел бы состояние ДО этого изменения.
  function invalidateTreeCache() {
    childrenIndexVersion = -1;
    effectiveDatesCacheVersion = -1;
  }

  // Задача с подзадачами ведёт себя как "суммарная задача" в MS Project: по
  // умолчанию её начало/срок вычисляются по датам вложенных задач (самое
  // раннее начало и самый поздний срок среди всех потомков, рекурсивно).
  // Если у задачи выставлено datesAuto=false — берём её собственные даты и
  // авторасчёт для неё не работает (ручной режим, включается кнопкой в
  // панели деталей).
  function getEffectiveDates(proj, task) {
    if (!effectiveDatesCache || effectiveDatesCacheVersion !== stateVersion) {
      effectiveDatesCache = new Map();
      effectiveDatesCacheVersion = stateVersion;
    }
    const cached = effectiveDatesCache.get(task.id);
    if (cached) return cached;

    const subs = getSubtasks(proj, task.id);
    let result;
    if (task.datesAuto !== false && subs.length) {
      const starts = [], dues = [];
      subs.forEach((s) => {
        const eff = getEffectiveDates(proj, s);
        if (eff.start) starts.push(eff.start);
        if (eff.due) dues.push(eff.due);
      });
      result = {
        start: starts.length ? starts.reduce((a, b) => (a < b ? a : b)) : "",
        due: dues.length ? dues.reduce((a, b) => (a > b ? a : b)) : "",
        auto: true
      };
    } else {
      result = { start: task.start || "", due: task.due || "", auto: false };
    }
    effectiveDatesCache.set(task.id, result);
    return result;
  }

  // Просрочена ли задача: срок (с учётом авторасчёта по подзадачам) уже
  // прошёл, а задача не отмечена выполненной.
  function isOverdue(proj, task) {
    const due = getEffectiveDates(proj, task).due;
    return !!due && !task.completed && due < todayStr();
  }

  // "Иван Петров" -> "ИП", для кружка-аватара.
  function initials(name) {
    if (!name) return "";
    const parts = name.trim().split(/\s+/);
    return (parts[0][0] + (parts[1] ? parts[1][0] : "")).toUpperCase();
  }

  // Код приоритета ("low"/"medium"/"high") -> подпись на русском.
  function priorityLabel(p) {
    return { low: "Низкий", medium: "Средний", high: "Высокий" }[p] || "";
  }

  // Находит человека из справочника по id.
  function getUser(id) {
    return state.users.find((u) => u.id === id) || null;
  }

  // Имя исполнителя задачи (или пустая строка, если не назначен).
  function assigneeName(task) {
    const u = getUser(task.assigneeId);
    return u ? u.name : "";
  }

  // Сколько открытых (не выполненных) задач у человека и сколько часов
  // на них суммарно оценено — используется в справочнике людей и на дашборде.
  function getUserStats(userId) {
    const cache = getStatsCache();
    const key = `user:${userId}`;
    if (cache.has(key)) return cache.get(key);
    let openTasks = 0, totalHours = 0;
    state.projects.forEach((p) => p.tasks.forEach((t) => {
      if (t.assigneeId === userId && !t.completed) {
        openTasks++;
        totalHours += Number(t.estimateHours) || 0;
      }
    }));
    const result = { openTasks, totalHours };
    cache.set(key, result);
    return result;
  }

  // ---------- фильтры (по исполнителю/приоритету/сроку/тегу) ----------
  // Дополняют текстовый поиск — применяются одинаково во всех видах
  // (доска/список/по статусам/структура/Гант), см. matchesSearch() ниже.
  // Не сохраняются в localStorage: это временная настройка просмотра, а
  // не долгоживущее предпочтение (как, например, showCompleted).
  let activeFilters = { assigneeId: "", priority: "", due: "", tag: "" };

  function filtersActiveCount() {
    return Object.values(activeFilters).filter(Boolean).length;
  }

  // Подходит ли задача под текущие фильтры (без учёта текстового поиска).
  function taskMatchesFilters(proj, task) {
    if (activeFilters.assigneeId) {
      if (activeFilters.assigneeId === "none") {
        if (task.assigneeId) return false;
      } else if (task.assigneeId !== activeFilters.assigneeId) {
        return false;
      }
    }
    if (activeFilters.priority && (task.priority || "medium") !== activeFilters.priority) return false;
    if (activeFilters.tag && !task.tags.includes(activeFilters.tag)) return false;
    if (activeFilters.due) {
      const eff = getEffectiveDates(proj, task);
      if (activeFilters.due === "overdue") {
        if (!isOverdue(proj, task)) return false;
      } else if (activeFilters.due === "week") {
        if (!eff.due || eff.due < todayStr() || eff.due > addDays(todayStr(), 7)) return false;
      } else if (activeFilters.due === "none") {
        if (eff.due) return false;
      }
    }
    return true;
  }

  // Подходит ли задача под текст поиска И под активные фильтры (ищем по
  // названию, заметкам, имени исполнителя и тегам).
  function matchesSearch(proj, task, q) {
    if (!taskMatchesFilters(proj, task)) return false;
    if (!q) return true;
    const autoTagText = autoTagsFor(proj, task).map((t) => t.label).join(" ");
    const hay = (task.title + " " + task.notes + " " + assigneeName(task) + " " + task.tags.join(" ") + " " + autoTagText).toLowerCase();
    return hay.includes(q.toLowerCase());
  }

  // ---------- автоматические метки (проект + родительская задача) ----------
  // Не хранятся в task.tags — вычисляются на лету по текущему положению
  // задачи (проект + parentTaskId), поэтому при переносе задачи, вложении
  // её в другую или переименовании проекта/родителя они всегда актуальны
  // сами по себе и никогда не путаются с тегами, которые ввёл пользователь.
  function autoTagsFor(proj, task) {
    const tags = [{ cls: "tag-chip-auto-project", icon: "📁", label: proj.name }];
    if (task.parentTaskId) {
      const parent = proj.tasks.find((t) => t.id === task.parentTaskId);
      if (parent) tags.push({ cls: "tag-chip-auto-parent", icon: "↳", label: parent.title });
    }
    return tags;
  }

  function autoTagsHtml(proj, task) {
    return autoTagsFor(proj, task)
      .map((t) => `<span class="tag-chip tag-chip-auto ${t.cls}" title="${t.cls === "tag-chip-auto-project" ? "Проект" : "Родительская задача"}">${t.icon} ${escapeHtml(t.label)}</span>`)
      .join("");
  }

  // ---------- работа с деревом задач и подзадач ----------

  // Прямые подзадачи (дети) данной задачи.
  function getSubtasks(proj, taskId) {
    return getChildrenIndex().get(taskId) || [];
  }

  // id самой задачи + id всех её подзадач на любую глубину вложенности —
  // используется при удалении, чтобы удалить всё поддерево целиком.
  function getTaskDescendantIds(proj, taskId) {
    const ids = [taskId];
    getSubtasks(proj, taskId).forEach((c) => ids.push(...getTaskDescendantIds(proj, c.id)));
    return ids;
  }

  // Является ли candidateId самим potentialAncestorId или его потомком —
  // используется, чтобы запретить вложить задачу саму в себя/в свою подзадачу.
  function isDescendantTaskOf(candidateId, potentialAncestorId) {
    const proj = findTaskOwnerProject(candidateId);
    if (!proj) return false;
    let t = proj.tasks.find((x) => x.id === candidateId);
    while (t) {
      if (t.id === potentialAncestorId) return true;
      t = t.parentTaskId ? proj.tasks.find((x) => x.id === t.parentTaskId) : null;
    }
    return false;
  }

  // ---------- связи "сначала выполнить" (предшественник → преемник, как в MS Project) ----------
  // dependsOn хранит id задач-предшественников: task не должна начинаться
  // раньше, чем они завершатся. Связи — только внутри одного проекта (там
  // же, где обе задачи физически лежат в proj.tasks).

  // Можно ли добавить связь "toId зависит от fromId", не создав цикл —
  // проверяем, не зависит ли fromId (транзитивно, через свои же
  // предшественники) уже от toId.
  function wouldCreateDependencyCycle(proj, fromId, toId) {
    function walk(id, visited) {
      if (id === toId) return true;
      if (visited.has(id)) return false;
      visited.add(id);
      const t = proj.tasks.find((x) => x.id === id);
      if (!t || !t.dependsOn) return false;
      return t.dependsOn.some((depId) => walk(depId, visited));
    }
    return walk(fromId, new Set());
  }

  function addDependency(proj, taskId, depId) {
    const task = proj.tasks.find((t) => t.id === taskId);
    if (!task || taskId === depId) return;
    if (!task.dependsOn) task.dependsOn = [];
    if (task.dependsOn.includes(depId)) return;
    if (wouldCreateDependencyCycle(proj, depId, taskId)) return;
    task.dependsOn.push(depId);
    save();
  }

  function removeDependency(proj, taskId, depId) {
    const task = proj.tasks.find((t) => t.id === taskId);
    if (!task || !task.dependsOn) return;
    task.dependsOn = task.dependsOn.filter((id) => id !== depId);
    save();
  }

  // Предшественники задачи, которые реально мешают ей начаться сейчас: либо
  // ещё не выполнены, либо выполнены, но задача всё равно запланирована
  // начаться раньше, чем предшественник закончился (нарушение "сначала
  // выполнить" по датам).
  function getBlockingDependencies(proj, task) {
    if (!task.dependsOn || !task.dependsOn.length) return [];
    const taskEff = getEffectiveDates(proj, task);
    return task.dependsOn
      .map((id) => proj.tasks.find((t) => t.id === id))
      .filter(Boolean)
      .filter((dep) => {
        if (!dep.completed) return true;
        const depEff = getEffectiveDates(proj, dep);
        return !!(depEff.due && taskEff.start && taskEff.start < depEff.due);
      });
  }

  // ---------- проверка занятости исполнителя (пересекающиеся по датам задачи) ----------

  // Другие незавершённые задачи ТОГО ЖЕ исполнителя (в любом проекте),
  // чей период [start; due] пересекается с переданным — сигнал "человек
  // уже занят в это время".
  function getConflictingTasks(assigneeId, excludeTaskId, start, due) {
    if (!assigneeId || !start || !due) return [];
    const conflicts = [];
    state.projects.forEach((p) => {
      p.tasks.forEach((t) => {
        if (t.id === excludeTaskId || t.assigneeId !== assigneeId || t.completed) return;
        const eff = getEffectiveDates(p, t);
        if (!eff.start || !eff.due) return;
        if (start <= eff.due && due >= eff.start) conflicts.push({ task: t, proj: p });
      });
    });
    return conflicts;
  }

  // Есть ли у человека вообще хоть одна пара своих незавершённых задач с
  // пересекающимися датами — лёгкий индикатор для справочника людей,
  // без разбора по конкретной паре задач.
  function hasScheduleConflict(userId) {
    const tasks = [];
    state.projects.forEach((p) => p.tasks.forEach((t) => {
      if (t.assigneeId !== userId || t.completed) return;
      const eff = getEffectiveDates(p, t);
      if (eff.start && eff.due) tasks.push(eff);
    }));
    // Sweep-line вместо попарного перебора (O(n log n) вместо O(n²)):
    // сортируем по началу и идём слева направо, отслеживая самый поздний
    // срок среди уже пройденных задач. Если следующая задача начинается не
    // позже него — интервалы обязательно пересекаются (иначе максимум
    // сдвинулся бы дальше без пересечения).
    tasks.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    let maxDueSoFar = "";
    for (let i = 0; i < tasks.length; i++) {
      if (maxDueSoFar && tasks[i].start <= maxDueSoFar) return true;
      if (tasks[i].due > maxDueSoFar) maxDueSoFar = tasks[i].due;
    }
    return false;
  }

  // Список "соседей" задачи на одном уровне вложенности (для кнопок
  // "переместить выше/ниже" и "вложить в предыдущую").
  function getSiblings(proj, task) {
    // "Структура" — это WBS-иерархия: положение задачи верхнего уровня в
    // ней НЕ должно зависеть от статуса (раздела), иначе смена статуса
    // перекидывала бы её в другую группу и она "прыгала" по списку. Поэтому
    // здесь соседями считаются ВСЕ задачи верхнего уровня проекта сразу,
    // в порядке одного общего поля order — независимо от раздела.
    if (state.view === "structure" && !task.parentTaskId) {
      return proj.tasks
        .filter((t) => !t.parentTaskId)
        .sort((a, b) => a.order - b.order);
    }
    return proj.tasks
      .filter((t) => t.parentTaskId === task.parentTaskId && t.sectionId === task.sectionId)
      .sort((a, b) => a.order - b.order);
  }

  // ---------- работа с деревом проектов и подпроектов ----------

  // id самого проекта + id всех его подпроектов на любую глубину — для
  // удаления проекта целиком вместе со всеми вложенными подпроектами.
  function getProjectDescendantIds(projectId) {
    const ids = [projectId];
    state.projects.filter((p) => p.parentId === projectId).forEach((c) => ids.push(...getProjectDescendantIds(c.id)));
    return ids;
  }

  // Проект и все его подпроекты (на любую глубину) одним плоским списком,
  // в порядке обхода — используется, чтобы "Доска"/"Список"/"По статусам"
  // у проекта без своих задач всё равно показывали задачи подпроектов
  // (иначе такой проект выглядит пустым и бессмысленным).
  function getContentProjects(proj) {
    const ids = new Set(getProjectDescendantIds(proj.id));
    return state.projects.filter((p) => ids.has(p.id));
  }

  // Собирает задачи одной колонки/раздела разом из проекта и всех его
  // подпроектов: у подпроекта раздел ищется ПО ИМЕНИ (сами разделы —
  // разные объекты с разными id в каждом проекте, но по умолчанию у всех
  // проектов одинаковый набор имён — "К выполнению"/"В работе"/"Готово").
  // Если в подпроекте нет раздела с таким именем — его задачи сюда просто
  // не попадают (см. также moveTaskToSection, где такой раздел создаётся).
  function collectSectionTasks(activeProj, section, contentProjects, q) {
    const rows = [];
    contentProjects.forEach((p) => {
      const matchSection = p.id === activeProj.id
        ? section
        : p.sections.find((s) => s.name.trim().toLowerCase() === section.name.trim().toLowerCase());
      if (!matchSection) return;
      p.tasks
        .filter((t) => t.sectionId === matchSection.id && !t.parentTaskId)
        .filter((t) => matchesSearch(p, t, q))
        .filter((t) => !t.archived && (state.showCompleted || !t.completed))
        .forEach((t) => rows.push({ task: t, proj: p }));
    });
    rows.sort((a, b) => {
      if (a.proj !== b.proj) return contentProjects.indexOf(a.proj) - contentProjects.indexOf(b.proj);
      return a.task.order - b.task.order;
    });
    return rows;
  }

  // Является ли candidateId самим potentialAncestorId или его подпроектом —
  // запрещает перетащить проект внутрь самого себя/своего подпроекта в сайдбаре.
  function isDescendantProjectOf(candidateId, potentialAncestorId) {
    let p = state.projects.find((x) => x.id === candidateId);
    while (p) {
      if (p.id === potentialAncestorId) return true;
      p = p.parentId ? state.projects.find((x) => x.id === p.parentId) : null;
    }
    return false;
  }

  // Переставляет проект так, чтобы он стал соседом (тем же родителем)
  // проекта targetId — непосредственно перед ним или сразу после
  // (position = "before"/"after"). У проектов нет отдельного поля order:
  // порядок в дереве — это просто порядок элементов в state.projects,
  // поэтому переставляем сам элемент массива.
  function reorderProject(projectId, targetId, position) {
    if (projectId === targetId) return;
    const proj = state.projects.find((p) => p.id === projectId);
    const target = state.projects.find((p) => p.id === targetId);
    if (!proj || !target) return;
    // нельзя переставить проект рядом с его же подпроектом — иначе
    // родителем proj стал бы кто-то из его собственного поддерева
    if (isDescendantProjectOf(target.id, proj.id)) return;
    proj.parentId = target.parentId;
    state.projects.splice(state.projects.indexOf(proj), 1);
    let idx = state.projects.indexOf(target);
    if (position === "after") idx += 1;
    state.projects.splice(idx, 0, proj);
    save();
  }

  // Сводная статистика по проекту И ВСЕМ его подпроектам вместе: сколько
  // всего задач, сколько выполнено, сколько просрочено. Используется в
  // сайдбаре (счётчик рядом с проектом) и на дашборде (прогресс-бар).
  function getProjectStats(projectId) {
    const cache = getStatsCache();
    const key = `project:${projectId}`;
    if (cache.has(key)) return cache.get(key);
    const ids = new Set(getProjectDescendantIds(projectId));
    let total = 0, completed = 0, overdue = 0, openCount = 0, unread = 0;
    state.projects.forEach((p) => {
      if (!ids.has(p.id)) return;
      p.tasks.forEach((t) => {
        if (t.archived) return;
        total++;
        if (t.completed) completed++; else openCount++;
        if (isOverdue(p, t)) overdue++;
        if (isUnreadForMe(t)) unread++;
      });
    });
    const result = { total, completed, overdue, openCount, unread, pct: total ? Math.round((completed / total) * 100) : 0 };
    cache.set(key, result);
    return result;
  }

  // ---------- доступность модальных окон: фокус-ловушка + возврат фокуса ----------
  // Общий помощник для всех оверлеев (панель деталей, окно аналитики, наше
  // модальное окно вместо confirm/alert, палитра команд): при открытии
  // переносит фокус внутрь и запоминает, что было в фокусе снаружи, чтобы
  // вернуть его при закрытии; пока окно открыто — Tab/Shift+Tab не даёт
  // фокусу уйти за его пределы. Один стек на все оверлеи сразу (а не
  // отдельная переменная на каждый), потому что они могут открываться друг
  // над другом — например, подтверждение удаления прямо из панели деталей —
  // и тогда "куда вернуть фокус" должно разворачиваться в обратном
  // порядке открытия, как скобки.
  let modalFocusStack = [];

  function focusableIn(container) {
    return Array.from(container.querySelectorAll(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter((el) => {
      if (el.closest("[hidden]")) return false;
      const style = getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden";
    });
  }

  // Вызывать сразу после того, как оверлей показан (hidden = false).
  // initialFocusEl — необязательный элемент, в который нужно поставить
  // фокус вместо первого фокусируемого внутри оверлея.
  function openModalFocus(container, initialFocusEl) {
    // Тот же оверлей может "открываться" повторно, пока уже открыт —
    // например, панель деталей переоткрывается на другую задачу кликом по
    // зависимости внутри неё же самой. В этом случае это не новый оверлей
    // поверх старого, а просто смена содержимого того же самого, и стек
    // возврата фокуса не должен расти на каждую такую смену.
    const alreadyOpen = modalFocusStack.some((e) => e.container === container);
    if (!alreadyOpen) {
      modalFocusStack.push({ container, returnTo: document.activeElement });
    }
    const target = initialFocusEl || focusableIn(container)[0] || container;
    if (target && typeof target.focus === "function") target.focus();
  }

  // Вызывать сразу после того, как оверлей скрыт (hidden = true). Безопасно
  // вызывать и тогда, когда openModalFocus для этого container не
  // вызывался (например, closeDetail() дергают "на всякий случай" даже
  // когда панель уже закрыта) — просто ничего не сделает.
  function closeModalFocus(container) {
    const idx = modalFocusStack.map((e) => e.container).lastIndexOf(container);
    if (idx === -1) return;
    const [{ returnTo }] = modalFocusStack.splice(idx, 1);
    if (returnTo && document.body.contains(returnTo) && typeof returnTo.focus === "function") {
      returnTo.focus();
    }
  }

  // Держит Tab/Shift+Tab внутри container, пока он открыт (hidden === false).
  // Вызывается один раз при инициализации оверлея, а не при каждом
  // открытии — сам смотрит на container.hidden, чтобы понять, активен ли.
  // Если открыто несколько оверлеев одновременно (см. выше про стек),
  // сработает только обработчик того из них, внутри которого сейчас
  // реально стоит фокус — у остальных first/last просто не совпадут с
  // document.activeElement, и они промолчат.
  function trapTabWithin(container) {
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Tab" || container.hidden) return;
      const items = focusableIn(container);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
  }

  // Открывает окно аналитики по проекту (см. js/analytics.js) — просто
  // передаёт туда нужные данные и несколько функций-помощников, само
  // окно ничего не хранит и не меняет.
  function openProjectAnalytics(projectId) {
    const proj = state.projects.find((p) => p.id === projectId);
    if (!proj) return;
    ProjectAnalytics.render(analyticsBody, analyticsTitle, {
      project: proj,
      allProjects: state.projects,
      helpers: { getSubtasks, getTaskDescendantIds, getEffectiveDates, isOverdue, getBlockingDependencies, assigneeName }
    });
    analyticsPanel.hidden = false;
    openModalFocus(analyticsPanel);
  }

  function closeProjectAnalytics() {
    analyticsPanel.hidden = true;
    closeModalFocus(analyticsPanel);
  }

  // ---------- модальное окно (замена стандартных prompt/confirm/alert браузера) ----------
  // Обычные браузерные alert()/confirm() блокируют страницу и выглядят
  // некрасиво — вместо них показываем своё окно с кнопками, которое
  // возвращает Promise с результатом выбора пользователя.

  function showModal(message, buttons) {
    return new Promise((resolve) => {
      modalMessage.textContent = message;
      modalActions.innerHTML = "";
      let settled = false;

      function finish(value) {
        if (settled) return;
        settled = true;
        modalOverlay.hidden = true;
        closeModalFocus(modalOverlay);
        modalOverlay.removeEventListener("click", onOverlayClick);
        document.removeEventListener("keydown", onKeydown);
        resolve(value);
      }

      function onOverlayClick(e) {
        if (e.target === modalOverlay) finish(buttons.find((b) => b.isCancel)?.value ?? null);
      }
      function onKeydown(e) {
        if (e.key === "Escape") finish(buttons.find((b) => b.isCancel)?.value ?? null);
      }

      buttons.forEach((b) => {
        const btn = document.createElement("button");
        btn.className = "modal-btn" + (b.primary ? " primary" : "") + (b.danger ? " danger" : "");
        btn.textContent = b.label;
        btn.addEventListener("click", () => finish(b.value));
        modalActions.appendChild(btn);
      });

      modalOverlay.hidden = false;
      openModalFocus(modalOverlay);
      modalOverlay.addEventListener("click", onOverlayClick);
      document.addEventListener("keydown", onKeydown);
    });
  }

  // Окно-уведомление с одной кнопкой "Понятно" — замена window.alert().
  function showAlert(message) {
    return showModal(message, [{ label: "Понятно", value: true, primary: true, isCancel: true }]);
  }

  // Окно "Отмена / Удалить" — замена window.confirm(). Возвращает Promise<true|false>.
  function showConfirm(message, confirmLabel) {
    return showModal(message, [
      { label: "Отмена", value: false, isCancel: true },
      { label: confirmLabel || "Удалить", value: true, danger: true }
    ]);
  }

  // ---------- тост (ненавязчивое уведомление внизу экрана, с опциональной кнопкой действия) ----------

  let toastTimer = null;
  let toastActionHandler = null;

  function hideToast() {
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    toastEl.hidden = true;
    toastActionHandler = null;
  }

  // Показывает тост на несколько секунд. Если передан onAction — рядом с
  // текстом появляется кнопка (подпись — actionLabel, по умолчанию
  // "Отменить"), которая вызывает onAction() и сразу прячет тост (повторно
  // нажать нельзя — действие уже выполнено). durationMs — необязательное
  // переопределение времени показа (по умолчанию 6 секунд).
  function showToast(message, onAction, actionLabel, durationMs) {
    if (toastTimer) clearTimeout(toastTimer);
    toastMessageEl.textContent = message;
    toastUndoBtn.hidden = !onAction;
    toastUndoBtn.textContent = actionLabel || "Отменить";
    toastActionHandler = onAction || null;
    toastEl.hidden = false;
    toastTimer = setTimeout(hideToast, durationMs || 6000);
  }

  toastUndoBtn.addEventListener("click", () => {
    const handler = toastActionHandler;
    hideToast();
    if (handler) handler();
  });

  // ---------- командная палитра (Ctrl+K / Cmd+K) ----------
  // Обычный поиск в топбаре ищет только внутри открытого проекта — чтобы
  // найти задачу, надо сначала вспомнить, в каком она проекте. Палитра
  // ищет по ВСЕМ проектам сразу и даёт быстрые команды навигации, без
  // мыши. Список задач и команд собирается и заново фильтруется при
  // каждом нажатии клавиши — палитра открыта недолго, так что пересчёт
  // "в лоб" по всем задачам каждый раз заметно не тормозит.

  const PALETTE_VIEW_COMMANDS = [
    { view: "board", label: "Доска" },
    { view: "list", label: "Список" },
    { view: "tree", label: "По статусам" },
    { view: "structure", label: "Структура" },
    { view: "gantt", label: "Гант" }
  ];

  let paletteItems = [];   // текущий отфильтрованный список пунктов палитры
  let paletteActiveIdx = 0; // какой из них подсвечен

  // Собирает пункты палитры под текущий запрос q. Пустой запрос — список
  // мест, куда обычно переходят (экраны + все проекты); непустой —
  // задачи по всем проектам (по названию/заметкам/тегам/исполнителю,
  // как и обычный поиск) плюс подходящие по названию команды/проекты.
  function buildPaletteItems(q) {
    const query = q.trim().toLowerCase();
    const items = [];

    if (!query) {
      items.push({ type: "screen", icon: "◧", title: "Дашборд", action: () => { state.screen = "dashboard"; commit(); } });
      items.push({ type: "screen", icon: "☺", title: "Люди", action: () => { state.screen = "people"; commit(); } });
      items.push({ type: "screen", icon: "🗑", title: "Корзина", action: () => { state.screen = "trash"; commit(); } });
      items.push({ type: "screen", icon: "🗄", title: "Архив", action: () => { state.screen = "archive"; commit(); } });
      state.projects.forEach((p) => {
        items.push({ type: "project", icon: "📁", title: p.name, action: () => { state.screen = "project"; state.activeProjectId = p.id; commit(); } });
      });
      return items;
    }

    PALETTE_VIEW_COMMANDS.forEach((v) => {
      if (v.label.toLowerCase().includes(query)) {
        items.push({ type: "command", icon: "▤", title: `Вид: ${v.label}`, action: () => { state.screen = "project"; state.view = v.view; commit(); } });
      }
    });

    state.projects.forEach((p) => {
      if (p.name.toLowerCase().includes(query)) {
        items.push({ type: "project", icon: "📁", title: p.name, meta: "Перейти к проекту", action: () => { state.screen = "project"; state.activeProjectId = p.id; commit(); } });
      }
    });

    state.projects.forEach((p) => {
      p.tasks.forEach((t) => {
        const autoTagText = autoTagsFor(p, t).map((x) => x.label).join(" ");
        const hay = (t.title + " " + t.notes + " " + assigneeName(t) + " " + t.tags.join(" ") + " " + autoTagText).toLowerCase();
        if (!hay.includes(query)) return;
        items.push({
          type: "task",
          icon: t.completed ? "✓" : "○",
          title: t.title,
          meta: p.name,
          action: () => {
            state.screen = "project";
            state.activeProjectId = p.id;
            commit();
            openDetail(t.id);
          }
        });
      });
    });

    return items.slice(0, 40);
  }

  function renderPaletteResults() {
    if (!paletteItems.length) {
      paletteResults.innerHTML = `<div class="palette-empty">Ничего не найдено</div>`;
      return;
    }
    paletteResults.innerHTML = paletteItems.map((item, i) => `
      <div class="palette-item ${i === paletteActiveIdx ? "active" : ""}" data-idx="${i}">
        <span class="palette-item-icon">${item.icon}</span>
        <span class="palette-item-title">${escapeHtml(item.title)}</span>
        ${item.meta ? `<span class="palette-item-meta">${escapeHtml(item.meta)}</span>` : ""}
      </div>
    `).join("");
    const activeEl = paletteResults.querySelector(".palette-item.active");
    if (activeEl && activeEl.scrollIntoView) activeEl.scrollIntoView({ block: "nearest" });
  }

  function paletteSearch() {
    paletteItems = buildPaletteItems(paletteInput.value);
    paletteActiveIdx = 0;
    renderPaletteResults();
  }

  function openPalette() {
    paletteOverlay.hidden = false;
    paletteInput.value = "";
    paletteSearch();
    openModalFocus(paletteOverlay, paletteInput);
  }

  function closePalette() {
    paletteOverlay.hidden = true;
    closeModalFocus(paletteOverlay);
  }

  function activatePaletteItem(idx) {
    const item = paletteItems[idx];
    if (!item) return;
    closePalette();
    item.action();
  }

  paletteInput.addEventListener("input", paletteSearch);
  paletteInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (paletteItems.length) paletteActiveIdx = (paletteActiveIdx + 1) % paletteItems.length;
      renderPaletteResults();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (paletteItems.length) paletteActiveIdx = (paletteActiveIdx - 1 + paletteItems.length) % paletteItems.length;
      renderPaletteResults();
    } else if (e.key === "Enter") {
      e.preventDefault();
      activatePaletteItem(paletteActiveIdx);
    } else if (e.key === "Escape") {
      closePalette();
    }
  });
  paletteResults.addEventListener("click", (e) => {
    const row = e.target.closest(".palette-item");
    if (row) activatePaletteItem(Number(row.dataset.idx));
  });
  paletteOverlay.addEventListener("click", (e) => {
    if (e.target === paletteOverlay) closePalette();
  });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (paletteOverlay.hidden) openPalette(); else closePalette();
    }
  });

  // ---------- отрисовка: боковая панель со списком проектов ----------

  // Перерисовывает дерево проектов слева: обходит проекты рекурсивно
  // (глобальные проекты и вложенные в них подпроекты), навешивает клики,
  // перетаскивание для вложения одного проекта в другой и т.д.
  function renderSidebar() {
    projectListEl.innerHTML = "";

    // Рисует одну строку проекта и, если он не свёрнут, рекурсивно —
    // строки всех его подпроектов с увеличенным отступом.
    function renderNode(project, depth) {
      const children = state.projects.filter((p) => p.parentId === project.id);
      const hasChildren = children.length > 0;
      const collapsed = collapsedProjects.has(project.id);
      const stats = getProjectStats(project.id);

      const item = document.createElement("div");
      item.className = "project-item" + (state.screen === "project" && project.id === state.activeProjectId ? " active" : "");
      item.style.paddingLeft = (8 + depth * 16) + "px";
      item.draggable = true;
      item.dataset.projectId = project.id;
      item.innerHTML = `
        ${hasChildren ? `<button class="chevron${collapsed ? "" : " expanded"}" data-toggle="${project.id}" aria-label="${collapsed ? "Развернуть подпроекты" : "Свернуть подпроекты"}" aria-expanded="${!collapsed}">▶</button>` : `<span class="chevron-spacer"></span>`}
        <span class="dot" style="background:${project.color}"></span>
        <span class="name">${escapeHtml(project.name)}</span>
        <button class="project-analytics-btn" data-analytics="${project.id}" title="Аналитика проекта" aria-label="Аналитика проекта «${escapeHtml(project.name)}»">📊</button>
        <button class="add-sub-btn" data-parent="${project.id}" title="Добавить подпроект" aria-label="Добавить подпроект в «${escapeHtml(project.name)}»">+</button>
        ${stats.unread ? `<span class="unread-dot" title="${stats.unread} непрочитанных">${stats.unread}</span>` : ""}
        <span class="count">${stats.openCount || ""}</span>
      `;
      projectListEl.appendChild(item);

      if (addingSubprojectOf === project.id) {
        const row = document.createElement("div");
        row.className = "add-subproject-inline";
        row.style.paddingLeft = (8 + (depth + 1) * 16) + "px";
        row.innerHTML = `<input type="text" class="inline-add-input" data-parent-project-id="${project.id}" placeholder="Название подпроекта...">`;
        projectListEl.appendChild(row);
      }

      if (!collapsed) children.forEach((c) => renderNode(c, depth + 1));
    }

    state.projects.filter((p) => !p.parentId).forEach((p) => renderNode(p, 0));

    projectListEl.querySelectorAll(".project-item").forEach((item) => {
      const pid = item.dataset.projectId;

      item.addEventListener("click", () => {
        state.screen = "project";
        state.activeProjectId = pid;
        closeDetail();
        commit();
      });

      item.addEventListener("dragstart", (e) => {
        dragProjectId = pid;
        item.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
      });
      item.addEventListener("dragend", () => item.classList.remove("dragging"));

      item.addEventListener("dragover", (e) => {
        if (!dragProjectId || dragProjectId === pid || isDescendantProjectOf(pid, dragProjectId)) return;
        e.preventDefault();
        e.stopPropagation();
        const zone = verticalDropZone(item, e);
        item.classList.toggle("drag-over-before", zone === "before");
        item.classList.toggle("drag-over-after", zone === "after");
        item.classList.toggle("drag-over-nest", zone === "nest");
      });
      item.addEventListener("dragleave", () => item.classList.remove("drag-over-nest", "drag-over-before", "drag-over-after"));
      item.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const zone = verticalDropZone(item, e);
        item.classList.remove("drag-over-nest", "drag-over-before", "drag-over-after");
        if (!dragProjectId || dragProjectId === pid || isDescendantProjectOf(pid, dragProjectId)) { dragProjectId = null; return; }
        if (zone === "nest") {
          const proj = state.projects.find((p) => p.id === dragProjectId);
          proj.parentId = pid;
          setProjectCollapsed(pid, false);
        } else {
          reorderProject(dragProjectId, pid, zone);
        }
        dragProjectId = null;
        renderAll();
      });
    });

    projectListEl.querySelectorAll(".chevron").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.dataset.toggle;
        setProjectCollapsed(id, !collapsedProjects.has(id));
        renderSidebar();
      });
    });

    projectListEl.querySelectorAll(".add-sub-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.dataset.parent;
        setProjectCollapsed(id, false);
        addingSubprojectOf = id;
        renderSidebar();
      });
    });

    projectListEl.querySelectorAll(".project-analytics-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        openProjectAnalytics(btn.dataset.analytics);
      });
    });

    bindProjectQuickAddEvents();

    showCompletedToggle.checked = state.showCompleted;

    addProjectBtn.hidden = addingProject;
    addProjectInline.hidden = !addingProject;
    if (addingProject) {
      addProjectInput.value = "";
      addProjectInput.focus();
    }

    dashboardNavBtn.classList.toggle("active", state.screen === "dashboard");
    peopleNavBtn.classList.toggle("active", state.screen === "people");
    trashNavBtn.classList.toggle("active", state.screen === "trash");
    archiveNavBtn.classList.toggle("active", state.screen === "archive");
    trashCountEl.hidden = !state.trash.length;
    trashCountEl.textContent = state.trash.length || "";
  }

  // Навешивает обработчики на поле быстрого добавления подпроекта (Enter —
  // создать, Escape/потеря фокуса — отменить).
  function bindProjectQuickAddEvents() {
    projectListEl.querySelectorAll(".inline-add-input[data-parent-project-id]").forEach((input) => {
      input.focus();
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const name = input.value.trim();
          if (name) createProject(name, input.dataset.parentProjectId);
          skipNextBlur = true;
          renderAll();
        } else if (e.key === "Escape") {
          skipNextBlur = true;
          addingSubprojectOf = null;
          renderSidebar();
        }
      });
      input.addEventListener("blur", () => {
        if (skipNextBlur) { skipNextBlur = false; return; }
        addingSubprojectOf = null;
        renderSidebar();
      });
    });
  }

  // ---------- отрисовка: верхняя панель проекта (название, поиск, переключатель видов) ----------

  // Обновляет заголовок текущего проекта и подсвечивает активную кнопку
  // вида (Доска/Список/По статусам/Структура/Гант).
  function renderTopbar() {
    const proj = getActiveProject();
    projectTitleEl.textContent = proj.name;
    currentProjectDot.style.background = proj.color;
    Array.from(viewSwitch.children).forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.view === state.view);
    });
    // Управлять участниками проекта (кто видит его целиком) может только
    // автор — остальным кнопка не нужна, у них и так нет прав её менять.
    membersToggleBtn.hidden = proj._canEdit === false;
    renderMembersPanel(proj);
    renderFilterControls();
  }

  // Список пользователей с чекбоксами: кто из них состоит в участниках
  // текущего проекта (js/sync.js — project.members) и поэтому видит ВСЕ
  // его задачи, а не только свои/назначенные.
  function renderMembersPanel(proj) {
    if (!state.users.length) {
      membersList.innerHTML = `<div class="members-list-empty">Список людей пуст — добавьте их на экране «Люди» или дождитесь, пока кто-то войдёт в приложение.</div>`;
      return;
    }
    const members = new Set(proj.members || []);
    membersList.innerHTML = state.users.map((u) => `
      <label><input type="checkbox" data-member-id="${u.id}" ${members.has(u.id) ? "checked" : ""}> ${escapeHtml(u.name)}</label>
    `).join("");
    membersList.querySelectorAll("[data-member-id]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const current = getActiveProject();
        const set = new Set(current.members || []);
        if (cb.checked) set.add(cb.dataset.memberId); else set.delete(cb.dataset.memberId);
        current.members = [...set];
        commit(true);
      });
    });
  }

  // Обновляет содержимое панели фильтров под текущий проект: список
  // исполнителей (справочник людей общий для всех проектов, поэтому не
  // меняется от проекта к проекту) и список тегов (а вот он свой у
  // каждого проекта — собирается из реально использующихся тегов задач
  // этого проекта и его подпроектов). Выбранные значения при этом не
  // сбрасываются — если, например, выбранного тега в новом проекте нет,
  // фильтр по нему просто не даст результатов, но пользователю не нужно
  // выбирать заново, если он вернётся к прежнему проекту.
  function renderFilterControls() {
    const prevAssignee = filterAssignee.value;
    filterAssignee.innerHTML = `<option value="">Любой</option><option value="none">Без исполнителя</option>` +
      state.users.map((u) => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join("");
    filterAssignee.value = activeFilters.assigneeId || prevAssignee || "";

    // В отличие от тегов, список исполнителей выше не зависит от проекта —
    // это общий справочник людей. Теги раньше собирались только с задач
    // текущего проекта и его подпроектов, из-за чего в проекте, где ни одна
    // ЕГО задача ещё не помечена тегом, список выглядел пустым, даже если
    // теги вовсю используются в других проектах — при том что остальные
    // фильтры такому правилу не подчиняются. Поэтому теги теперь собираются
    // по ВСЕМ проектам сразу, как и остальные фильтры.
    const tagSet = new Set();
    state.projects.forEach((p) => p.tasks.forEach((t) => t.tags.forEach((tag) => tagSet.add(tag))));
    const tags = [...tagSet].sort((a, b) => a.localeCompare(b, "ru"));
    filterTag.innerHTML = `<option value="">Любой</option>` + tags.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join("");
    filterTag.value = tags.includes(activeFilters.tag) ? activeFilters.tag : "";
    if (!tags.includes(activeFilters.tag)) activeFilters.tag = "";

    filterPriority.value = activeFilters.priority;
    filterDue.value = activeFilters.due;

    const count = filtersActiveCount();
    filterCountEl.hidden = !count;
    filterCountEl.textContent = count || "";
    filterToggleBtn.classList.toggle("has-active", !!count);
  }

  // ---------- отрисовка: вид "Доска" (канбан-колонки по статусам) ----------

  // Бейдж "новое"/"изменено" (js/sync.js) — только для задач, которые
  // создал кто-то ДРУГОЙ (свои собственные не считаем "непрочитанными",
  // даже если формально ни разу не открывали панель деталей).
  function syncStatusBadgeHtml(task) {
    if (!window.TaskingSync) return "";
    const session = window.TaskingAuth && window.TaskingAuth.getSession();
    if (!session || !task._creatorId || task._creatorId === session.user.id) return "";
    if (task._isUnread) return `<span class="badge badge-sync-new" title="Вы ещё не открывали эту задачу">● новое</span>`;
    if (task._isChanged) return `<span class="badge badge-sync-changed" title="Изменена с последнего просмотра">✎ изменено</span>`;
    return "";
  }

  // Заголовок непрочитанной чужой задачи рисуем жирным — тот же критерий,
  // что и у бейджа "новое" выше (своё не считаем непрочитанным).
  function isUnreadForMe(task) {
    if (!window.TaskingSync || !task._isUnread) return false;
    const session = window.TaskingAuth && window.TaskingAuth.getSession();
    return !!(session && task._creatorId && task._creatorId !== session.user.id);
  }

  // HTML одной карточки задачи на доске: срок, приоритет, счётчик
  // подзадач, теги, аватар исполнителя.
  function taskCardHtml(task, proj) {
    const bits = [];
    const eff = getEffectiveDates(proj, task);
    if (eff.due) {
      bits.push(`<span class="badge badge-due ${isOverdue(proj, task) ? "overdue" : ""}"${eff.auto ? ' title="Вычислено по подзадачам"' : ""}>${formatDue(eff.due)}</span>`);
    }
    if (task.priority && task.priority !== "medium") {
      bits.push(`<span class="badge badge-priority-${task.priority}">${priorityLabel(task.priority)}</span>`);
    }
    const subs = getSubtasks(proj, task.id);
    if (subs.length) {
      const done = subs.filter((s) => s.completed).length;
      bits.push(`<span class="badge badge-subtasks ${done === subs.length ? "all-done" : ""}">☑ ${done}/${subs.length}</span>`);
    }
    if (!task.completed) {
      const blockers = getBlockingDependencies(proj, task);
      if (blockers.length) {
        bits.push(`<span class="badge badge-blocked" title="Ждёт выполнения: ${escapeHtml(blockers.map((b) => b.title).join(", "))}">⛔ ждёт</span>`);
      }
    }
    bits.unshift(syncStatusBadgeHtml(task));
    bits.push(autoTagsHtml(proj, task));
    task.tags.forEach((t) => bits.push(`<span class="tag-chip">${escapeHtml(t)}</span>`));
    const aName = assigneeName(task);
    const avatar = aName ? `<span class="avatar" title="${escapeHtml(aName)}">${initials(aName)}</span>` : "";
    return `
      <div class="card ${task.completed ? "completed" : ""}" draggable="true" data-task-id="${task.id}">
        <div class="card-top-row">
          <span class="row-check card-check ${task.completed ? "checked" : ""}" data-task-id="${task.id}" title="Отметить выполненной">✓</span>
          <div class="card-title${isUnreadForMe(task) ? " title-unread" : ""}">${escapeHtml(task.title)}</div>
        </div>
        <div class="card-meta">${bits.join("")}${avatar}</div>
      </div>
    `;
  }

  // Перерисовывает доску целиком: по одной колонке на каждый раздел
  // (статус) проекта, в колонках — карточки задач верхнего уровня
  // (подзадачи на доске отдельными карточками не показываются, они видны
  // только внутри карточки-родителя через панель деталей).
  function renderBoard() {
    const proj = getActiveProject();
    const q = searchInput.value.trim();
    const contentProjects = getContentProjects(proj);
    boardEl.innerHTML = "";

    proj.sections.forEach((section) => {
      const rows = collectSectionTasks(proj, section, contentProjects, q);

      const col = document.createElement("div");
      col.className = "section-col";
      col.dataset.sectionId = section.id;

      col.innerHTML = `
        <div class="section-head">
          <input class="section-name" value="${escapeHtml(section.name)}" data-section-id="${section.id}">
          <span class="section-count">${rows.length}</span>
          <button class="section-del" data-section-id="${section.id}" title="Удалить раздел">×</button>
        </div>
        <div class="section-cards" data-section-id="${section.id}" data-section-name="${escapeHtml(section.name)}"></div>
        ${quickAddRowHtml(section.id)}
      `;

      const cardsEl = col.querySelector(".section-cards");
      cardsEl.innerHTML = rows.map((r) => taskCardHtml(r.task, r.proj)).join("") || "";

      boardEl.appendChild(col);
    });

    const addCol = document.createElement("div");
    addCol.className = "add-section-col";
    addCol.innerHTML = `<button class="add-section-btn" id="addSectionBtn">+ Добавить раздел</button>`;
    boardEl.appendChild(addCol);

    bindBoardEvents();
  }

  // HTML для нижней строки раздела: либо кнопка "+ Добавить задачу", либо
  // (если по ней только что кликнули) поле ввода названия новой задачи.
  function quickAddRowHtml(sectionId) {
    if (addingTaskSection === sectionId) {
      return `<div class="inline-add-row"><input type="text" class="inline-add-input" data-section-id="${sectionId}" placeholder="Название задачи..."></div>`;
    }
    return `<button class="add-card-btn" data-section-id="${sectionId}">+ Добавить задачу</button>`;
  }

  // Общие обработчики для "быстрого добавления задачи": клик по кнопке
  // открывает поле ввода, Enter создаёт задачу и сразу открывает новое
  // пустое поле (можно быстро добавить несколько задач подряд), Escape
  // отменяет. Используется и на доске, и в списке, и в дереве.
  // Дни недели для разбора "до пт"/"к вт" в быстром вводе — ближайшее ТАКОЕ
  // число (включая сегодня, если сегодня уже искомый день недели).
  const QUICK_ADD_WEEKDAYS = { "вс": 0, "пн": 1, "вт": 2, "ср": 3, "чт": 4, "пт": 5, "сб": 6 };
  const QUICK_ADD_PRIORITIES = { "высокий": "high", "в": "high", "средний": "medium", "с": "medium", "низкий": "low", "н": "low" };

  // Разбирает строку быстрого добавления на заголовок и необязательные
  // токены: "@Имя" — исполнитель (по частичному совпадению имени, без учёта
  // регистра), "!высокий/средний/низкий" (или короткое !в/!с/!н) —
  // приоритет, "#тег" (можно несколько) — теги, "N ч" — оценка в часах,
  // "до пт"/"к вт" и т.п. — срок (ближайший такой день недели от сегодня).
  // Всё распознанное вырезается из текста, остаток — заголовок задачи.
  function parseQuickAddInput(raw) {
    let text = raw;
    const result = { title: "", assigneeId: null, priority: null, tags: [], estimateHours: null, due: null };

    text = text.replace(/@(\S+)/, (m, name) => {
      const user = state.users.find((u) => u.name.toLowerCase().includes(name.toLowerCase()));
      if (user) result.assigneeId = user.id;
      return " ";
    });

    text = text.replace(/!(\S+)/, (m, word) => {
      const p = QUICK_ADD_PRIORITIES[word.toLowerCase()];
      if (!p) return m;
      result.priority = p;
      return " ";
    });

    text = text.replace(/#(\S+)/g, (m, tag) => {
      result.tags.push(tag);
      return " ";
    });

    // \b здесь не годится: в JS-регэкспах без экзотических Unicode-хаков
    // \b считает "словесными" только [A-Za-z0-9_], поэтому граница сразу
    // после кириллической "ч" не распознаётся вообще — используем lookahead
    // на пробел/конец строки вместо этого.
    text = text.replace(/(\d+(?:[.,]\d+)?)\s*ч(?=\s|$)/i, (m, num) => {
      result.estimateHours = parseFloat(num.replace(",", "."));
      return " ";
    });

    // Та же причина: заменяем \b на явные (^|\s) слева и (?=\s|$) справа.
    text = text.replace(/(^|\s)(?:до|к)\s+(пн|вт|ср|чт|пт|сб|вс)(?=\s|$)/i, (m, lead, wd) => {
      const targetDow = QUICK_ADD_WEEKDAYS[wd.toLowerCase()];
      const daysAhead = (targetDow - new Date().getDay() + 7) % 7;
      result.due = addDays(todayStr(), daysAhead);
      return lead + " ";
    });

    result.title = text.replace(/\s+/g, " ").trim();
    return result;
  }

  function bindQuickAddEvents(root) {
    root.querySelectorAll(".add-card-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        addingTaskSection = btn.dataset.sectionId;
        renderAll(true);
      });
    });
    root.querySelectorAll(".inline-add-input[data-section-id]").forEach((input) => {
      input.focus();
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const parsed = parseQuickAddInput(input.value);
          if (parsed.title) {
            const task = createTask(getActiveProject(), input.dataset.sectionId, parsed.title);
            if (parsed.assigneeId) task.assigneeId = parsed.assigneeId;
            if (parsed.priority) task.priority = parsed.priority;
            if (parsed.tags.length) task.tags = parsed.tags;
            if (parsed.estimateHours != null) task.estimateHours = parsed.estimateHours;
            if (parsed.due) task.due = parsed.due;
            save();
          }
          skipNextBlur = true;
          renderAll(true);
        } else if (e.key === "Escape") {
          skipNextBlur = true;
          addingTaskSection = null;
          renderAll(true);
        }
      });
      input.addEventListener("blur", () => {
        if (skipNextBlur) { skipNextBlur = false; return; }
        if (addingTaskSection === input.dataset.sectionId) {
          addingTaskSection = null;
          renderAll(true);
        }
      });
    });
  }

  // Общий геометрический помощник для drag-and-drop по строкам/карточкам:
  // какую долю высоты элемента занимает точка, куда сейчас наведён курсор.
  function dropZoneFraction(el, e) {
    const rect = el.getBoundingClientRect();
    return (e.clientY - rect.top) / rect.height;
  }

  // Верхняя треть строки — "вставить перед", нижняя треть — "вставить
  // после", середина — "вложить внутрь" (сделать подзадачей/подпроектом).
  function verticalDropZone(el, e) {
    const f = dropZoneFraction(el, e);
    if (f < 0.3) return "before";
    if (f > 0.7) return "after";
    return "nest";
  }

  // Делает элемент (карточку на доске, строку в списке или дереве) целью
  // для перетаскивания другой задачи: отпускание над серединой строки
  // вкладывает задачу подзадачей (как раньше — "перетащить задачу на
  // задачу, чтобы вложить"), а отпускание над верхней или нижней третью —
  // просто переставляет её соседом до/после, без вложения (ручная
  // сортировка). Используется одинаково во всех видах.
  function bindNestDragEvents(el, taskId) {
    el.addEventListener("dragover", (e) => {
      if (!dragTaskId || dragTaskId === taskId) return;
      e.preventDefault();
      e.stopPropagation();
      const zone = verticalDropZone(el, e);
      el.classList.toggle("drop-target-before", zone === "before");
      el.classList.toggle("drop-target-after", zone === "after");
      el.classList.toggle("drop-target-nest", zone === "nest");
    });
    el.addEventListener("dragleave", () => el.classList.remove("drop-target-nest", "drop-target-before", "drop-target-after"));
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const zone = verticalDropZone(el, e);
      el.classList.remove("drop-target-nest", "drop-target-before", "drop-target-after");
      if (!dragTaskId || dragTaskId === taskId) return;
      if (isDescendantTaskOf(taskId, dragTaskId)) { dragTaskId = null; return; }
      if (zone === "nest") {
        nestTaskUnder(dragTaskId, taskId);
        dragTaskId = null;
        renderAll();
        openDetail(taskId);
      } else {
        reorderTask(dragTaskId, taskId, zone);
        dragTaskId = null;
        renderAll();
      }
    });
  }

  // Навешивает все обработчики на только что отрисованную доску:
  // переименование раздела, удаление раздела, добавление задачи,
  // открытие карточки по клику, перетаскивание карточек между колонками
  // и вложение карточки в карточку.
  function bindBoardEvents() {
    boardEl.querySelectorAll(".section-name").forEach((input) => {
      input.addEventListener("change", () => {
        const sec = findSection(input.dataset.sectionId);
        if (sec) {
          sec.name = input.value.trim() || sec.name;
          commit();
        }
      });
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
    });

    boardEl.querySelectorAll(".section-del").forEach((btn) => {
      btn.addEventListener("click", () => deleteSection(btn.dataset.sectionId));
    });

    bindQuickAddEvents(boardEl);

    const addSectionBtn = document.getElementById("addSectionBtn");
    if (addSectionBtn) addSectionBtn.addEventListener("click", addSection);

    boardEl.querySelectorAll(".card-check").forEach((chk) => {
      chk.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleComplete(chk.dataset.taskId);
      });
      // Чекбокс не должен утаскивать за собой всю карточку при попытке
      // просто кликнуть по нему.
      chk.addEventListener("dragstart", (e) => e.preventDefault());
    });

    boardEl.querySelectorAll(".card").forEach((card) => {
      const taskId = card.dataset.taskId;
      card.addEventListener("click", () => openDetail(taskId));
      card.addEventListener("dragstart", (e) => {
        dragTaskId = taskId;
        card.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
      });
      card.addEventListener("dragend", () => card.classList.remove("dragging"));
      bindNestDragEvents(card, taskId);
    });

    boardEl.querySelectorAll(".section-cards").forEach((zone) => {
      zone.addEventListener("dragover", (e) => {
        e.preventDefault();
        zone.closest(".section-col").classList.add("drag-over");
      });
      zone.addEventListener("dragleave", () => {
        zone.closest(".section-col").classList.remove("drag-over");
      });
      zone.addEventListener("drop", (e) => {
        e.preventDefault();
        zone.closest(".section-col").classList.remove("drag-over");
        if (!dragTaskId) return;
        moveTaskToSection(dragTaskId, zone.dataset.sectionId, zone.dataset.sectionName);
        dragTaskId = null;
      });
    });
  }

  // Переносит задачу в другой раздел (статус) — например, при
  // перетаскивании карточки в другую колонку доски.
  // sectionName нужен для случая, когда Доска/Список показывают вперемешку
  // задачи подпроектов (см. collectSectionTasks): зона сброса помечена id
  // раздела АКТИВНОГО проекта, а перетаскиваемая задача может принадлежать
  // подпроекту — тогда id раздела ей не подходит (это чужой проект), и мы
  // ищем (или заводим) в ЕЁ СОБСТВЕННОМ проекте раздел с тем же именем.
  function moveTaskToSection(taskId, sectionId, sectionName) {
    const proj = findTaskOwnerProject(taskId);
    if (!proj) return;
    const task = proj.tasks.find((t) => t.id === taskId);
    if (!task) return;
    let targetId = sectionId;
    if (!proj.sections.some((s) => s.id === targetId)) {
      if (!sectionName) return;
      let matched = proj.sections.find((s) => s.name.trim().toLowerCase() === sectionName.trim().toLowerCase());
      if (!matched) {
        matched = { id: uid(), name: sectionName };
        proj.sections.push(matched);
      }
      targetId = matched.id;
    }
    task.sectionId = targetId;
    const siblings = proj.tasks.filter((t) => t.sectionId === targetId && t.id !== taskId);
    task.order = siblings.length ? Math.max(...siblings.map((t) => t.order)) + 1 : 0;
    commit();
  }

  // Делает задачу child подзадачей задачи parent (и переносит её в раздел
  // родителя, чтобы статус был согласован) — это и есть основное действие
  // "перетащить задачу на задачу".
  function nestTaskUnder(childId, parentId) {
    const proj = findTaskOwnerProject(childId);
    if (!proj) return;
    const child = proj.tasks.find((t) => t.id === childId);
    const parent = proj.tasks.find((t) => t.id === parentId);
    // вложенность поддерживается только внутри одного и того же проекта
    if (!child || !parent || child.id === parent.id) return;
    child.parentTaskId = parentId;
    child.sectionId = parent.sectionId;
    invalidateTreeCache();
    const newSiblings = getSubtasks(proj, parentId).filter((t) => t.id !== child.id);
    child.order = newSiblings.length ? Math.max(...newSiblings.map((t) => t.order)) + 1 : 0;
    save();
  }

  // Переставляет задачу так, чтобы она стала соседом (тем же уровнем
  // вложенности и разделом) задачи targetId — непосредственно перед ней
  // или сразу после (position = "before"/"after"). Это и есть ручная
  // сортировка перетаскиванием: пересчитывает order у всех соседей по
  // новому списку, чтобы порядок совпал с тем, что нарисовано на экране.
  function reorderTask(taskId, targetId, position) {
    if (taskId === targetId) return;
    const proj = findTaskOwnerProject(taskId);
    const targetProj = findTaskOwnerProject(targetId);
    // как и вложенность, ручная сортировка работает только внутри одного проекта
    if (!proj || !targetProj || proj.id !== targetProj.id) return;
    const task = proj.tasks.find((t) => t.id === taskId);
    const target = proj.tasks.find((t) => t.id === targetId);
    if (!task || !target) return;
    // нельзя переставить задачу рядом с её же потомком — иначе родителем
    // task стал бы кто-то из её собственного поддерева
    if (isDescendantTaskOf(target.id, task.id)) return;

    // В "Структуре" верхнеуровневые задачи — отдельная WBS-очередь (общее
    // поле order, не привязанное к разделу): перетаскивание меняет только
    // порядок, а не статус задачи — иначе он тихо менялся бы вместе с
    // позицией у обеих задач.
    const isStructureTopLevel = state.view === "structure" && !task.parentTaskId && !target.parentTaskId;
    if (!isStructureTopLevel) {
      task.parentTaskId = target.parentTaskId;
      task.sectionId = target.sectionId;
    }

    const siblings = isStructureTopLevel
      ? proj.tasks.filter((t) => !t.parentTaskId && t.id !== task.id).sort((a, b) => a.order - b.order)
      : proj.tasks.filter((t) => t.parentTaskId === target.parentTaskId && t.sectionId === target.sectionId && t.id !== task.id).sort((a, b) => a.order - b.order);
    const targetIdx = siblings.findIndex((t) => t.id === target.id);
    siblings.splice(position === "before" ? targetIdx : targetIdx + 1, 0, task);
    siblings.forEach((t, i) => { t.order = i; });
    save();
  }

  // ---------- отрисовка: вид "Список" (те же разделы, но строками, а не колонками) ----------

  // Перерисовывает список: те же разделы-статусы, что и на доске, но
  // задачи внутри показаны компактными строками, а не карточками.
  function renderList() {
    const proj = getActiveProject();
    const q = searchInput.value.trim();
    const contentProjects = getContentProjects(proj);
    listEl.innerHTML = "";

    proj.sections.forEach((section) => {
      const rows = collectSectionTasks(proj, section, contentProjects, q);

      const block = document.createElement("div");
      block.className = "list-section";
      block.innerHTML = `
        <div class="list-section-head">
          <input class="section-name" value="${escapeHtml(section.name)}" data-section-id="${section.id}">
          <span class="section-count">${rows.length}</span>
          <button class="section-del" data-section-id="${section.id}" title="Удалить раздел">×</button>
        </div>
        <div class="list-rows" data-section-id="${section.id}" data-section-name="${escapeHtml(section.name)}"></div>
        ${quickAddRowHtml(section.id)}
      `;

      const rowsEl = block.querySelector(".list-rows");
      if (rows.length === 0) {
        rowsEl.innerHTML = `<div class="empty-hint">Нет задач</div>`;
      } else {
        rowsEl.innerHTML = rows.map((r) => rowHtml(r.task, r.proj)).join("");
      }
      listEl.appendChild(block);
    });

    bindListEvents();
  }

  // HTML одной строки задачи в списке (аналог taskCardHtml, но для
  // компактного строчного вида).
  function rowHtml(task, proj) {
    const bits = [];
    const eff = getEffectiveDates(proj, task);
    if (eff.due) bits.push(`<span class="badge badge-due ${isOverdue(proj, task) ? "overdue" : ""}"${eff.auto ? ' title="Вычислено по подзадачам"' : ""}>${formatDue(eff.due)}</span>`);
    if (task.priority && task.priority !== "medium") bits.push(`<span class="badge badge-priority-${task.priority}">${priorityLabel(task.priority)}</span>`);
    const subs = getSubtasks(proj, task.id);
    if (subs.length) {
      const done = subs.filter((s) => s.completed).length;
      bits.push(`<span class="badge badge-subtasks ${done === subs.length ? "all-done" : ""}">☑ ${done}/${subs.length}</span>`);
    }
    if (!task.completed) {
      const blockers = getBlockingDependencies(proj, task);
      if (blockers.length) {
        bits.push(`<span class="badge badge-blocked" title="Ждёт выполнения: ${escapeHtml(blockers.map((b) => b.title).join(", "))}">⛔ ждёт</span>`);
      }
    }
    bits.unshift(syncStatusBadgeHtml(task));
    bits.push(autoTagsHtml(proj, task));
    task.tags.forEach((t) => bits.push(`<span class="tag-chip">${escapeHtml(t)}</span>`));
    const aName = assigneeName(task);
    const avatar = aName ? `<span class="avatar" title="${escapeHtml(aName)}">${initials(aName)}</span>` : "";
    return `
      <div class="list-row ${task.completed ? "completed" : ""}" draggable="true" data-task-id="${task.id}">
        <span class="row-check ${task.completed ? "checked" : ""}" data-task-id="${task.id}">✓</span>
        <span class="row-title${isUnreadForMe(task) ? " title-unread" : ""}">${escapeHtml(task.title)}</span>
        <span class="row-tags">${bits.join("")}</span>
        ${avatar}
      </div>
    `;
  }

  // Обработчики для списка: чекбокс выполнения, клик по строке открывает
  // задачу, перетаскивание между разделами и вложение строки в строку —
  // всё то же самое, что и на доске, только для строчного вида.
  function bindListEvents() {
    listEl.querySelectorAll(".section-name").forEach((input) => {
      input.addEventListener("change", () => {
        const sec = findSection(input.dataset.sectionId);
        if (sec) { sec.name = input.value.trim() || sec.name; commit(); }
      });
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
    });

    listEl.querySelectorAll(".section-del").forEach((btn) => {
      btn.addEventListener("click", () => deleteSection(btn.dataset.sectionId));
    });

    bindQuickAddEvents(listEl);

    listEl.querySelectorAll(".row-check").forEach((chk) => {
      chk.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleComplete(chk.dataset.taskId);
      });
    });

    listEl.querySelectorAll(".list-row").forEach((row) => {
      const taskId = row.dataset.taskId;
      row.addEventListener("click", () => openDetail(taskId));
      row.addEventListener("dragstart", (e) => {
        dragTaskId = taskId;
        row.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
      });
      row.addEventListener("dragend", () => row.classList.remove("dragging"));
      bindNestDragEvents(row, taskId);
    });

    listEl.querySelectorAll(".list-rows").forEach((zone) => {
      zone.addEventListener("dragover", (e) => e.preventDefault());
      zone.addEventListener("drop", (e) => {
        e.preventDefault();
        if (!dragTaskId) return;
        moveTaskToSection(dragTaskId, zone.dataset.sectionId, zone.dataset.sectionName);
        dragTaskId = null;
      });
    });
  }

  // Если у задачи есть незавершённые подзадачи (на любую глубину) —
  // спрашивает подтверждение, прежде чем отмечать её выполненной; если
  // всё уже выполнено, пропускает вопрос молча. Используется только при
  // переходе В "выполнено" — снятие галочки вопросов не задаёт.
  async function confirmCompleteWithActiveChildren(proj, task) {
    const activeDescendants = getTaskDescendantIds(proj, task.id)
      .filter((id) => id !== task.id)
      .map((id) => proj.tasks.find((t) => t.id === id))
      .filter((t) => t && !t.completed);
    if (!activeDescendants.length) return true;
    const names = activeDescendants.slice(0, 5).map((t) => `«${t.title}»`).join(", ");
    const rest = activeDescendants.length > 5 ? ` и ещё ${activeDescendants.length - 5}` : "";
    return showConfirm(`У этой задачи есть незавершённые подзадачи: ${names}${rest}. Всё равно отметить как выполненную?`, "Отметить выполненной");
  }

  // Переключает "выполнена / не выполнена" у задачи (используется чекбоксом
  // в списке, дереве и панели деталей).
  async function toggleComplete(taskId) {
    const proj = findTaskOwnerProject(taskId);
    if (!proj) return;
    const task = proj.tasks.find((t) => t.id === taskId);
    if (!task) return;
    if (!task.completed && !(await confirmCompleteWithActiveChildren(proj, task))) return;
    task.completed = !task.completed;
    commit();
  }

  // ---------- отрисовка: виды "По статусам" и "Структура" (иерархический список) ----------

  // Рисует одну строку задачи в виде-дереве (используется и видом "По
  // статусам", и видом "Структура") и рекурсивно дорисовывает все её
  // подзадачи под ней с увеличенным отступом. Глубина вложенности НЕ
  // ограничена — рекурсия идёт, пока есть подзадачи; ограничение "depth-4"
  // в CSS-классе — это только чтобы фон строки не темнел до бесконечности,
  // на саму возможность вложенности оно не влияет.
  // Рисует направляющие линии перед строкой задачи так, чтобы сразу было
  // видно, к какой ветке дерева она относится — как в файловых деревьях
  // IDE: "├" у задачи, за которой следуют ещё соседи на этом же уровне, и
  // "└" у последней в списке (после неё линия обрывается, а не идёт дальше
  // вникуда). continuesStack[i] = true означает "предок на уровне i имеет
  // ещё соседей ниже — линия в этой колонке продолжается сквозь всех его
  // потомков"; false — у предка на этом уровне это была последняя ветка,
  // значит и линия там уже закончилась, колонка остаётся пустой.
  function buildIndentGuidesHtml(depth, continuesStack) {
    let html = "";
    for (let i = 0; i < depth - 1; i++) {
      html += `<span class="indent-guide${continuesStack[i] ? "" : " indent-guide-blank"}"></span>`;
    }
    if (depth > 0) {
      const selfContinues = continuesStack[depth - 1];
      html += `<span class="indent-elbow${selfContinues ? " indent-elbow-mid" : " indent-elbow-last"}"></span>`;
    }
    return html;
  }

  function appendTaskRow(rowsEl, task, depth, proj, q, statusLookup, continuesStack) {
    const children = getSubtasks(proj, task.id)
      .filter((t) => matchesSearch(proj, t, q))
      .filter((t) => !t.archived && (state.showCompleted || !t.completed))
      .sort((a, b) => a.order - b.order);
    const hasChildren = getSubtasks(proj, task.id).length > 0;
    const collapsed = collapsedTreeTasks.has(task.id);
    const aName = assigneeName(task);
    const statusLabel = statusLookup ? statusLookup(task) : null;
    const eff = getEffectiveDates(proj, task);

    const row = document.createElement("div");
    row.className = "tree-row depth-" + Math.min(depth, 4) + (task.completed ? " completed" : "");
    row.dataset.taskId = task.id;
    row.draggable = true;
    const guides = buildIndentGuidesHtml(depth, continuesStack);
    row.innerHTML = `
      ${guides}
      ${hasChildren ? `<button class="chevron${collapsed ? "" : " expanded"}" data-toggle-tree="${task.id}" aria-label="${collapsed ? "Развернуть подзадачи" : "Свернуть подзадачи"}" aria-expanded="${!collapsed}">▶</button>` : `<span class="chevron-spacer"></span>`}
      <span class="row-check ${task.completed ? "checked" : ""}" data-tree-toggle="${task.id}">✓</span>
      <span class="tree-title${isUnreadForMe(task) ? " title-unread" : ""}" data-tree-open="${task.id}">${escapeHtml(task.title)}</span>
      ${statusLabel ? `<span class="status-chip">${escapeHtml(statusLabel)}</span>` : ""}
      ${syncStatusBadgeHtml(task)}
      ${eff.due ? `<span class="badge badge-due ${isOverdue(proj, task) ? "overdue" : ""}"${eff.auto ? ' title="Вычислено по подзадачам"' : ""}>${formatDue(eff.due)}</span>` : ""}
      ${task.priority && task.priority !== "medium" ? `<span class="badge badge-priority-${task.priority}">${priorityLabel(task.priority)}</span>` : ""}
      ${!task.completed && getBlockingDependencies(proj, task).length ? `<span class="badge badge-blocked" title="Ждёт выполнения: ${escapeHtml(getBlockingDependencies(proj, task).map((b) => b.title).join(", "))}">⛔ ждёт</span>` : ""}
      ${autoTagsHtml(proj, task)}
      ${task.tags.map((t) => `<span class="tag-chip">${escapeHtml(t)}</span>`).join("")}
      ${aName ? `<span class="avatar" title="${escapeHtml(aName)}">${initials(aName)}</span>` : ""}
      <span class="tree-actions">
        <button data-outdent="${task.id}" title="Понизить уровень вложенности" ${depth === 0 ? "disabled" : ""}>←</button>
        <button data-indent="${task.id}" title="Вложить в предыдущую задачу">→</button>
        <button data-up="${task.id}" title="Переместить выше">↑</button>
        <button data-down="${task.id}" title="Переместить ниже">↓</button>
      </span>
    `;
    rowsEl.appendChild(row);
    if (!collapsed) {
      children.forEach((c, idx) => {
        const childContinues = idx < children.length - 1;
        appendTaskRow(rowsEl, c, depth + 1, proj, q, statusLookup, [...continuesStack, childContinues]);
      });
    }
  }

  // Вид "По статусам": то же дерево задач/подзадач, но сгруппированное по
  // разделам (статусам) проекта — как на доске, только строками с
  // возможностью раскрыть/свернуть подзадачи и кнопками "вложить/вынести".
  function renderTree() {
    const proj = getActiveProject();
    const q = searchInput.value.trim();
    const contentProjects = getContentProjects(proj);
    treeEl.innerHTML = "";

    proj.sections.forEach((section) => {
      const rows = collectSectionTasks(proj, section, contentProjects, q);

      const block = document.createElement("div");
      block.className = "tree-section";
      block.innerHTML = `
        <div class="tree-section-head">${escapeHtml(section.name)} <span class="section-count">${rows.length}</span></div>
        <div class="tree-rows" data-section-id="${section.id}" data-section-name="${escapeHtml(section.name)}"></div>
        ${quickAddRowHtml(section.id)}
      `;
      const rowsEl = block.querySelector(".tree-rows");
      rows.forEach((r) => appendTaskRow(rowsEl, r.task, 0, r.proj, q, null, []));
      treeEl.appendChild(block);
    });

    bindTreeEvents();
  }

  // Вид "Структура" (чистая иерархия проекта, как в MS Project): сверху —
  // одна строка с самим проектом как корнем, а под ней ВСЕ задачи,
  // подзадачи И подпроекты (со своими задачами, рекурсивно) одним общим
  // деревом без деления на колонки/разделы по статусу. Статус задачи при
  // этом не теряется — показывается небольшим бейджиком на строке задачи.
  function renderStructure() {
    const proj = getActiveProject();
    const q = searchInput.value.trim();
    treeEl.innerHTML = "";

    const rootIds = new Set(getProjectDescendantIds(proj.id));
    let totalAll = 0, doneAll = 0;
    state.projects.forEach((p) => { if (rootIds.has(p.id)) { totalAll += p.tasks.length; doneAll += p.tasks.filter((t) => t.completed).length; } });
    const defaultSectionId = proj.sections[0].id;

    const block = document.createElement("div");
    block.className = "tree-section";
    block.innerHTML = `
      <div class="tree-project-root">
        <span class="dot" style="background:${proj.color}"></span>
        <span class="tree-project-root-name">${escapeHtml(proj.name)}</span>
        <span class="section-count">${doneAll}/${totalAll}</span>
      </div>
      <div class="tree-rows" data-section-id="${defaultSectionId}" data-section-name="${escapeHtml(proj.sections[0].name)}"></div>
      ${quickAddRowHtml(defaultSectionId)}
    `;
    const rowsEl = block.querySelector(".tree-rows");

    renderStructureBranch(rowsEl, proj, 0, [], q);

    treeEl.appendChild(block);
    bindTreeEvents();
  }

  // Рекурсивно дорисовывает содержимое одного проекта (его собственные
  // задачи верхнего уровня + прямые подпроекты) внутри общего дерева
  // "Структуры" — так подпроекты становятся не просто ссылкой в сайдбаре,
  // а полноценной веткой того же дерева, со своими задачами внутри.
  function renderStructureBranch(rowsEl, proj, depth, continuesStack, q) {
    const sectionsById = {};
    proj.sections.forEach((s) => { sectionsById[s.id] = s.name; });
    const statusLookup = (task) => sectionsById[task.sectionId] || "";

    // Порядок верхнеуровневых задач в "Структуре" — это отдельная,
    // стабильная WBS-последовательность (общее поле order, без группировки
    // по разделу): смена статуса задачи не должна переставлять её в списке.
    const topTasks = proj.tasks
      .filter((t) => !t.parentTaskId)
      .filter((t) => matchesSearch(proj, t, q))
      .filter((t) => !t.archived && (state.showCompleted || !t.completed))
      .sort((a, b) => a.order - b.order);
    const subprojects = state.projects.filter((p) => p.parentId === proj.id);
    const combinedLen = topTasks.length + subprojects.length;
    let i = 0;

    topTasks.forEach((t) => {
      const childContinues = i < combinedLen - 1;
      appendTaskRow(rowsEl, t, depth, proj, q, statusLookup, [...continuesStack, childContinues]);
      i++;
    });
    subprojects.forEach((sp) => {
      const childContinues = i < combinedLen - 1;
      const childStack = [...continuesStack, childContinues];
      appendProjectHeaderRow(rowsEl, sp, depth, childStack);
      if (!collapsedProjects.has(sp.id)) renderStructureBranch(rowsEl, sp, depth + 1, childStack, q);
      i++;
    });
  }

  // Строка-заголовок подпроекта внутри общего дерева (и в "Структуре", и в
  // "Гантте"): кружок цвета проекта + название + сводный счётчик
  // выполнено/всего по нему и всем ЕГО подпроектам (getProjectStats). Клик
  // по названию — перейти в этот подпроект, по стрелке — свернуть/развернуть
  // его ветку прямо здесь, не покидая текущий экран.
  function appendProjectHeaderRow(rowsEl, proj, depth, continuesStack) {
    const stats = getProjectStats(proj.id);
    const hasContent = proj.tasks.some((t) => !t.parentTaskId) || state.projects.some((p) => p.parentId === proj.id);
    const collapsed = collapsedProjects.has(proj.id);
    const guides = buildIndentGuidesHtml(depth, continuesStack);

    const row = document.createElement("div");
    row.className = "tree-row structure-project-row depth-" + Math.min(depth, 4);
    row.dataset.projectId = proj.id;
    row.innerHTML = `
      ${guides}
      ${hasContent ? `<button class="chevron${collapsed ? "" : " expanded"}" data-toggle-structure-project="${proj.id}" aria-label="${collapsed ? "Развернуть подпроект" : "Свернуть подпроект"}" aria-expanded="${!collapsed}">▶</button>` : `<span class="chevron-spacer"></span>`}
      <span class="dot" style="background:${proj.color}"></span>
      <span class="tree-title structure-project-title" data-open-project="${proj.id}">${escapeHtml(proj.name)}</span>
      <span class="section-count">${stats.completed}/${stats.total}</span>
    `;
    rowsEl.appendChild(row);
  }

  // Обработчики для видов "По статусам" и "Структура": сворачивание строки
  // со стрелкой, чекбокс выполнения, открытие задачи, кнопки
  // вложить/вынести/выше/ниже, перетаскивание строк (вложение и перенос
  // между разделами).
  function bindTreeEvents() {
    // Строки-подпроекты (только в виде "Структура"): стрелка сворачивает/
    // разворачивает ветку подпроекта на месте, клик по названию — переходит
    // в этот подпроект как в активный проект.
    treeEl.querySelectorAll("[data-toggle-structure-project]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.dataset.toggleStructureProject;
        setProjectCollapsed(id, !collapsedProjects.has(id));
        renderStructure();
      });
    });
    treeEl.querySelectorAll("[data-open-project]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        state.screen = "project";
        state.activeProjectId = el.dataset.openProject;
        closeDetail();
        commit();
      });
    });

    treeEl.querySelectorAll(".chevron[data-toggle-tree]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.dataset.toggleTree;
        setTreeTaskCollapsed(id, !collapsedTreeTasks.has(id));
        if (state.view === "structure") renderStructure(); else renderTree();
      });
    });

    treeEl.querySelectorAll("[data-tree-toggle]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleComplete(el.dataset.treeToggle);
      });
    });

    treeEl.querySelectorAll("[data-tree-open]").forEach((el) => {
      el.addEventListener("click", () => openDetail(el.dataset.treeOpen));
    });

    treeEl.querySelectorAll("[data-indent]").forEach((btn) => {
      btn.addEventListener("click", (e) => { e.stopPropagation(); indentTask(btn.dataset.indent); });
    });
    treeEl.querySelectorAll("[data-outdent]").forEach((btn) => {
      btn.addEventListener("click", (e) => { e.stopPropagation(); outdentTask(btn.dataset.outdent); });
    });
    treeEl.querySelectorAll("[data-up]").forEach((btn) => {
      btn.addEventListener("click", (e) => { e.stopPropagation(); moveTaskUpDown(btn.dataset.up, -1); });
    });
    treeEl.querySelectorAll("[data-down]").forEach((btn) => {
      btn.addEventListener("click", (e) => { e.stopPropagation(); moveTaskUpDown(btn.dataset.down, 1); });
    });

    treeEl.querySelectorAll(".tree-row:not(.structure-project-row)").forEach((row) => {
      const taskId = row.dataset.taskId;
      row.addEventListener("dragstart", (e) => {
        dragTaskId = taskId;
        row.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
      });
      row.addEventListener("dragend", () => row.classList.remove("dragging"));
      bindNestDragEvents(row, taskId);
    });

    treeEl.querySelectorAll(".tree-rows").forEach((zone) => {
      zone.addEventListener("dragover", (e) => { if (dragTaskId) e.preventDefault(); });
      zone.addEventListener("drop", (e) => {
        e.preventDefault();
        if (!dragTaskId) return;
        const proj = findTaskOwnerProject(dragTaskId);
        const task = proj ? proj.tasks.find((t) => t.id === dragTaskId) : null;
        if (task) {
          task.parentTaskId = null;
          // Раздел этой зоны может принадлежать ДРУГОМУ проекту (у
          // "Структуры" — предку/соседнему подпроекту, у "По статусам" —
          // активному проекту, когда задача на самом деле из подпроекта):
          // тогда ищем (или заводим) в СОБСТВЕННОМ проекте задачи раздел
          // с тем же именем — просто скопировать чужой id раздела нельзя.
          let targetId = zone.dataset.sectionId;
          if (!proj.sections.some((s) => s.id === targetId)) {
            let matched = proj.sections.find((s) => s.name.trim().toLowerCase() === zone.dataset.sectionName.trim().toLowerCase());
            if (!matched) {
              matched = { id: uid(), name: zone.dataset.sectionName };
              proj.sections.push(matched);
            }
            targetId = matched.id;
          }
          task.sectionId = targetId;
          const siblings = proj.tasks.filter((t) => t.sectionId === task.sectionId && !t.parentTaskId && t.id !== task.id);
          task.order = siblings.length ? Math.max(...siblings.map((t) => t.order)) + 1 : 0;
          save();
        }
        dragTaskId = null;
        renderAll();
      });
    });

    bindQuickAddEvents(treeEl);
  }

  // Кнопка "→ вложить": делает задачу подзадачей соседней строки НАД ней
  // (той, что стоит непосредственно выше на том же уровне вложенности).
  function indentTask(taskId) {
    const proj = findTaskOwnerProject(taskId);
    if (!proj) return;
    const task = proj.tasks.find((t) => t.id === taskId);
    if (!task) return;
    const siblings = getSiblings(proj, task);
    const idx = siblings.findIndex((t) => t.id === taskId);
    if (idx <= 0) return;
    const newParent = siblings[idx - 1];
    if (isDescendantTaskOf(newParent.id, taskId)) return;
    task.parentTaskId = newParent.id;
    task.sectionId = newParent.sectionId;
    invalidateTreeCache();
    const newSiblings = getSubtasks(proj, newParent.id);
    task.order = newSiblings.length ? Math.max(...newSiblings.map((t) => t.order)) + 1 : 0;
    commit();
  }

  // Кнопка "← понизить уровень": вынимает задачу из-под текущего родителя
  // и делает её подзадачей "дедушки" (или задачей верхнего уровня, если
  // родитель был верхнего уровня).
  function outdentTask(taskId) {
    const proj = findTaskOwnerProject(taskId);
    if (!proj) return;
    const task = proj.tasks.find((t) => t.id === taskId);
    if (!task || !task.parentTaskId) return;
    const oldParent = proj.tasks.find((t) => t.id === task.parentTaskId);
    const newParentId = oldParent ? oldParent.parentTaskId : null;
    task.parentTaskId = newParentId;
    if (oldParent) task.sectionId = oldParent.sectionId;
    const newSiblings = proj.tasks.filter((t) => t.parentTaskId === newParentId && t.sectionId === task.sectionId && t.id !== task.id);
    task.order = newSiblings.length ? Math.max(...newSiblings.map((t) => t.order)) + 1 : 0;
    commit();
  }

  // Кнопки "↑ выше" / "↓ ниже": меняет задачу местами с соседом по
  // порядку (dir = -1 вверх, +1 вниз).
  function moveTaskUpDown(taskId, dir) {
    const proj = findTaskOwnerProject(taskId);
    if (!proj) return;
    const task = proj.tasks.find((t) => t.id === taskId);
    if (!task) return;
    const siblings = getSiblings(proj, task);
    const idx = siblings.findIndex((t) => t.id === taskId);
    const swapIdx = idx + dir;
    if (swapIdx < 0 || swapIdx >= siblings.length) return;
    const other = siblings[swapIdx];
    const tmpOrder = task.order;
    task.order = other.order;
    other.order = tmpOrder;
    commit();
  }

  // ---------- отрисовка: диаграмма Ганта ----------

  // Рисует диаграмму Ганта: слева — названия задач деревом (с
  // отступами и стрелками сворачивания), справа — шкала дней и цветные
  // полосы. У задач с подзадачами полоса вычисляется автоматически по
  // датам подзадач (тонкая summary-полоса, как в MS Project).
  // Диапазон дат проекта целиком: минимальное начало и максимальный срок
  // среди ВСЕХ его задач верхнего уровня (эффективные, с учётом
  // авторасчёта по подзадачам) И рекурсивно всех его подпроектов — чтобы
  // у строки-подпроекта в Гантте была своя сводная полоса-"фаза".
  function getProjectDateRange(project) {
    const starts = [], dues = [];
    project.tasks.forEach((t) => {
      if (t.parentTaskId) return;
      const eff = getEffectiveDates(project, t);
      if (eff.start) starts.push(eff.start);
      if (eff.due) dues.push(eff.due);
    });
    state.projects.filter((p) => p.parentId === project.id).forEach((sp) => {
      const r = getProjectDateRange(sp);
      if (r.start) starts.push(r.start);
      if (r.due) dues.push(r.due);
    });
    return {
      start: starts.length ? starts.reduce((a, b) => (a < b ? a : b)) : "",
      due: dues.length ? dues.reduce((a, b) => (a > b ? a : b)) : ""
    };
  }

  function renderGantt() {
    const rootProj = getActiveProject();
    const q = searchInput.value.trim();
    const dayWidth = state.ganttDayWidth; // ширина одного дня в пикселях на шкале времени — настраивается ползунком масштаба

    ganttZoomSlider.value = dayWidth;
    ganttZoomValueEl.textContent = dayWidth + " px/день";

    // Собираем плоский список строк для отрисовки: обходим задачи каждого
    // проекта (текущего и рекурсивно всех подпроектов) и "разворачиваем"
    // подзадачи, пропуская свёрнутые ветки — получается единый список
    // {тип задача/подпроект, глубина, continuesStack для направляющих линий}.
    const rows = [];

    function walkTask(task, proj, depth, continuesStack) {
      rows.push({ type: "task", task, proj, depth, continuesStack });
      if (collapsedTreeTasks.has(task.id)) return;
      const children = getSubtasks(proj, task.id)
        .filter((t) => matchesSearch(proj, t, q))
        .filter((t) => !t.archived && (state.showCompleted || !t.completed))
        .sort((a, b) => a.order - b.order);
      children.forEach((c, idx) => {
        const childContinues = idx < children.length - 1;
        walkTask(c, proj, depth + 1, [...continuesStack, childContinues]);
      });
    }

    function walkProject(proj, depth, continuesStack) {
      const topTasks = [];
      proj.sections.forEach((section) => {
        proj.tasks
          .filter((t) => t.sectionId === section.id && !t.parentTaskId)
          .filter((t) => matchesSearch(proj, t, q))
          .filter((t) => !t.archived && (state.showCompleted || !t.completed))
          .sort((a, b) => a.order - b.order)
          .forEach((t) => topTasks.push(t));
      });
      const subprojects = state.projects.filter((p) => p.parentId === proj.id);
      const combinedLen = topTasks.length + subprojects.length;
      let i = 0;
      topTasks.forEach((t) => {
        const childContinues = i < combinedLen - 1;
        walkTask(t, proj, depth, [...continuesStack, childContinues]);
        i++;
      });
      subprojects.forEach((sp) => {
        const childContinues = i < combinedLen - 1;
        const childStack = [...continuesStack, childContinues];
        rows.push({ type: "project", project: sp, depth, continuesStack: childStack });
        if (!collapsedProjects.has(sp.id)) walkProject(sp, depth + 1, childStack);
        i++;
      });
    }
    walkProject(rootProj, 0, []);

    if (!rows.length) {
      ganttEl.innerHTML = `<div class="dash-empty" style="padding:24px;">Нет задач для отображения</div>`;
      return;
    }

    // Определяем видимый диапазон шкалы: от самой ранней даты минус 2 дня
    // запаса, до самой поздней даты плюс 4 дня запаса (чтобы полосы не
    // упирались в край).
    const today = todayStr();
    const allDates = [];
    rows.forEach((row) => {
      const eff = row.type === "task" ? getEffectiveDates(row.proj, row.task) : getProjectDateRange(row.project);
      if (eff.start) allDates.push(eff.start);
      if (eff.due) allDates.push(eff.due);
    });
    const rangeBase = allDates.length ? allDates.reduce((a, b) => (a < b ? a : b)) : today;
    const rangeMax = allDates.length ? allDates.reduce((a, b) => (a > b ? a : b)) : today;

    const startD = strToDate(rangeBase);
    startD.setDate(startD.getDate() - 2);
    const endD = strToDate(rangeMax);
    endD.setDate(endD.getDate() + 4);
    const totalDays = Math.max(10, Math.round((endD - startD) / 86400000) + 1);

    // Смещение даты от начала шкалы в днях (пригодится для позиции полосы в пикселях).
    function dayOffset(dateStr) {
      return Math.round((strToDate(dateStr) - startD) / 86400000);
    }

    let headerHtml = "";
    for (let i = 0; i < totalDays; i++) {
      const d = new Date(startD);
      d.setDate(d.getDate() + i);
      const dStr = dateToStr(d);
      const isToday = dStr === today;
      const isWeekend = d.getDay() === 0 || d.getDay() === 6;
      headerHtml += `<div class="gantt-day ${isToday ? "is-today" : ""} ${isWeekend ? "is-weekend" : ""}" style="width:${dayWidth}px">${d.getDate()}</div>`;
    }

    // Строка с названиями месяцев над строкой чисел — иначе шкала из одних
    // цифр не даёт понять, где какой месяц. Считаем длину подряд идущих
    // дней внутри одного месяца и рисуем один блок на каждый месяц.
    let monthsHtml = "";
    for (let i = 0; i < totalDays;) {
      const d = new Date(startD);
      d.setDate(d.getDate() + i);
      const monthKey = d.getFullYear() + "-" + d.getMonth();
      let span = 0;
      while (i < totalDays) {
        const dd = new Date(startD);
        dd.setDate(dd.getDate() + i);
        if (dd.getFullYear() + "-" + dd.getMonth() !== monthKey) break;
        span++;
        i++;
      }
      const label = d.toLocaleDateString("ru-RU", { month: "long", year: "numeric" });
      monthsHtml += `<div class="gantt-month" style="width:${span * dayWidth}px">${escapeHtml(label.charAt(0).toUpperCase() + label.slice(1))}</div>`;
    }

    // Переменные для CSS-заливки выходных вдоль ВСЕХ строк (не только в
    // шапке) — см. .gantt-timeline-cell в style.css. Паттерн повторяется
    // каждые 7 дней; background-position сдвигает его так, чтобы закрашенные
    // столбцы совпали с реальными субботами/воскресеньями от startD.
    ganttEl.style.setProperty("--gantt-day-width", dayWidth + "px");
    ganttEl.style.setProperty("--gantt-weekend-offset", (-(startD.getDay()) * dayWidth) + "px");

    function barHtmlFor(s, e, color, completed, title, isSummary, openTaskId) {
      if (!s || !e) return "";
      const off = dayOffset(s);
      const span = Math.max(1, Math.round((strToDate(e) - strToDate(s)) / 86400000) + 1);
      const summaryCls = isSummary ? " gantt-bar-summary" : "";
      const openAttr = openTaskId ? `data-open="${openTaskId}" ` : "";
      return `<div ${openAttr}class="gantt-bar${summaryCls} ${completed ? "done" : ""}" style="left:${off * dayWidth}px;width:${Math.max(dayWidth - 4, span * dayWidth - 4)}px;background:${completed ? "var(--text-faint)" : color}" title="${escapeHtml(title)}: ${s} → ${e}"></div>`;
    }

    let bodyHtml = "";
    rows.forEach((row) => {
      const guides = buildIndentGuidesHtml(row.depth, row.continuesStack);

      if (row.type === "project") {
        const sp = row.project;
        const range = getProjectDateRange(sp);
        const hasContent = sp.tasks.some((t) => !t.parentTaskId) || state.projects.some((p) => p.parentId === sp.id);
        const collapsed = collapsedProjects.has(sp.id);
        const barHtml = barHtmlFor(range.start, range.due, sp.color, false, sp.name + " (подпроект)", true);
        bodyHtml += `
          <div class="gantt-row gantt-row-project">
            <div class="gantt-name-cell structure-project-row" title="${escapeHtml(sp.name)}">
              ${guides}
              ${hasContent ? `<button class="chevron${collapsed ? "" : " expanded"}" data-toggle-structure-project="${sp.id}" aria-label="${collapsed ? "Развернуть подпроект" : "Свернуть подпроект"}" aria-expanded="${!collapsed}">▶</button>` : `<span class="chevron-spacer"></span>`}
              <span class="dot" style="background:${sp.color}"></span>
              <span class="gantt-title structure-project-title" data-open-project="${sp.id}">${escapeHtml(sp.name)}</span>
              <div class="gantt-resize-handle" title="Потяните, чтобы изменить ширину колонки"></div>
            </div>
            <div class="gantt-timeline-cell" style="width:${totalDays * dayWidth}px">${barHtml}</div>
          </div>
        `;
        return;
      }

      const { task, proj } = row;
      const hasChildren = getSubtasks(proj, task.id).length > 0;
      const collapsed = collapsedTreeTasks.has(task.id);
      const eff = getEffectiveDates(proj, task);
      const s = eff.start || eff.due;
      const e = eff.due || eff.start;
      const color = task.priority === "high" ? "var(--danger)" : task.priority === "low" ? "var(--success)" : "var(--accent)";
      const barHtml = barHtmlFor(s, e, color, task.completed, task.title, eff.auto && hasChildren, task.id);
      const blockers = task.completed ? [] : getBlockingDependencies(proj, task);
      const blockedIcon = blockers.length ? `<span class="gantt-blocked-icon" title="Ждёт выполнения: ${escapeHtml(blockers.map((b) => b.title).join(", "))}">⛔</span>` : "";
      bodyHtml += `
        <div class="gantt-row">
          <div class="gantt-name-cell" data-open="${task.id}" title="${escapeHtml(task.title)}">
            ${guides}
            ${hasChildren ? `<button class="chevron${collapsed ? "" : " expanded"}" data-toggle-tree="${task.id}" aria-label="${collapsed ? "Развернуть подзадачи" : "Свернуть подзадачи"}" aria-expanded="${!collapsed}">▶</button>` : `<span class="chevron-spacer"></span>`}
            <span class="gantt-title${isUnreadForMe(task) ? " title-unread" : ""}">${escapeHtml(task.title)}</span>
            ${syncStatusBadgeHtml(task)}
            ${blockedIcon}
            <div class="gantt-resize-handle" title="Потяните, чтобы изменить ширину колонки"></div>
          </div>
          <div class="gantt-timeline-cell" style="width:${totalDays * dayWidth}px">${barHtml}</div>
        </div>
      `;
    });

    ganttEl.style.setProperty("--gantt-name-width", state.ganttNameColWidth + "px");
    ganttEl.innerHTML = `
      <div class="gantt-header-row gantt-months-row">
        <div class="gantt-name-cell gantt-corner"></div>
        <div class="gantt-days" style="width:${totalDays * dayWidth}px">${monthsHtml}</div>
      </div>
      <div class="gantt-header-row gantt-days-row">
        <div class="gantt-name-cell gantt-corner">
          Задача
          <div class="gantt-resize-handle" title="Потяните, чтобы изменить ширину колонки"></div>
        </div>
        <div class="gantt-days" style="width:${totalDays * dayWidth}px">${headerHtml}</div>
      </div>
      ${bodyHtml}
    `;

    ganttEl.querySelectorAll("[data-open]").forEach((el) => {
      el.addEventListener("click", (e) => { e.stopPropagation(); openDetail(el.dataset.open); });
    });
    ganttEl.querySelectorAll("[data-open-project]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        state.screen = "project";
        state.activeProjectId = el.dataset.openProject;
        closeDetail();
        commit();
      });
    });
    ganttEl.querySelectorAll("[data-toggle-tree]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.dataset.toggleTree;
        setTreeTaskCollapsed(id, !collapsedTreeTasks.has(id));
        renderGantt();
      });
    });
    ganttEl.querySelectorAll("[data-toggle-structure-project]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.dataset.toggleStructureProject;
        setProjectCollapsed(id, !collapsedProjects.has(id));
        renderGantt();
      });
    });

    bindGanttColumnResize();
  }

  // Перетаскивание границы левой колонки с названиями задач на диаграмме
  // Ганта. У границы колонки — своя маленькая ручка в КАЖДОЙ строке (не
  // только в шапке), все они рядом друг с другом образуют одну сплошную
  // полосу для захвата на любой высоте. Ширина хранится в state, поэтому
  // переживает перезагрузку страницы, и применяется через CSS-переменную
  // сразу ко всей колонке (шапка + все строки читают одно и то же значение).
  function bindGanttColumnResize() {
    const handles = ganttEl.querySelectorAll(".gantt-resize-handle");
    if (!handles.length) return;
    let startX = 0;
    let startWidth = 0;
    let currentWidth = state.ganttNameColWidth;

    function onMove(e) {
      currentWidth = Math.max(140, Math.min(560, startWidth + (e.clientX - startX)));
      ganttEl.style.setProperty("--gantt-name-width", currentWidth + "px");
    }
    function onUp() {
      handles.forEach((h) => h.classList.remove("active"));
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      state.ganttNameColWidth = currentWidth;
      save();
    }
    handles.forEach((handle) => {
      handle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        startX = e.clientX;
        startWidth = state.ganttNameColWidth;
        handles.forEach((h) => h.classList.add("active"));
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
    });
  }

  // ---------- разделы проекта (статусы задач: "К выполнению", "В работе" и т.п.) ----------

  function findSection(sectionId) {
    return getActiveProject().sections.find((s) => s.id === sectionId);
  }

  // Добавляет новый пустой раздел (колонку) в текущий проект.
  function addSection() {
    const proj = getActiveProject();
    proj.sections.push({ id: uid(), name: "Новый раздел" });
    commit();
  }

  // Удаляет раздел; если в нём есть задачи — сначала спрашивает
  // подтверждение и удаляет их вместе со всеми вложенными подзадачами.
  async function deleteSection(sectionId) {
    const proj = getActiveProject();
    if (proj.sections.length <= 1) {
      await showAlert("Нельзя удалить последний раздел.");
      return;
    }
    const directTasks = proj.tasks.filter((t) => t.sectionId === sectionId);
    if (directTasks.length && !(await showConfirm("В разделе есть задачи. Удалить раздел вместе с задачами (и их подзадачами)?"))) return;
    const directIds = new Set(directTasks.map((t) => t.id));
    // корнями удаляемых поддеревьев считаем задачи, чей родитель НЕ из
    // этого же раздела — иначе получили бы отдельную запись в корзине на
    // каждую подзадачу вместо одной записи на всё дерево целиком
    const roots = directTasks.filter((t) => !t.parentTaskId || !directIds.has(t.parentTaskId));
    proj.sections = proj.sections.filter((s) => s.id !== sectionId);
    roots.forEach((t) => {
      const idsToRemove = new Set(getTaskDescendantIds(proj, t.id));
      trashTasks(proj, t, idsToRemove);
    });
    commit();
  }

  // ---------- задачи ----------

  // Создаёт новую задачу верхнего уровня в указанном разделе указанного проекта.
  function createTask(proj, sectionId, title) {
    const siblings = proj.tasks.filter((t) => t.sectionId === sectionId);
    const task = {
      id: uid(),
      sectionId,
      parentTaskId: null,
      title,
      notes: "",
      assigneeId: null,
      watchers: [],
      start: "",
      due: "",
      datesAuto: true,
      priority: "medium",
      estimateHours: null,
      tags: [],
      dependsOn: [],
      completed: false,
      archived: false,
      order: siblings.length ? Math.max(...siblings.map((t) => t.order)) + 1 : 0
    };
    proj.tasks.push(task);
    save();
    return task;
  }

  // Создаёт новую задачу и сразу делает её подзадачей parentTask — в ТОМ ЖЕ
  // проекте, которому принадлежит сама parentTask (а не обязательно в
  // активном проекте экрана: parentTask может быть задачей подпроекта,
  // если панель деталей открыта из вида "Структура"/"Гантт").
  function createSubtask(parentTask, title) {
    const proj = findTaskOwnerProject(parentTask.id) || getActiveProject();
    const t = createTask(proj, parentTask.sectionId, title);
    t.parentTaskId = parentTask.id;
    save();
    return t;
  }

  // Удаляет задачу вместе со всеми её подзадачами на любую глубину.
  // Убирает набор задач (обычно — задача и все её потомки) из проекта и
  // складывает их одной записью в корзину (state.trash), чтобы позже можно
  // было восстановить. Объекты задач переносятся как есть, без изменений.
  function trashTasks(proj, rootTask, idsToRemove) {
    const removedTasks = proj.tasks.filter((t) => idsToRemove.has(t.id));
    proj.tasks = proj.tasks.filter((t) => !idsToRemove.has(t.id));
    // подчищаем "висячие" зависимости у оставшихся задач, если они
    // ссылались на что-то из удалённого поддерева
    proj.tasks.forEach((t) => {
      if (t.dependsOn && t.dependsOn.some((id) => idsToRemove.has(id))) {
        t.dependsOn = t.dependsOn.filter((id) => !idsToRemove.has(id));
      }
    });
    if (openTaskId && idsToRemove.has(openTaskId)) closeDetail();
    const entry = {
      id: uid(),
      projectId: proj.id,
      projectName: proj.name,
      rootTaskId: rootTask.id,
      rootTitle: rootTask.title,
      deletedAt: new Date().toISOString(),
      tasks: removedTasks
    };
    state.trash.unshift(entry);
    // Корзина не должна расти бесконечно (она хранится в том же
    // localStorage, что и всё остальное состояние) — старейшие записи
    // сверх лимита стираются навсегда без возможности восстановления.
    if (state.trash.length > TRASH_LIMIT) state.trash.length = TRASH_LIMIT;
    return entry;
  }

  function deleteTask(taskId) {
    const proj = findTaskOwnerProject(taskId);
    if (!proj) return;
    const task = proj.tasks.find((t) => t.id === taskId);
    if (!task) return;
    const idsToRemove = new Set(getTaskDescendantIds(proj, taskId));
    const entry = trashTasks(proj, task, idsToRemove);
    commit();
    showToast(`Задача «${task.title}» удалена`, () => restoreFromTrash(entry.id));
  }

  // Восстанавливает запись из корзины обратно в её проект. Если раздел, в
  // котором была задача, с тех пор удалили — кладёт её в первый попавшийся
  // раздел проекта, чтобы задача не потерялась. Если родителя (для
  // подзадачи) больше нет — поднимает её на верхний уровень.
  function restoreFromTrash(entryId) {
    const idx = state.trash.findIndex((e) => e.id === entryId);
    if (idx === -1) return;
    const entry = state.trash[idx];
    const proj = state.projects.find((p) => p.id === entry.projectId);
    if (!proj) return;
    const existingIds = new Set(proj.tasks.map((t) => t.id));
    const restoredIds = new Set(entry.tasks.map((t) => t.id));
    entry.tasks.forEach((t) => {
      if (existingIds.has(t.id)) return;
      if (!proj.sections.some((s) => s.id === t.sectionId)) t.sectionId = proj.sections[0].id;
      if (t.parentTaskId && !restoredIds.has(t.parentTaskId) && !existingIds.has(t.parentTaskId)) t.parentTaskId = null;
      proj.tasks.push(t);
    });
    state.trash.splice(idx, 1);
    commit();
  }

  // Стирает одну запись из корзины навсегда (без возможности восстановить).
  function permanentlyDeleteFromTrash(entryId) {
    state.trash = state.trash.filter((e) => e.id !== entryId);
    save();
    renderTrash();
  }

  // Полностью очищает корзину — с подтверждением, т.к. это необратимо.
  async function emptyTrash() {
    if (!state.trash.length) return;
    if (!(await showConfirm("Полностью очистить корзину? Задачи будет невозможно восстановить.", "Очистить"))) return;
    state.trash = [];
    save();
    renderTrash();
  }

  // ---------- панель деталей задачи (справа) ----------

  // Наблюдатели (js/sync.js) — в отличие от единственного исполнителя,
  // это список из нескольких людей; каждый из них может отметить задачу
  // выполненной и писать заметку, как и исполнитель, но не создатель.
  function renderWatchers(task) {
    if (!state.users.length) {
      detailWatchers.innerHTML = `<div class="watchers-list-empty">Список людей пуст</div>`;
      return;
    }
    const watchers = new Set(task.watchers || []);
    detailWatchers.innerHTML = state.users.map((u) => `
      <label><input type="checkbox" data-watcher-id="${u.id}" ${watchers.has(u.id) ? "checked" : ""}> ${escapeHtml(u.name)}</label>
    `).join("");
    detailWatchers.querySelectorAll("[data-watcher-id]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const t = currentTask();
        if (!t) return;
        const set = new Set(t.watchers || []);
        if (cb.checked) set.add(cb.dataset.watcherId); else set.delete(cb.dataset.watcherId);
        t.watchers = [...set];
        commit(true);
      });
    });
  }

  // Открывает панель справа и заполняет все её поля данными выбранной
  // задачи: название, раздел, исполнитель, даты (с учётом авторасчёта по
  // подзадачам), приоритет, оценка часов, теги, заметки, хлебная крошка
  // до родителя и список подзадач.
  function openDetail(taskId) {
    const proj = findTaskOwnerProject(taskId);
    if (!proj) return;
    const task = proj.tasks.find((t) => t.id === taskId);
    if (!task) return;
    openTaskId = taskId;
    openTaskProjectId = proj.id;
    // Снимаем бейдж "новое"/"изменено" (js/sync.js) — сразу в памяти, на
    // сервер уходит в фоне. renderAll(true) тут же обновляет карточку под
    // модальным окном, иначе бейдж провисел бы до следующей перерисовки.
    if (window.TaskingSync && (task._isUnread || task._isChanged)) {
      task._isUnread = false;
      task._isChanged = false;
      stateVersion++; // иначе кэш getProjectStats (счётчик непрочитанных в сайдбаре) не обновится сразу
      window.TaskingSync.markViewed(taskId);
      renderAll(true);
    }

    detailPanel.hidden = false;
    detailComplete.classList.toggle("checked", task.completed);
    detailComplete.textContent = task.completed ? "✓" : "";
    detailComplete.setAttribute("aria-pressed", String(task.completed));
    detailComplete.setAttribute("aria-label", task.completed ? "Снять отметку о выполнении" : "Отметить выполненной");
    detailTitle.value = task.title;

    detailSection.innerHTML = proj.sections.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("");
    detailSection.value = task.sectionId;

    detailAssignee.innerHTML = `<option value="">Без исполнителя</option>` + state.users.map((u) => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join("");
    detailAssignee.value = task.assigneeId || "";

    renderWatchers(task);

    const hasChildren = getSubtasks(proj, task.id).length > 0;
    if (hasChildren) {
      const eff = getEffectiveDates(proj, task);
      const auto = eff.auto;
      detailStart.value = auto ? eff.start : (task.start || "");
      detailDue.value = auto ? eff.due : (task.due || "");
      detailStart.disabled = auto;
      detailDue.disabled = auto;
      datesAutoRow.hidden = false;
      datesAutoText.textContent = auto ? "Даты вычислены по подзадачам" : "Даты заданы вручную";
      datesAutoToggleBtn.textContent = auto ? "Задать вручную" : "Вернуть авторасчёт";
    } else {
      detailStart.value = task.start || "";
      detailDue.value = task.due || "";
      detailStart.disabled = false;
      detailDue.disabled = false;
      datesAutoRow.hidden = true;
    }
    syncDateBounds();
    renderDateOrderWarning();
    detailPriority.value = task.priority || "medium";
    detailEstimate.value = task.estimateHours != null ? task.estimateHours : "";
    detailAutoTags.innerHTML = autoTagsHtml(proj, task);
    detailTags.value = task.tags.join(", ");
    detailNotes.value = task.notes || "";

    if (task.parentTaskId) {
      const parent = proj.tasks.find((x) => x.id === task.parentTaskId);
      if (parent) {
        detailBreadcrumb.hidden = false;
        detailBreadcrumb.textContent = `↑ ${parent.title}`;
      } else {
        detailBreadcrumb.hidden = true;
      }
    } else {
      detailBreadcrumb.hidden = true;
    }

    subtaskAddInput.value = "";
    renderSubtaskSection();
    renderDepsSection();
    renderConflictWarning();

    // Если задачу назначили на вас, но создал её кто-то другой — сервер
    // всё равно примет только "выполнено" и заметку (см. gas/Code.gs,
    // ASSIGNEE_EDITABLE_TASK_FIELDS), остальные поля молча проигнорирует.
    // Блокируем их и в интерфейсе, чтобы это не было сюрпризом.
    const readOnly = task._canEdit === false;
    detailReadonlyBanner.hidden = !readOnly;
    detailTitle.readOnly = readOnly;
    detailSection.disabled = readOnly;
    detailAssignee.disabled = readOnly;
    detailStart.disabled = readOnly || detailStart.disabled;
    detailDue.disabled = readOnly || detailDue.disabled;
    detailPriority.disabled = readOnly;
    detailEstimate.disabled = readOnly;
    detailTags.disabled = readOnly;
    detailDelete.disabled = readOnly;
    datesAutoToggleBtn.disabled = readOnly;
    subtaskAddInput.disabled = readOnly;
    depsAddSelect.disabled = readOnly;
    detailWatchers.querySelectorAll("input").forEach((cb) => { cb.disabled = readOnly; });
    // Участник проекта, который видит эту задачу только потому, что видит
    // весь проект (не создатель, не исполнитель, не наблюдатель) — не
    // может даже отмечать её выполненной, в отличие от исполнителя/
    // наблюдателя (см. ASSIGNEE_EDITABLE_TASK_FIELDS в gas/Code.gs).
    detailComplete.disabled = task._canComplete === false;

    openModalFocus(detailPanel, detailTitle);
  }

  // Перерисовывает блок "Сначала выполнить": список уже добавленных
  // предшественников (красным — если реально мешают начать: не выполнены
  // или выполнены позже даты начала этой задачи) и выпадающий список для
  // добавления нового — из него исключены сама задача, уже добавленные
  // предшественники и всё, что создало бы цикл зависимостей.
  function renderDepsSection() {
    const t = currentTask();
    if (!t) return;
    const proj = currentTaskProject();
    const deps = (t.dependsOn || []).map((id) => proj.tasks.find((x) => x.id === id)).filter(Boolean);
    const blockingIds = new Set(getBlockingDependencies(proj, t).map((d) => d.id));

    depsList.innerHTML = deps.map((d) => `
      <div class="dep-row ${blockingIds.has(d.id) ? "blocking" : ""}">
        <span class="dep-status">${d.completed ? "✓" : "○"}</span>
        <span class="dep-title" data-open="${d.id}">${escapeHtml(d.title)}</span>
        <button class="dep-remove" data-remove-dep="${d.id}" title="Убрать зависимость" aria-label="Убрать зависимость «${escapeHtml(d.title)}»">×</button>
      </div>
    `).join("");

    depsList.querySelectorAll("[data-open]").forEach((el) => {
      el.addEventListener("click", () => openDetail(el.dataset.open));
    });
    depsList.querySelectorAll("[data-remove-dep]").forEach((btn) => {
      btn.addEventListener("click", () => {
        removeDependency(proj, t.id, btn.dataset.removeDep);
        renderDepsSection();
        renderAll(true);
      });
    });

    const existingIds = new Set([t.id, ...(t.dependsOn || [])]);
    const candidates = proj.tasks.filter((x) => !existingIds.has(x.id) && !wouldCreateDependencyCycle(proj, x.id, t.id));
    depsAddSelect.innerHTML = `<option value="">+ Добавить зависимость...</option>` + candidates.map((c) => `<option value="${c.id}">${escapeHtml(c.title)}</option>`).join("");
    depsAddSelect.value = "";
  }

  // Показывает предупреждение прямо в панели деталей, если у исполнителя
  // этой задачи уже есть другая незавершённая задача с пересекающимся
  // периодом дат — та самая "проверка перераспределения ресурсов".
  // Синхронизирует min/max между полями "Начало"/"Срок", чтобы дата-пикер
  // не давал выбрать срок раньше начала (и наоборот) там, где это в
  // принципе можно проверить нативно.
  function syncDateBounds() {
    detailDue.min = detailStart.value || "";
    detailStart.max = detailDue.value || "";
  }

  // Предупреждение, если срок задачи раньше её начала — раньше это молча
  // схлопывалось в однодневную полосу в Ганте (см. barHtmlFor), теперь
  // ошибка в датах видна прямо в панели деталей.
  function renderDateOrderWarning() {
    const start = detailStart.value;
    const due = detailDue.value;
    if (!start || !due || start <= due) { dateOrderWarning.hidden = true; return; }
    dateOrderWarning.hidden = false;
    dateOrderWarning.innerHTML = "⚠ Срок раньше даты начала";
  }

  function renderConflictWarning() {
    const t = currentTask();
    if (!t || !t.assigneeId) { conflictWarning.hidden = true; return; }
    const proj = currentTaskProject();
    const eff = getEffectiveDates(proj, t);
    if (!eff.start || !eff.due) { conflictWarning.hidden = true; return; }
    const conflicts = getConflictingTasks(t.assigneeId, t.id, eff.start, eff.due);
    if (!conflicts.length) { conflictWarning.hidden = true; return; }
    const name = assigneeName(t);
    const list = conflicts.map((c) => `«${escapeHtml(c.task.title)}»${c.proj.id !== proj.id ? ` (${escapeHtml(c.proj.name)})` : ""}`).join(", ");
    conflictWarning.hidden = false;
    conflictWarning.innerHTML = `⚠ ${escapeHtml(name)} в эти даты уже занят(а): ${list}`;
  }

  // Перерисовывает блок "Подзадачи" внутри панели деталей: список строк
  // (чекбокс, название, кнопка "сделать отдельной задачей", кнопка
  // "удалить") плюс счётчик "сколько выполнено из скольки".
  function renderSubtaskSection() {
    const t = currentTask();
    if (!t) return;
    const proj = currentTaskProject();
    const subs = getSubtasks(proj, t.id).sort((a, b) => a.order - b.order);
    const done = subs.filter((s) => s.completed).length;
    subtaskProgress.textContent = subs.length ? `${done}/${subs.length}` : "";

    if (!subs.length) {
      subtaskList.innerHTML = "";
      return;
    }

    subtaskList.innerHTML = subs.map((s) => `
      <div class="subtask-row ${s.completed ? "completed" : ""}" draggable="true" data-subtask-id="${s.id}">
        <span class="row-check ${s.completed ? "checked" : ""}" data-toggle="${s.id}">✓</span>
        <span class="subtask-title" data-open="${s.id}">${escapeHtml(s.title)}</span>
        <button class="subtask-promote" data-promote="${s.id}" title="Сделать отдельной задачей">⇧</button>
        <button class="subtask-remove" data-remove="${s.id}" title="Удалить подзадачу">×</button>
      </div>
    `).join("");

    // Перетаскивание строк друг относительно друга — ручная сортировка
    // подзадач (все они и так уже общий родитель, поэтому вложение здесь
    // не нужно: верхняя половина строки — "перед", нижняя — "после").
    subtaskList.querySelectorAll(".subtask-row").forEach((row) => {
      const sid = row.dataset.subtaskId;
      row.addEventListener("dragstart", (e) => {
        dragTaskId = sid;
        row.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        e.stopPropagation();
      });
      row.addEventListener("dragend", () => row.classList.remove("dragging"));
      row.addEventListener("dragover", (e) => {
        if (!dragTaskId || dragTaskId === sid) return;
        e.preventDefault();
        e.stopPropagation();
        const after = dropZoneFraction(row, e) > 0.5;
        row.classList.toggle("drop-target-after", after);
        row.classList.toggle("drop-target-before", !after);
      });
      row.addEventListener("dragleave", () => row.classList.remove("drop-target-before", "drop-target-after"));
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const after = dropZoneFraction(row, e) > 0.5;
        row.classList.remove("drop-target-before", "drop-target-after");
        if (!dragTaskId || dragTaskId === sid) return;
        reorderTask(dragTaskId, sid, after ? "after" : "before");
        dragTaskId = null;
        renderAll(true);
        renderSubtaskSection();
      });
    });

    subtaskList.querySelectorAll("[data-toggle]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleComplete(el.dataset.toggle);
        renderSubtaskSection();
      });
    });
    subtaskList.querySelectorAll("[data-open]").forEach((el) => {
      el.addEventListener("click", () => openDetail(el.dataset.open));
    });
    subtaskList.querySelectorAll("[data-promote]").forEach((el) => {
      el.addEventListener("click", () => {
        const sub = proj.tasks.find((x) => x.id === el.dataset.promote);
        if (sub) {
          sub.parentTaskId = null;
          commit(true);
          renderSubtaskSection();
        }
      });
    });
    subtaskList.querySelectorAll("[data-remove]").forEach((el) => {
      el.addEventListener("click", () => {
        deleteTask(el.dataset.remove);
        renderSubtaskSection();
      });
    });
  }

  function closeDetail() {
    openTaskId = null;
    openTaskProjectId = null;
    detailPanel.hidden = true;
    closeModalFocus(detailPanel);
  }

  // Задача, открытая сейчас в панели деталей (или null, если панель закрыта).
  function currentTask() {
    if (!openTaskId) return null;
    const proj = state.projects.find((p) => p.id === openTaskProjectId);
    return proj ? proj.tasks.find((t) => t.id === openTaskId) || null : null;
  }

  // Проект, которому принадлежит задача, открытая сейчас в панели деталей.
  function currentTaskProject() {
    return state.projects.find((p) => p.id === openTaskProjectId) || null;
  }

  // Навешивает обработчики один раз при запуске приложения на все поля
  // панели деталей: изменение любого поля сразу сохраняет значение в
  // задачу. Здесь же — кнопка авто/ручной режим дат и удаление задачи.
  function bindDetailEvents() {
    detailClose.addEventListener("click", closeDetail);

    // Клик по затемнённому фону вокруг модального окна тоже закрывает его
    // (клик внутри самой карточки задачи сюда не доходит — target будет
    // не detailPanel, а конкретный дочерний элемент).
    detailPanel.addEventListener("click", (e) => {
      if (e.target === detailPanel) closeDetail();
    });

    detailBreadcrumb.addEventListener("click", () => {
      const t = currentTask();
      if (t && t.parentTaskId) openDetail(t.parentTaskId);
    });

    detailComplete.addEventListener("click", async () => {
      const t = currentTask();
      if (!t) return;
      const proj = currentTaskProject();
      if (!t.completed && !(await confirmCompleteWithActiveChildren(proj, t))) return;
      t.completed = !t.completed;
      detailComplete.classList.toggle("checked", t.completed);
      detailComplete.textContent = t.completed ? "✓" : "";
      detailComplete.setAttribute("aria-pressed", String(t.completed));
      detailComplete.setAttribute("aria-label", t.completed ? "Снять отметку о выполнении" : "Отметить выполненной");
      commit(true);
    });

    detailTitle.addEventListener("change", () => {
      const t = currentTask();
      if (!t) return;
      t.title = detailTitle.value.trim() || t.title;
      commit(true);
    });
    // Это <textarea>, поэтому Enter по умолчанию просто добавляет перенос
    // строки, а сохранение (событие "change") срабатывает только когда
    // поле теряет фокус — из-за этого казалось, что Enter "ничего не
    // делает". Теперь Enter сразу подтверждает название, как и везде
    // в приложении (Shift+Enter, если вдруг нужен перенос строки).
    detailTitle.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        detailTitle.blur();
      }
    });

    detailSection.addEventListener("change", () => {
      const t = currentTask();
      if (!t) return;
      t.sectionId = detailSection.value;
      commit(true);
    });

    detailAssignee.addEventListener("change", () => {
      const t = currentTask();
      if (!t) return;
      t.assigneeId = detailAssignee.value || null;
      commit(true);
      renderConflictWarning();
    });

    detailStart.addEventListener("change", () => {
      const t = currentTask();
      if (!t) return;
      t.start = detailStart.value;
      commit(true);
      syncDateBounds();
      renderConflictWarning();
      renderDateOrderWarning();
    });

    detailDue.addEventListener("change", () => {
      const t = currentTask();
      if (!t) return;
      t.due = detailDue.value;
      commit(true);
      syncDateBounds();
      renderConflictWarning();
      renderDateOrderWarning();
    });

    // Выбор в выпадающем списке сразу добавляет связь "сначала выполнить"
    // (как select исполнителя/раздела — без отдельной кнопки).
    depsAddSelect.addEventListener("change", () => {
      const t = currentTask();
      if (!t || !depsAddSelect.value) return;
      addDependency(currentTaskProject(), t.id, depsAddSelect.value);
      renderDepsSection();
      renderAll(true);
    });

    // Переключатель "Задать вручную" / "Вернуть авторасчёт" у задачи с
    // подзадачами: при переходе в ручной режим запоминаем текущие
    // вычисленные даты как стартовые, чтобы поля не "прыгали".
    datesAutoToggleBtn.addEventListener("click", () => {
      const t = currentTask();
      if (!t) return;
      const proj = currentTaskProject();
      if (t.datesAuto === false) {
        t.datesAuto = true;
      } else {
        const eff = getEffectiveDates(proj, t);
        t.start = eff.start;
        t.due = eff.due;
        t.datesAuto = false;
      }
      commit(true);
      openDetail(t.id);
    });

    detailPriority.addEventListener("change", () => {
      const t = currentTask();
      if (!t) return;
      t.priority = detailPriority.value;
      commit(true);
    });

    detailEstimate.addEventListener("change", () => {
      const t = currentTask();
      if (!t) return;
      const v = detailEstimate.value;
      t.estimateHours = v === "" ? null : Math.max(0, Number(v));
      commit(true);
    });

    detailTags.addEventListener("change", () => {
      const t = currentTask();
      if (!t) return;
      t.tags = detailTags.value.split(",").map((s) => s.trim()).filter(Boolean);
      commit(true);
    });

    detailNotes.addEventListener("change", () => {
      const t = currentTask();
      if (!t) return;
      t.notes = detailNotes.value;
      save();
    });

    subtaskAddInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const t = currentTask();
      if (!t) return;
      const title = subtaskAddInput.value.trim();
      if (!title) return;
      createSubtask(t, title);
      subtaskAddInput.value = "";
      renderAll(true);
      renderSubtaskSection();
    });

    detailDelete.addEventListener("click", async () => {
      const t = currentTask();
      if (!t) return;
      if (await showConfirm("Удалить эту задачу вместе со всеми подзадачами?")) deleteTask(t.id);
    });
  }

  // ---------- проекты и подпроекты ----------

  // Создаёт новый проект (parentId = null — глобальный проект верхнего
  // уровня, иначе — подпроект внутри проекта с этим id) с тремя разделами
  // по умолчанию, и сразу открывает его.
  function createProject(name, parentId) {
    const sTodo = uid(), sProgress = uid(), sDone = uid();
    const project = {
      id: uid(),
      name,
      color: PROJECT_COLORS[state.projects.length % PROJECT_COLORS.length],
      parentId: parentId || null,
      sections: [
        { id: sTodo, name: "К выполнению" },
        { id: sProgress, name: "В работе" },
        { id: sDone, name: "Готово" }
      ],
      tasks: []
    };
    state.projects.push(project);
    state.activeProjectId = project.id;
    state.screen = "project";
    save();
  }

  // Удаляет текущий проект вместе со всеми его подпроектами и задачами
  // (с подтверждением); не даёт удалить последний оставшийся проект.
  async function deleteProject() {
    const proj = getActiveProject();
    const descendantIds = new Set(getProjectDescendantIds(proj.id));
    if (state.projects.length - descendantIds.size < 1) {
      await showAlert("Нельзя удалить — не останется ни одного проекта.");
      return;
    }
    const hasSub = descendantIds.size > 1;
    const msg = hasSub
      ? `Удалить проект «${proj.name}» вместе со всеми подпроектами и задачами?`
      : `Удалить проект «${proj.name}» вместе со всеми задачами?`;
    if (!(await showConfirm(msg))) return;
    state.projects = state.projects.filter((p) => !descendantIds.has(p.id));
    if (!state.projects.some((p) => p.id === state.activeProjectId)) {
      state.activeProjectId = state.projects[0].id;
    }
    closeDetail();
    commit();
  }

  // ---------- люди (справочник исполнителей) ----------

  // Добавляет нового человека в справочник (40 часов в неделю по умолчанию).
  function createUser(name) {
    state.users.push({ id: uid(), name, color: PROJECT_COLORS[state.users.length % PROJECT_COLORS.length], weeklyHours: 40 });
    save();
  }

  // Удаляет человека из справочника. Если на него назначены задачи —
  // спрашивает подтверждение и снимает с этих задач исполнителя (сами
  // задачи не удаляются).
  async function deleteUser(userId) {
    const inUse = state.projects.some((p) => p.tasks.some((t) => t.assigneeId === userId));
    if (inUse && !(await showConfirm("Этот человек назначен на задачи. Удалить из справочника? Задачи останутся без исполнителя."))) return;
    state.projects.forEach((p) => p.tasks.forEach((t) => { if (t.assigneeId === userId) t.assigneeId = null; }));
    state.users = state.users.filter((u) => u.id !== userId);
    commit();
  }

  // Перерисовывает экран "Люди": таблица со всеми людьми (имя, часов в
  // неделю, число открытых задач, полоска загрузки в часах) и строка
  // добавления нового человека.
  function renderPeople() {
    const rows = state.users.map((u) => {
      const stats = getUserStats(u.id);
      const util = u.weeklyHours ? Math.round((stats.totalHours / u.weeklyHours) * 100) : 0;
      const over = u.weeklyHours && stats.totalHours > u.weeklyHours;
      const conflict = hasScheduleConflict(u.id);
      return `
        <div class="people-row" data-user-id="${u.id}">
          <input class="people-name-input" data-field="name" data-user-id="${u.id}" value="${escapeHtml(u.name)}" aria-label="Имя человека">
          <input type="number" class="people-hours-input" data-field="weeklyHours" data-user-id="${u.id}" min="0" step="1" value="${u.weeklyHours}" aria-label="Часов в неделю">
          <span class="people-stat">${stats.openTasks}${conflict ? ' <span class="people-conflict" title="Есть пересекающиеся по датам задачи">⚠</span>' : ""}</span>
          <span class="people-util-wrap">
            <div class="progress-bar" style="flex:1"><div class="progress-fill" style="width:${Math.min(100, util)}%;${over ? "background:var(--danger)" : ""}"></div></div>
            <span class="people-util-label">${stats.totalHours}${u.weeklyHours ? "/" + u.weeklyHours : ""} ч</span>
          </span>
          <button class="people-del" data-del-user="${u.id}" title="Удалить" aria-label="Удалить «${escapeHtml(u.name)}»">×</button>
        </div>
      `;
    }).join("");

    peopleEl.innerHTML = `
      <div class="people-header">Справочник пользователей</div>
      <div class="people-sub">Добавьте исполнителей — они появятся в выпадающем списке «Исполнитель» у задач и в сводке загрузки на дашборде.</div>
      <div class="people-table">
        <div class="people-row people-row-head">
          <span>Имя</span><span>Часов/нед</span><span>Задач</span><span>Загрузка</span><span></span>
        </div>
        ${rows}
      </div>
      <div class="people-add-row">
        <input type="text" id="peopleAddInput" placeholder="Имя нового человека...">
      </div>
    `;

    peopleEl.querySelectorAll('[data-field="name"]').forEach((inp) => {
      inp.addEventListener("change", () => {
        const u = state.users.find((x) => x.id === inp.dataset.userId);
        if (u) { u.name = inp.value.trim() || u.name; commit(true); }
      });
    });
    peopleEl.querySelectorAll('[data-field="weeklyHours"]').forEach((inp) => {
      inp.addEventListener("change", () => {
        const u = state.users.find((x) => x.id === inp.dataset.userId);
        if (u) { u.weeklyHours = Math.max(0, Number(inp.value) || 0); commit(true); }
      });
    });
    peopleEl.querySelectorAll("[data-del-user]").forEach((btn) => {
      btn.addEventListener("click", () => deleteUser(btn.dataset.delUser));
    });

    const addInput = document.getElementById("peopleAddInput");
    addInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const name = addInput.value.trim();
      if (!name) return;
      createUser(name);
      renderAll(true);
      const fresh = document.getElementById("peopleAddInput");
      if (fresh) fresh.focus();
    });
  }

  // ---------- корзина (удалённые задачи, которые можно восстановить) ----------

  // Форматирует ISO-дату удаления в читаемый вид "3 сен, 14:05".
  function formatTrashDate(iso) {
    const d = new Date(iso);
    return d.toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }

  // Перерисовывает экран "Корзина": по одной строке на каждую запись
  // (удалённая задача + всё её поддерево), с кнопками "восстановить" и
  // "удалить навсегда", плюс кнопка полной очистки корзины.
  function renderTrash() {
    trashCountEl.hidden = !state.trash.length;
    trashCountEl.textContent = state.trash.length || "";

    if (!state.trash.length) {
      trashEl.innerHTML = `
        <div class="people-header">Корзина</div>
        <div class="people-sub">Здесь появятся удалённые задачи вместе с их подзадачами — их можно будет восстановить.</div>
        <div class="dash-empty">Корзина пуста</div>
      `;
      return;
    }

    const rows = state.trash.map((entry) => {
      const proj = state.projects.find((p) => p.id === entry.projectId);
      const extra = entry.tasks.length - 1;
      return `
        <div class="trash-row" data-entry-id="${entry.id}">
          <div class="trash-row-main">
            <div class="trash-row-title">${escapeHtml(entry.rootTitle)}${extra > 0 ? ` <span class="trash-row-extra">+ ${extra} ${extra === 1 ? "подзадача" : "подзадач"}</span>` : ""}</div>
            <div class="trash-row-meta">${proj ? escapeHtml(proj.name) : "проект удалён"} · удалено ${formatTrashDate(entry.deletedAt)}</div>
          </div>
          <div class="trash-row-actions">
            <button data-restore="${entry.id}" ${proj ? "" : "disabled title=\"Проект удалён — восстанавливать некуда\""}>Восстановить</button>
            <button class="trash-purge" data-purge="${entry.id}">Удалить навсегда</button>
          </div>
        </div>
      `;
    }).join("");

    trashEl.innerHTML = `
      <div class="people-header">Корзина</div>
      <div class="people-sub">Удалённые задачи вместе с их подзадачами. Можно вернуть обратно в проект или стереть навсегда.</div>
      <button class="trash-empty-btn" id="trashEmptyBtn">Очистить корзину</button>
      <div class="trash-list">${rows}</div>
    `;

    trashEl.querySelectorAll("[data-restore]").forEach((btn) => {
      btn.addEventListener("click", () => restoreFromTrash(btn.dataset.restore));
    });
    trashEl.querySelectorAll("[data-purge]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (await showConfirm("Удалить эту задачу навсегда? Отменить будет нельзя.", "Удалить навсегда")) {
          permanentlyDeleteFromTrash(btn.dataset.purge);
        }
      });
    });
    const emptyBtn = document.getElementById("trashEmptyBtn");
    if (emptyBtn) emptyBtn.addEventListener("click", emptyTrash);
  }

  // Сколько задач сейчас в архиве — для бейджа рядом с пунктом "Архив" в
  // сайдбаре (см. renderAll()).
  function getArchivedCount() {
    let count = 0;
    state.projects.forEach((p) => p.tasks.forEach((t) => { if (t.archived) count++; }));
    return count;
  }

  // Сколько всего чужих непрочитанных задач по всем проектам — счётчик
  // у кнопки "Дашборд" в сайдбаре (глобальное уведомление, см. также
  // isUnreadForMe/badge "новое" у отдельных задач).
  function getUnreadCount() {
    let count = 0;
    state.projects.forEach((p) => p.tasks.forEach((t) => { if (!t.archived && isUnreadForMe(t)) count++; }));
    return count;
  }

  // Экран "Архив": заархивированные задачи по всем проектам сразу — убраны
  // из обычных видов независимо от "показывать выполненные" (см. F18 —
  // раньше выполненные задачи оставались в списках навсегда и размывали
  // % выполнения в аналитике). Устроен по образцу renderTrash() выше, но
  // без удаления — только "Вернуть".
  function renderArchive() {
    const rows = [];
    state.projects.forEach((p) => p.tasks.forEach((t) => { if (t.archived) rows.push({ task: t, proj: p }); }));

    if (!rows.length) {
      archiveEl.innerHTML = `
        <div class="people-header">Архив</div>
        <div class="people-sub">Сюда попадают выполненные задачи, убранные из обычных видов кнопкой «В архив» в шапке проекта — их всегда можно вернуть.</div>
        <div class="dash-empty">Архив пуст</div>
      `;
      return;
    }

    const rowsHtml = rows.map(({ task, proj }) => `
      <div class="trash-row" data-task-id="${task.id}">
        <div class="trash-row-main">
          <div class="trash-row-title">${escapeHtml(task.title)}</div>
          <div class="trash-row-meta">${escapeHtml(proj.name)}</div>
        </div>
        <div class="trash-row-actions">
          <button data-unarchive="${task.id}" data-project-id="${proj.id}">Вернуть</button>
        </div>
      </div>
    `).join("");

    archiveEl.innerHTML = `
      <div class="people-header">Архив</div>
      <div class="people-sub">Выполненные задачи, убранные из обычных видов и аналитики. Можно вернуть обратно в проект.</div>
      <div class="trash-list">${rowsHtml}</div>
    `;

    archiveEl.querySelectorAll("[data-unarchive]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const proj = state.projects.find((p) => p.id === btn.dataset.projectId);
        const task = proj && proj.tasks.find((t) => t.id === btn.dataset.unarchive);
        if (!task) return;
        task.archived = false;
        commit();
      });
    });
  }

  // ---------- дашборд ("монитор руководителя" — сводка по всем проектам сразу) ----------

  // Перерисовывает дашборд: карточки KPI (всего задач, % выполнения,
  // просрочено, число проектов), дерево всех проектов с прогресс-барами,
  // списки просроченных и ближайших по срокам задач, загрузка людей по часам.
  function renderDashboard() {
    const allProjects = state.projects;
    // Плоский список { задача t, её проект p, вычисленные даты eff } по
    // ВСЕМ проектам и подпроектам сразу — удобно фильтровать/сортировать.
    const allTasksFlat = [];
    allProjects.forEach((p) => p.tasks.forEach((t) => { if (!t.archived) allTasksFlat.push({ t, p, eff: getEffectiveDates(p, t) }); }));

    const totalTasks = allTasksFlat.length;
    const completedTasks = allTasksFlat.filter((x) => x.t.completed).length;
    const overdueTasks = allTasksFlat.filter((x) => isOverdue(x.p, x.t));
    const topLevelProjectsCount = allProjects.filter((p) => !p.parentId).length;
    const pct = totalTasks ? Math.round((completedTasks / totalTasks) * 100) : 0;

    const today = todayStr();
    const in7Str = addDays(today, 7);
    const upcoming = allTasksFlat
      .filter((x) => !x.t.completed && x.eff.due && x.eff.due >= today && x.eff.due <= in7Str)
      .sort((a, b) => a.eff.due.localeCompare(b.eff.due));
    const overdueSorted = overdueTasks.slice().sort((a, b) => a.eff.due.localeCompare(b.eff.due));

    const usersById = {};
    state.users.forEach((u) => { usersById[u.id] = u; });
    const workload = {};
    allTasksFlat.forEach((x) => {
      if (x.t.completed) return;
      const key = x.t.assigneeId || "none";
      if (!workload[key]) workload[key] = { count: 0, hours: 0 };
      workload[key].count++;
      workload[key].hours += Number(x.t.estimateHours) || 0;
    });
    const workloadEntries = Object.entries(workload).map(([key, w]) => {
      const u = key !== "none" ? usersById[key] : null;
      return { name: u ? u.name : "Без исполнителя", count: w.count, hours: w.hours, capacity: u ? u.weeklyHours : null };
    }).sort((a, b) => b.hours - a.hours || b.count - a.count).slice(0, 8);

    function projectRowHtml(project, depth) {
      const stats = getProjectStats(project.id);
      const children = allProjects.filter((p) => p.parentId === project.id);
      let html = `
        <div class="proj-tree-row" data-project-id="${project.id}" style="padding-left:${4 + depth * 18}px">
          <span class="dot" style="background:${project.color}"></span>
          <span class="pname">${escapeHtml(project.name)}</span>
          <span class="pbar-wrap"><div class="progress-bar"><div class="progress-fill" style="width:${stats.pct}%;background:${project.color}"></div></div></span>
          <span class="pstats ${stats.overdue ? "has-overdue" : ""}">${stats.completed}/${stats.total}${stats.overdue ? ` · ${stats.overdue} просроч.` : ""}</span>
        </div>
      `;
      children.forEach((c) => { html += projectRowHtml(c, depth + 1); });
      return html;
    }

    const projectTreeHtml = allProjects.filter((p) => !p.parentId).map((p) => projectRowHtml(p, 0)).join("") || `<div class="dash-empty">Нет проектов</div>`;

    function miniTaskRowHtml(x, kind) {
      return `
        <div class="mini-task-row" data-project-id="${x.p.id}" data-task-id="${x.t.id}">
          <span class="mt-project" style="background:${x.p.color}">${escapeHtml(x.p.name)}</span>
          <span class="mt-title">${escapeHtml(x.t.title)}</span>
          <span class="mt-due ${kind === "overdue" ? "overdue" : ""}">${formatDue(x.eff.due)}</span>
        </div>
      `;
    }

    const overdueHtml = overdueSorted.length
      ? overdueSorted.slice(0, 12).map((x) => miniTaskRowHtml(x, "overdue")).join("")
      : `<div class="dash-empty">Просроченных задач нет 🎉</div>`;

    const upcomingHtml = upcoming.length
      ? upcoming.slice(0, 12).map((x) => miniTaskRowHtml(x, "upcoming")).join("")
      : `<div class="dash-empty">Ближайших сроков нет</div>`;

    const workloadHtml = workloadEntries.length
      ? workloadEntries.map((w) => {
          const pctW = w.capacity ? Math.min(100, Math.round((w.hours / w.capacity) * 100)) : Math.min(100, w.count * 20);
          const over = w.capacity && w.hours > w.capacity;
          return `
            <div class="assignee-row">
              <span class="aname">${escapeHtml(w.name)}</span>
              <span class="abar-wrap"><div class="progress-bar"><div class="progress-fill" style="width:${pctW}%;${over ? "background:var(--danger)" : ""}"></div></div></span>
              <span class="acount">${w.count} · ${w.hours}${w.capacity ? "/" + w.capacity : ""}ч</span>
            </div>
          `;
        }).join("")
      : `<div class="dash-empty">Нет активных задач</div>`;

    dashboardEl.innerHTML = `
      <div class="dashboard-header">Дашборд</div>
      <div class="kpi-row">
        <div class="kpi-card"><div class="kpi-value">${totalTasks}</div><div class="kpi-label">Всего задач</div></div>
        <div class="kpi-card"><div class="kpi-value">${pct}%</div><div class="kpi-label">Выполнено (${completedTasks}/${totalTasks})</div></div>
        <div class="kpi-card ${overdueTasks.length ? "warn" : ""}"><div class="kpi-value">${overdueTasks.length}</div><div class="kpi-label">Просрочено</div></div>
        <div class="kpi-card"><div class="kpi-value">${topLevelProjectsCount}</div><div class="kpi-label">Глобальных проектов</div></div>
      </div>
      <div class="dash-grid">
        <div>
          <div class="dash-section">
            <h2>Проекты и подпроекты</h2>
            ${projectTreeHtml}
          </div>
          <div class="dash-section">
            <h2>Загрузка по исполнителям (часы)</h2>
            ${workloadHtml}
          </div>
        </div>
        <div>
          <div class="dash-section">
            <h2>Просроченные задачи</h2>
            ${overdueHtml}
          </div>
          <div class="dash-section">
            <h2>Ближайшие сроки (7 дней)</h2>
            ${upcomingHtml}
          </div>
        </div>
      </div>
    `;

    dashboardEl.querySelectorAll(".proj-tree-row").forEach((row) => {
      row.addEventListener("click", () => {
        state.screen = "project";
        state.activeProjectId = row.dataset.projectId;
        commit();
      });
    });
    dashboardEl.querySelectorAll(".mini-task-row").forEach((row) => {
      row.addEventListener("click", () => {
        state.screen = "project";
        switchActiveProject(row.dataset.projectId, "board");
        commit();
        openDetail(row.dataset.taskId);
      });
    });
  }

  // ---------- экспорт / импорт всех данных (JSON-файл) ----------
  // Единственный способ вынести данные из этого браузера (localStorage не
  // синхронизируется ни с чем) или сделать резервную копию перед
  // экспериментами. Импорт полностью заменяет текущее состояние.

  // Скачивает всё текущее состояние (проекты, задачи, люди, корзина)
  // одним JSON-файлом.
  function exportData() {
    const json = JSON.stringify(state, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tasking-export-${todayStr()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // Беглая проверка, что распарсенный JSON вообще похож на экспорт этого
  // приложения — прежде чем отдавать его в normalizeState() и дальше в
  // рендер, которые ожидают у каждого проекта массивы sections/tasks и не
  // проверяют это сами (файл может быть любым чужим JSON).
  function looksLikeValidExport(parsed) {
    return !!parsed && typeof parsed === "object" &&
      Array.isArray(parsed.projects) && parsed.projects.length > 0 &&
      parsed.projects.every((p) => p && typeof p === "object" &&
        typeof p.id === "string" && typeof p.name === "string" &&
        Array.isArray(p.sections) && Array.isArray(p.tasks));
  }

  // Читает файл, спрашивает подтверждение (импорт необратимо заменяет всё
  // текущее состояние) и, если пользователь согласен, заменяет state целиком.
  async function importDataFromFile(file) {
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch (e) {
      await showAlert("Не удалось прочитать файл: это не корректный JSON.");
      return;
    }
    if (!looksLikeValidExport(parsed)) {
      await showAlert("Файл не похож на экспорт из «Задачника» — не найдено ни одного корректного проекта.");
      return;
    }
    const ok = await showConfirm(
      "Импорт полностью заменит текущие проекты, задачи, людей и корзину содержимым файла. Отменить это действие потом будет нельзя — если текущие данные ещё нужны, сначала сделайте «Экспорт». Импортировать?",
      "Импортировать"
    );
    if (!ok) return;
    replaceState(parsed);
    flushSave(true); // force: только что заменили state целиком, писать нужно безусловно
    renderAll();
  }

  exportDataBtn.addEventListener("click", exportData);
  importDataBtn.addEventListener("click", () => importDataInput.click());
  importDataInput.addEventListener("change", () => {
    const file = importDataInput.files[0];
    importDataInput.value = "";
    if (file) importDataFromFile(file);
  });

  // ---------- главная функция перерисовки экрана ----------

  // Вызывается после КАЖДОГО изменения данных. Всегда перерисовывает
  // сайдбар, а дальше решает, что показать в основной области: дашборд,
  // справочник людей или один из видов текущего проекта (доска/список/
  // по статусам/структура/Гант) — управляется полями state.screen и
  // state.view. keepDetail=true означает "не закрывать панель деталей,
  // даже если открытая задача временно не входит в текущий фильтр".
  function renderAll(keepDetail) {
    if (state.activeProjectId !== lastUiProjectId) {
      if (lastUiProjectId) saveUiPrefsForProject(lastUiProjectId);
      loadUiPrefsForProject(state.activeProjectId);
      lastUiProjectId = state.activeProjectId;
    }
    renderSidebar();

    topbar.hidden = state.screen !== "project";
    boardWrap.hidden = true;
    listWrap.hidden = true;
    treeWrap.hidden = true;
    ganttWrap.hidden = true;
    dashboardWrap.hidden = true;
    peopleWrap.hidden = true;
    trashWrap.hidden = true;
    archiveWrap.hidden = true;

    trashCountEl.hidden = !state.trash.length;
    trashCountEl.textContent = state.trash.length || "";
    const archivedCount = getArchivedCount();
    archiveCountEl.hidden = !archivedCount;
    archiveCountEl.textContent = archivedCount || "";
    const unreadCount = getUnreadCount();
    unreadCountEl.hidden = !unreadCount;
    unreadCountEl.textContent = unreadCount || "";

    if (state.screen === "dashboard") {
      dashboardWrap.hidden = false;
      renderDashboard();
    } else if (state.screen === "people") {
      peopleWrap.hidden = false;
      renderPeople();
    } else if (state.screen === "trash") {
      trashWrap.hidden = false;
      renderTrash();
    } else if (state.screen === "archive") {
      archiveWrap.hidden = false;
      renderArchive();
    } else {
      renderTopbar();
      if (state.view === "board") { boardWrap.hidden = false; renderBoard(); }
      else if (state.view === "list") { listWrap.hidden = false; renderList(); }
      else if (state.view === "tree") { treeWrap.hidden = false; renderTree(); }
      else if (state.view === "structure") { treeWrap.hidden = false; renderStructure(); }
      else if (state.view === "gantt") { ganttWrap.hidden = false; renderGantt(); }
    }

    if (!keepDetail && openTaskId) {
      const ownerProj = state.projects.find((p) => p.id === openTaskProjectId);
      const stillExists = !!ownerProj && ownerProj.tasks.some((t) => t.id === openTaskId);
      if (!stillExists) closeDetail();
    }

    syncHash();
  }

  // ---------- роутинг по URL (хэш) ----------
  // Текущий экран/проект/вид отражаются в адресной строке (#project/<id>/
  // <вид>, #dashboard, #people, #trash) — можно скопировать ссылку на
  // конкретный проект и вид, а кнопки "назад"/"вперёд" браузера
  // переключаются между ними вместо того, чтобы уводить со страницы.
  // Работает через location.hash (не history API): это не требует сервера
  // и одинаково работает и при открытии файла напрямую (file://), и через
  // предпросмотр — см. память проекта про то, что это приложение всегда
  // должно открываться без сервера.
  const VALID_VIEWS = ["board", "list", "tree", "structure", "gantt"];

  // Собирает хэш-строку, соответствующую текущему состоянию экрана.
  function stateToHash() {
    if (state.screen === "dashboard") return "#dashboard";
    if (state.screen === "people") return "#people";
    if (state.screen === "trash") return "#trash";
    if (state.screen === "archive") return "#archive";
    const proj = getActiveProject();
    if (!proj) return "";
    return `#project/${proj.id}/${state.view}`;
  }

  // Приводит адресную строку в соответствие текущему состоянию — вызывается
  // из renderAll(), так что происходит это после КАЖДОГО изменения экрана.
  // Если хэш и так совпадает, ничего не делает (иначе это могло бы вызвать
  // холостой "hashchange" и зациклиться с applyHashToState()).
  function syncHash() {
    const h = stateToHash();
    if (!h || location.hash === h) return;
    try {
      // pushState (не replaceState): срабатывает только когда экран/
      // проект/вид реально изменились (иначе сработал бы guard выше), то
      // есть ровно тогда, когда это и есть настоящая навигация — так что
      // именно такие переходы должны быть доступны кнопке "назад".
      history.pushState(null, "", h);
    } catch (e) {
      // history.pushState() кидает SecurityError при открытии страницы
      // напрямую с диска (file://) — это приложение именно так и
      // открывают, так что этот путь не редкий случай, а норма. Обычное
      // присвоение location.hash работает и с file://, и даёт то же
      // визуальное поведение — только без записи в history (кнопка
      // "назад" в этом режиме между вкладками/видами работать не будет,
      // но сама ссылка на текущий вид в адресной строке — будет).
      location.hash = h;
    }
  }

  // Читает адресную строку и переключает на неё экран — вызывается при
  // старте страницы (в т.ч. по прямой ссылке на проект) и при навигации
  // "назад"/"вперёд" в браузере. Неизвестный/устаревший id проекта в
  // ссылке молча игнорируется — остаёмся на текущем экране, а не падаем.
  function applyHashFromLocation() {
    const raw = location.hash.replace(/^#\/?/, "");
    const parts = raw.split("/").filter(Boolean);
    if (parts[0] === "dashboard") { state.screen = "dashboard"; renderAll(); return true; }
    if (parts[0] === "people") { state.screen = "people"; renderAll(); return true; }
    if (parts[0] === "trash") { state.screen = "trash"; renderAll(); return true; }
    if (parts[0] === "archive") { state.screen = "archive"; renderAll(); return true; }
    if (parts[0] === "project" && parts[1]) {
      const proj = state.projects.find((p) => p.id === parts[1]);
      if (!proj) return false;
      state.screen = "project";
      switchActiveProject(proj.id, parts[2] && VALID_VIEWS.includes(parts[2]) ? parts[2] : undefined);
      renderAll();
      return true;
    }
    return false;
  }

  // "hashchange" покрывает обычные переходы по хэшу, "popstate" —
  // подстраховка для кнопок "назад"/"вперёд" по записям истории,
  // добавленным через history.pushState() в syncHash() (эти два события
  // не всегда дублируют друг друга во всех браузерах для чисто
  // хэш-переходов). Вызвать applyHashFromLocation() дважды на одну и ту же
  // навигацию безопасно — она просто перерисует то же самое состояние.
  window.addEventListener("hashchange", () => { applyHashFromLocation(); });
  window.addEventListener("popstate", () => { applyHashFromLocation(); });

  // ---------- глобальные обработчики событий (навешиваются один раз при запуске) ----------

  dashboardNavBtn.addEventListener("click", () => {
    state.screen = "dashboard";
    commit();
  });

  peopleNavBtn.addEventListener("click", () => {
    state.screen = "people";
    commit();
  });

  trashNavBtn.addEventListener("click", () => {
    state.screen = "trash";
    commit();
  });

  archiveNavBtn.addEventListener("click", () => {
    state.screen = "archive";
    commit();
  });

  addProjectBtn.addEventListener("click", () => {
    addingProject = true;
    renderSidebar();
  });

  addProjectInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const name = addProjectInput.value.trim();
      skipNextBlur = true;
      addingProject = false;
      if (name) createProject(name, null);
      renderAll();
    } else if (e.key === "Escape") {
      skipNextBlur = true;
      addingProject = false;
      renderSidebar();
    }
  });
  addProjectInput.addEventListener("blur", () => {
    if (skipNextBlur) { skipNextBlur = false; return; }
    addingProject = false;
    renderSidebar();
  });

  // Если перетаскиваемый проект отпустить в пустом месте списка (не на
  // другом проекте) — он становится глобальным (parentId = null).
  projectListEl.addEventListener("dragover", (e) => {
    if (!dragProjectId) return;
    e.preventDefault();
    projectListEl.setAttribute("data-drop-root", "1");
  });
  projectListEl.addEventListener("dragleave", (e) => {
    if (e.target === projectListEl) projectListEl.removeAttribute("data-drop-root");
  });
  projectListEl.addEventListener("drop", (e) => {
    if (!dragProjectId) return;
    e.preventDefault();
    projectListEl.removeAttribute("data-drop-root");
    const proj = state.projects.find((p) => p.id === dragProjectId);
    if (proj) { proj.parentId = null; save(); }
    dragProjectId = null;
    renderAll();
  });

  deleteProjectBtn.addEventListener("click", deleteProject);

  showCompletedToggle.addEventListener("change", () => {
    state.showCompleted = showCompletedToggle.checked;
    commit(true);
  });

  archiveCompletedBtn.addEventListener("click", async () => {
    const proj = getActiveProject();
    const targets = proj.tasks.filter((t) => t.completed && !t.archived);
    if (!targets.length) { await showAlert("В этом проекте нет выполненных задач для архивации."); return; }
    const word = targets.length === 1 ? "задачу" : "задач";
    if (!(await showConfirm(`Убрать ${targets.length} выполненных ${word} этого проекта из обычных видов в архив? Вернуть их можно из экрана «Архив».`, "Архивировать"))) return;
    targets.forEach((t) => { t.archived = true; });
    commit();
  });

  projectTitleEl.addEventListener("blur", () => {
    const proj = getActiveProject();
    const val = projectTitleEl.textContent.trim().slice(0, PROJECT_TITLE_MAX_LEN);
    proj.name = val || proj.name;
    projectTitleEl.textContent = proj.name;
    save();
    renderSidebar();
  });
  projectTitleEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); projectTitleEl.blur(); }
  });
  // contenteditable по умолчанию вставляет буфер обмена как есть — со своим
  // форматированием и переносами строк. Название проекта — однострочное
  // обычное имя, поэтому вставляем только plain-текст, схлопывая пробелы/
  // переносы и обрезая по той же длине, что и на blur.
  projectTitleEl.addEventListener("paste", (e) => {
    e.preventDefault();
    const text = (e.clipboardData.getData("text/plain") || "").replace(/\s+/g, " ").slice(0, PROJECT_TITLE_MAX_LEN);
    document.execCommand("insertText", false, text);
  });

  // Небольшая задержка перед перерисовкой: без неё каждое нажатие клавиши
  // в поиске пересобирает всю доску/список/дерево заново, что на большом
  // числе задач заметно тормозит набор текста.
  let searchDebounceTimer = null;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => renderAll(true), 150);
  });

  // ---------- панель фильтров: открытие/закрытие и сами поля ----------
  filterToggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    filterPanel.hidden = !filterPanel.hidden;
  });
  filterPanel.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => { filterPanel.hidden = true; });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !filterPanel.hidden) filterPanel.hidden = true;
  });

  // ---------- панель участников проекта (видят весь проект целиком) ----------
  membersToggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    membersPanel.hidden = !membersPanel.hidden;
  });
  membersPanel.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => { membersPanel.hidden = true; });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !membersPanel.hidden) membersPanel.hidden = true;
  });

  function applyFilterChange() {
    activeFilters.assigneeId = filterAssignee.value;
    activeFilters.priority = filterPriority.value;
    activeFilters.due = filterDue.value;
    activeFilters.tag = filterTag.value;
    renderAll(true);
  }
  filterAssignee.addEventListener("change", applyFilterChange);
  filterPriority.addEventListener("change", applyFilterChange);
  filterDue.addEventListener("change", applyFilterChange);
  filterTag.addEventListener("change", applyFilterChange);

  filterResetBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    activeFilters = { assigneeId: "", priority: "", due: "", tag: "" };
    renderAll(true);
  });

  viewSwitch.addEventListener("click", (e) => {
    const btn = e.target.closest(".view-btn");
    if (!btn) return;
    state.view = btn.dataset.view;
    commit(true);
  });

  // Масштаб диаграммы Ганта — ширина одного дня в пикселях, сохраняется
  // между сессиями (см. state.ganttDayWidth).
  function setGanttDayWidth(px) {
    state.ganttDayWidth = Math.max(6, Math.min(60, px));
    save();
    renderGantt();
  }
  ganttZoomSlider.addEventListener("input", () => setGanttDayWidth(Number(ganttZoomSlider.value)));
  ganttZoomOutBtn.addEventListener("click", () => setGanttDayWidth(state.ganttDayWidth - 4));
  ganttZoomInBtn.addEventListener("click", () => setGanttDayWidth(state.ganttDayWidth + 4));

  // Кнопки "Свернуть всё"/"Развернуть всё" — для больших вложенных
  // деревьев задач (в "По статусам" и "Структуре") и Ганта, где иначе
  // приходится сворачивать каждую ветку по отдельности. В "Структуре"/
  // "Гантте" заодно сворачивает и ветки подпроектов; в "По статусам"
  // подпроекты не показываются, так что там сворачиваются только задачи.
  function setAllCollapsed(collapsed) {
    const proj = getActiveProject();
    const includeSubprojects = state.view === "structure" || state.view === "gantt";
    const contentProjects = includeSubprojects ? getContentProjects(proj) : [proj];
    contentProjects.forEach((p) => {
      p.tasks.forEach((t) => {
        if (getSubtasks(p, t.id).length) {
          if (collapsed) collapsedTreeTasks.add(t.id); else collapsedTreeTasks.delete(t.id);
        }
      });
      if (includeSubprojects && p.id !== proj.id) {
        if (collapsed) collapsedProjects.add(p.id); else collapsedProjects.delete(p.id);
      }
    });
    state.collapsedProjectIds = [...collapsedProjects];
    state.collapsedTaskIds = [...collapsedTreeTasks];
    save();
    renderAll(true);
  }
  treeCollapseAllBtn.addEventListener("click", () => setAllCollapsed(true));
  treeExpandAllBtn.addEventListener("click", () => setAllCollapsed(false));
  ganttCollapseAllBtn.addEventListener("click", () => setAllCollapsed(true));
  ganttExpandAllBtn.addEventListener("click", () => setAllCollapsed(false));

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !detailPanel.hidden) closeDetail();
    if (e.key === "Escape" && !analyticsPanel.hidden) closeProjectAnalytics();
    if (e.key === "Escape" && !paletteOverlay.hidden) closePalette();
  });

  // Ctrl+Z / Ctrl+Shift+Z (и Ctrl+Y как привычная альтернатива для повтора).
  // Пока курсор стоит в текстовом поле или в contenteditable-заголовке
  // проекта — не перехватываем: там должен работать обычный undo браузера
  // для набранного текста, а не откат данных задач.
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key !== "z" && key !== "y") return;
    const target = e.target;
    const isEditable = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
    if (isEditable) return;
    if (key === "y" || (key === "z" && e.shiftKey)) {
      e.preventDefault();
      redo();
    } else {
      e.preventDefault();
      undo();
    }
  });

  analyticsClose.addEventListener("click", closeProjectAnalytics);
  analyticsPanel.addEventListener("click", (e) => {
    if (e.target === analyticsPanel) closeProjectAnalytics();
  });

  // Точка входа: один раз навешиваем обработчики полей панели деталей и
  // рисуем экран в первый раз при загрузке страницы. Если в адресной
  // строке уже есть хэш (например, страницу открыли по сохранённой или
  // отправленной ссылке на конкретный проект) — сразу переключаемся на
  // него; иначе рисуем то, что было сохранено в localStorage, и хэш
  // подстроится под это сам (см. syncHash() внутри renderAll()).
  bindDetailEvents();
  trapTabWithin(detailPanel);
  trapTabWithin(analyticsPanel);
  trapTabWithin(modalOverlay);
  trapTabWithin(paletteOverlay);
  if (!applyHashFromLocation()) renderAll();
})();
