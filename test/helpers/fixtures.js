// Минимальные, полностью самодостаточные наборы состояния для тестов —
// в отличие от демо-данных (seedState() внутри app.js) не зависят от
// конкретных названий и не сломаются, если демо-контент поменяется.
let counter = 0;
export function uid(prefix = "t") {
  counter += 1;
  return `${prefix}${counter}`;
}

export function makeTask(overrides = {}) {
  return {
    id: uid("task"),
    sectionId: overrides.sectionId,
    parentTaskId: null,
    title: "Задача",
    notes: "",
    assigneeId: null,
    start: "",
    due: "",
    datesAuto: true,
    priority: "medium",
    tags: [],
    estimateHours: null,
    dependsOn: [],
    completed: false,
    order: 0,
    ...overrides
  };
}

export function makeProject(overrides = {}) {
  const sTodo = uid("sec");
  const sDone = uid("sec");
  return {
    id: uid("proj"),
    name: "Тестовый проект",
    color: "#6d5dfc",
    parentId: null,
    sections: [{ id: sTodo, name: "К выполнению" }, { id: sDone, name: "Готово" }],
    tasks: [],
    ...overrides,
    _sTodo: sTodo,
    _sDone: sDone
  };
}

// Собирает целиком валидное state — ровно то, что normalizeState() ожидает
// увидеть, без единого поля, которое пришлось бы доопределять по
// умолчанию.
export function makeState({ projects, users = [], activeProjectId, view = "board" } = {}) {
  const projs = projects || [makeProject()];
  return {
    schemaVersion: 1,
    updatedAt: Date.now(),
    users,
    projects: projs,
    activeProjectId: activeProjectId || projs[0].id,
    view,
    showCompleted: true,
    screen: "project",
    ganttNameColWidth: 260,
    ganttDayWidth: 30,
    trash: []
  };
}
