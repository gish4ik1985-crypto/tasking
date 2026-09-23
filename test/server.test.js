// Серверная логика (gas/Code.gs) на эмуляторе Apps Script — без боевой таблицы.
import { describe, it, expect } from "vitest";
import { createGasWorld } from "../dev/gas-emulator.js";

async function twoUsers() {
  const g = createGasWorld();
  const a = await g.login("anna", "pw-anna", "Аня");
  const b = await g.login("boris", "pw-boris", "Борис");
  const starter = g.call("createStarterProject", {}, a.token);
  return { g, a, b, pid: starter.project.id, sid: starter.sections[0].id };
}

function task(overrides) {
  return { title: "Задача", priority: "medium", completed: false, tags: [], dependencies: [], watchers: [], ...overrides };
}

describe("вход и пароли", () => {
  it("хранит пароль с солью, а старый хеш без соли тихо обновляет при входе", async () => {
    const g = createGasWorld();
    await g.login("anna", "secret");
    expect(g.rows("Users")[0].passwordHash).toMatch(/^s1\$/);

    // Имитируем аккаунт из старой версии: SHA-256 без соли.
    const legacy = g.context.sha256("oldpass");
    const sheet = g.sheet("Users");
    const hIdx = g.rows("Users").length && sheet.getDataRange().getValues()[0].indexOf("passwordHash");
    sheet.appendRow(["legacy-id", "legacy", legacy, "Старый", "#123456", 40, "", ""]);
    expect(sheet.getDataRange().getValues()[2][hIdx]).toBe(legacy);

    const res = g.call("login", { login: "legacy", password: "oldpass" });
    expect(res.ok).toBe(true);
    expect(g.rows("Users").find((u) => u.id === "legacy-id").passwordHash).toMatch(/^s1\$/);
    expect(g.call("login", { login: "legacy", password: "oldpass" }).ok).toBe(true);
    expect(g.call("login", { login: "legacy", password: "wrong" }).ok).toBe(false);
  });

  it("блокирует подбор пароля после 5 неудачных попыток", async () => {
    const g = createGasWorld();
    await g.login("anna", "right");
    for (let i = 0; i < 5; i++) expect(g.call("login", { login: "anna", password: "bad" }).error).toBe("Неверный пароль");
    const blocked = g.call("login", { login: "anna", password: "right" });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toMatch(/Слишком много/);
  });

  it("закрытая регистрация не пускает новых, но админ может завести аккаунт сам", async () => {
    const g = createGasWorld();
    const admin = await g.login("boss", "pw");
    g.sheet("Users").getRange(2, 8).setValues([[true]]); // isAdmin
    expect(g.call("adminSettings", { patch: { registrationOpen: false } }, admin.token).settings.registrationOpen).toBe(false);
    expect(g.call("login", { login: "stranger", password: "x" }).error).toMatch(/Регистрация закрыта/);
    expect(g.call("adminCreateUser", { login: "newbie", password: "pw2", name: "Новичок" }, admin.token).ok).toBe(true);
    expect(g.call("login", { login: "newbie", password: "pw2" }).ok).toBe(true);
  });

  it("не раздаёт логины других пользователей обычным пользователям", async () => {
    const { g, a } = await twoUsers();
    const users = g.call("listUsers", {}, a.token).users;
    expect(users.find((u) => u.name === "Аня").login).toBe("anna");
    expect(users.find((u) => u.name === "Борис").login).toBeUndefined();
  });

  it("выход и сброс пароля админом отзывают сессии", async () => {
    const g = createGasWorld();
    const admin = await g.login("boss", "pw");
    g.sheet("Users").getRange(2, 8).setValues([[true]]);
    const u = await g.login("worker", "pw");
    const second = await g.login("worker", "pw");
    expect(g.call("whoAmI", {}, u.token).ok).toBe(true);
    g.call("logout", {}, u.token);
    expect(g.call("whoAmI", {}, u.token).error).toBe("unauthorized");
    expect(g.call("whoAmI", {}, second.token).ok).toBe(true);
    g.call("adminUpdateUser", { targetUserId: u.user.id, patch: { newPassword: "new" } }, admin.token);
    expect(g.call("whoAmI", {}, second.token).error).toBe("unauthorized");
  });

  it("токены сессий в таблице хранятся хешем, а старые открытые токены продолжают работать", async () => {
    const g = createGasWorld();
    const a = await g.login("anna", "pw");
    expect(g.rows("Sessions")[0].token).not.toBe(a.token);
    g.sheet("Sessions").appendRow(["plain-old-token", a.user.id, Date.now() + 100000]);
    expect(g.call("whoAmI", {}, "plain-old-token").ok).toBe(true);
  });
});

describe("защита от XSS через цвет", () => {
  it("сервер принимает только цвет #rrggbb в профиле, проекте и админке", async () => {
    const { g, a, pid } = await twoUsers();
    const evil = '#fff" onmouseover="alert(1)';
    const prof = g.call("updateProfile", { profile: { color: evil } }, a.token);
    expect(prof.user.color).toMatch(/^#[0-9a-f]{3,6}$/i);
    g.call("saveProject", { project: { id: pid, color: evil } }, a.token);
    const state = g.call("getState", {}, a.token);
    expect(state.projects[0].color).toMatch(/^#[0-9a-f]{3,6}$/i);
    // Даже если в таблицу мусор попал руками — наружу он не уходит.
    const usersSheet = g.sheet("Users");
    usersSheet.getRange(2, 5).setValues([[evil]]);
    expect(g.call("listUsers", {}, a.token).users.every((u) => /^#[0-9a-f]{3,6}$/i.test(u.color))).toBe(true);
  });
});

describe("данные и права", () => {
  it("даты возвращаются как ГГГГ-ММ-ДД, даже если Таблица превратила их в даты", async () => {
    const { g, a, pid, sid } = await twoUsers();
    g.call("saveTask", { task: task({ id: "t1", projectId: pid, sectionId: sid, startDate: "2026-09-23", dueDate: "2026-09-25" }) }, a.token);
    // Имитируем старый лист, где у столбца дат нет текстового формата.
    const sheet = g.sheet("Tasks");
    const headers = sheet.getDataRange().getValues()[0];
    sheet.getRange(2, headers.indexOf("startDate") + 1).setValues([[new Date(2026, 8, 23)]]);
    const t = g.call("getState", {}, a.token).tasks[0];
    expect(t.startDate).toBe("2026-09-23");
    expect(t.dueDate).toBe("2026-09-25");
  });

  it("нельзя подбросить задачу в чужой проект, но исполнитель может добавить подзадачу", async () => {
    const { g, a, b, pid, sid } = await twoUsers();
    const intruder = g.call("saveTask", { task: task({ id: "x1", projectId: pid, sectionId: sid }) }, b.token);
    expect(intruder.ok).toBe(false);
    g.call("saveTask", { task: task({ id: "p1", projectId: pid, sectionId: sid, assigneeId: b.user.id }) }, a.token);
    const sub = g.call("saveTask", { task: task({ id: "c1", projectId: pid, sectionId: sid, parentTaskId: "p1" }) }, b.token);
    expect(sub.ok).toBe(true);
  });

  it("частичное сохранение не создаёт пустую задачу, если её нет на сервере", async () => {
    const { g, a, pid } = await twoUsers();
    const res = g.call("saveTask", { task: { id: "ghost", projectId: pid, priority: "high" } }, a.token);
    expect(res.ok).toBe(false);
    expect(res.permanent).toBe(true);
    expect(g.rows("Tasks").length).toBe(0);
  });

  it("частичное сохранение меняет только присланные поля — правки исполнителя не затираются", async () => {
    const { g, a, b, pid, sid } = await twoUsers();
    g.call("saveTask", { task: task({ id: "t1", projectId: pid, sectionId: sid, assigneeId: b.user.id, description: "старое" }) }, a.token);
    g.call("saveTask", { task: { id: "t1", completed: true, description: "сделал" } }, b.token);
    g.call("saveTask", { task: { id: "t1", projectId: pid, priority: "high" } }, a.token);
    const row = g.rows("Tasks")[0];
    expect(row.priority).toBe("high");
    expect(row.completed).toBe(true);
    expect(row.description).toBe("сделал");
  });

  it("исполнитель не может менять ничего, кроме выполнения и описания", async () => {
    const { g, a, b, pid, sid } = await twoUsers();
    g.call("saveTask", { task: task({ id: "t1", projectId: pid, sectionId: sid, assigneeId: b.user.id }) }, a.token);
    g.call("saveTask", { task: { id: "t1", title: "взлом", priority: "high", completed: true } }, b.token);
    const row = g.rows("Tasks")[0];
    expect(row.title).toBe("Задача");
    expect(row.priority).toBe("medium");
    expect(row.completed).toBe(true);
  });

  it("«изменено» не загорается от собственных правок", async () => {
    const { g, a, b, pid, sid } = await twoUsers();
    g.call("saveTask", { task: task({ id: "t1", projectId: pid, sectionId: sid, assigneeId: b.user.id }) }, a.token);
    g.call("markViewed", { taskId: "t1" }, b.token);
    g.setNow(Date.now() + 5000);
    g.call("saveTask", { task: { id: "t1", completed: true } }, b.token);
    expect(g.call("getState", {}, b.token).tasks[0].isChanged).toBe(false);
    g.setNow(Date.now() + 10000);
    g.call("saveTask", { task: { id: "t1", projectId: pid, priority: "high" } }, a.token);
    expect(g.call("getState", {}, b.token).tasks[0].isChanged).toBe(true);
  });

  it("открытие задачи (markViewed) не берёт общую блокировку", async () => {
    const { g, a, pid, sid } = await twoUsers();
    g.call("saveTask", { task: task({ id: "t1", projectId: pid, sectionId: sid }) }, a.token);
    const before = g.world.lockAcquired;
    g.call("markViewed", { taskId: "t1" }, a.token);
    expect(g.world.lockAcquired).toBe(before);
  });
});

describe("корзина на сервере", () => {
  it("удаление мягкое: восстановление возвращает автора и переписку, очистка стирает всё", async () => {
    const { g, a, b, pid, sid } = await twoUsers();
    g.call("saveTask", { task: task({ id: "t1", projectId: pid, sectionId: sid, assigneeId: b.user.id }) }, a.token);
    g.call("saveTask", { task: task({ id: "t2", projectId: pid, sectionId: sid, parentTaskId: "t1" }) }, a.token);
    g.call("saveComment", { taskId: "t1", text: "важное обсуждение", file: { name: "a.txt", mimeType: "text/plain", size: 3, dataBase64: "YWJj" } }, b.token);

    expect(g.call("deleteTask", { taskId: "t1" }, a.token).ok).toBe(true);
    expect(g.call("getState", {}, a.token).tasks.length).toBe(0);
    expect(g.rows("Comments").length).toBe(1);

    // Восстановление = повторное сохранение той же задачи (так делает клиент).
    g.call("saveTask", { task: task({ id: "t1", projectId: pid, sectionId: sid, assigneeId: b.user.id }) }, a.token);
    const restored = g.call("getState", {}, a.token).tasks.find((t) => t.id === "t1");
    expect(restored.creatorId).toBe(a.user.id);
    expect(g.call("getComments", { taskId: "t1" }, a.token).comments[0].text).toBe("важное обсуждение");

    g.call("deleteTask", { taskId: "t1" }, a.token);
    expect(g.call("purgeTasks", { taskIds: ["t1"] }, a.token).purged).toBe(2);
    expect(g.rows("Tasks").length).toBe(0);
    expect(g.rows("Comments").length).toBe(0);
    expect([...g.world.drive.files.values()].every((f) => f.trashed)).toBe(true);
  });

  it("очистить корзину может только автор и только удалённую задачу", async () => {
    const { g, a, b, pid, sid } = await twoUsers();
    g.call("saveTask", { task: task({ id: "t1", projectId: pid, sectionId: sid }) }, a.token);
    expect(g.call("purgeTasks", { taskIds: ["t1"] }, a.token).purged).toBe(0);
    g.call("deleteTask", { taskId: "t1" }, a.token);
    expect(g.call("purgeTasks", { taskIds: ["t1"] }, b.token).purged).toBe(0);
    expect(g.rows("Tasks").length).toBe(1);
  });
});

describe("пакетное сохранение и ревизии", () => {
  it("сохраняет проект, разделы и задачи одним запросом и отвечает по каждой записи", async () => {
    const { g, a, b, pid, sid } = await twoUsers();
    const locksBefore = g.world.lockAcquired;
    const res = g.call("saveBatch", {
      projects: [{ id: "np", name: "Новый", color: "#112233", members: [] }],
      sections: [{ id: "ns", projectId: "np", name: "Раздел", order: 0 }],
      tasks: [
        task({ id: "n1", projectId: "np", sectionId: "ns", title: "Раз" }),
        task({ id: "n2", projectId: "np", sectionId: "ns", title: "Два" }),
        task({ id: "bad", projectId: pid, sectionId: sid, title: "чужое" })
      ]
    }, b.token);
    expect(g.world.lockAcquired - locksBefore).toBe(1);
    expect(res.results.projects.np.ok).toBe(true);
    expect(res.results.sections.ns.ok).toBe(true);
    expect(res.results.tasks.n1.ok).toBe(true);
    expect(res.results.tasks.n2.ok).toBe(true);
    expect(res.results.tasks.bad.ok).toBe(false);
    expect(g.call("getState", {}, b.token).tasks.map((t) => t.title).sort()).toEqual(["Два", "Раз"]);
    expect(g.call("getState", {}, a.token).tasks.length).toBe(0);
  });

  it("getState отвечает «ничего нового», пока ревизия не изменилась", async () => {
    const { g, a, pid, sid } = await twoUsers();
    const full = g.call("getState", {}, a.token);
    expect(full.revision).toBeTruthy();
    expect(full.users.length).toBe(2);
    expect(full.features).toContain("batch");
    expect(g.call("getState", { sinceRevision: full.revision }, a.token)).toEqual({ ok: true, unchanged: true, revision: full.revision });
    g.call("saveTask", { task: task({ id: "t1", projectId: pid, sectionId: sid }) }, a.token);
    const next = g.call("getState", { sinceRevision: full.revision }, a.token);
    expect(next.unchanged).toBeUndefined();
    expect(next.tasks.length).toBe(1);
  });
});

describe("лента событий, упоминания, почта", () => {
  it("назначение, комментарий и упоминание попадают во «Входящие» нужным людям", async () => {
    const { g, a, b, pid, sid } = await twoUsers();
    const c = await g.login("vera", "pw", "Вера");
    g.call("saveProject", { project: { id: pid, members: [c.user.id] } }, a.token);
    g.call("saveTask", { task: task({ id: "t1", projectId: pid, sectionId: sid, assigneeId: b.user.id }) }, a.token);
    let inbox = g.call("getInbox", {}, b.token);
    expect(inbox.events.map((e) => e.type)).toEqual(["assigned"]);
    expect(inbox.events[0].taskTitle).toBe("Задача");

    g.call("saveComment", { taskId: "t1", text: "@Вера глянь", mentions: [c.user.id] }, b.token);
    expect(g.call("getInbox", {}, a.token).events[0].type).toBe("comment");
    expect(g.call("getInbox", {}, c.token).events[0].type).toBe("mention");

    expect(g.call("getState", {}, b.token).inboxUnread).toBe(1);
    g.call("markInboxRead", {}, b.token);
    expect(g.call("getState", {}, b.token).inboxUnread).toBe(0);
  });

  it("история задачи приходит вместе с перепиской", async () => {
    const { g, a, b, pid, sid } = await twoUsers();
    g.call("saveTask", { task: task({ id: "t1", projectId: pid, sectionId: sid }) }, a.token);
    g.call("saveTask", { task: { id: "t1", projectId: pid, assigneeId: b.user.id, dueDate: "2026-10-01" } }, a.token);
    const res = g.call("getComments", { taskId: "t1" }, a.token);
    expect(res.events.map((e) => e.type)).toEqual(["created", "assigned", "due_changed"]);
  });

  it("письмо уходит только тем, кто включил уведомления на почту", async () => {
    const { g, a, b, pid, sid } = await twoUsers();
    g.call("updateProfile", { profile: { email: "boris@example.com", notifyEmail: true } }, b.token);
    g.call("saveTask", { task: task({ id: "t1", projectId: pid, sectionId: sid, assigneeId: b.user.id, title: "Отчёт" }) }, a.token);
    expect(g.world.mail.length).toBe(1);
    expect(g.world.mail[0].to).toBe("boris@example.com");
    expect(g.world.mail[0].subject).toContain("Отчёт");
    expect(g.world.mail[0].body).toContain("#task/t1");
  });
});

describe("согласования", () => {
  it("согласующий видит задачу и ставит решение, посторонний — нет", async () => {
    const { g, a, b, pid, sid } = await twoUsers();
    const c = await g.login("vera", "pw", "Вера");
    g.call("saveTask", { task: task({ id: "t1", projectId: pid, sectionId: sid, approvers: [b.user.id] }) }, a.token);
    expect(g.call("getState", {}, b.token).tasks.length).toBe(1);
    expect(g.call("getInbox", {}, b.token).events[0].type).toBe("approval_requested");

    expect(g.call("decideApproval", { taskId: "t1", decision: "approved" }, c.token).ok).toBe(false);
    const res = g.call("decideApproval", { taskId: "t1", decision: "rejected", comment: "нет бюджета" }, b.token);
    expect(res.ok).toBe(true);
    const t = g.call("getState", {}, a.token).tasks[0];
    expect(t.approvals[b.user.id].d).toBe("rejected");
    expect(t.approvals[b.user.id].c).toBe("нет бюджета");
    // Автор не может подделать решение через обычное сохранение.
    g.call("saveTask", { task: { id: "t1", projectId: pid, approvals: { [b.user.id]: { d: "approved" } } } }, a.token);
    expect(g.call("getState", {}, a.token).tasks[0].approvals[b.user.id].d).toBe("rejected");
    // Убрали согласующего — его решение пропадает.
    g.call("saveTask", { task: { id: "t1", projectId: pid, approvers: [c.user.id] } }, a.token);
    expect(g.call("getState", {}, a.token).tasks[0].approvals).toEqual({});
  });
});

describe("совместимость со старой таблицей", () => {
  it("дописывает недостающие столбцы к старым листам, не трогая данные", async () => {
    const g = createGasWorld({ setup: false });
    const ss = g.world.ss;
    const users = ss.insertSheet("Users");
    users.appendRow(["id", "login", "passwordHash", "name", "color", "weeklyHours", "visibleViews", "isAdmin"]);
    users.appendRow(["u1", "anna", g.context.sha256("pw"), "Аня", "#6d5dfc", 40, '["board","gantt"]', ""]);
    const tasks = ss.insertSheet("Tasks");
    tasks.appendRow(["id", "projectId", "sectionId", "parentTaskId", "title", "description", "assigneeId", "creatorId", "watchers",
      "priority", "completed", "startDate", "dueDate", "datesAuto", "estimateHours", "order", "tags", "dependencies", "archived",
      "createdAt", "updatedAt"]);
    const projects = ss.insertSheet("Projects");
    projects.appendRow(["id", "name", "color", "parentId", "creatorId", "members", "archived", "createdAt", "updatedAt"]);
    projects.appendRow(["p1", "Старый проект", "#6d5dfc", "", "u1", "[]", "", 1, 1]);
    tasks.appendRow(["t1", "p1", "s1", "", "Старая задача", "", "", "u1", "", "medium", "FALSE", "", "", true, "", 0, "", "", "", 1, 1]);

    const login = g.call("login", { login: "anna", password: "pw" });
    expect(login.ok).toBe(true);
    // Сохранённый до появления «Календаря» список видов — календарь не скрыт.
    expect(login.user.visibleViews).toEqual(["board", "gantt", "calendar"]);
    const state = g.call("getState", {}, login.token);
    expect(state.tasks[0].title).toBe("Старая задача");
    expect(state.tasks[0].approvers).toEqual([]);
    expect(g.sheet("Tasks").getDataRange().getValues()[0]).toContain("deletedAt");
    expect(g.sheet("Events")).toBeTruthy();
  });

  it("удаление многих строк сохраняет остальные в целости", async () => {
    const { g, a, pid, sid } = await twoUsers();
    const tasks = Array.from({ length: 12 }, (_, i) => task({ id: "t" + i, projectId: pid, sectionId: sid, title: "Задача " + i }));
    g.call("saveBatch", { tasks }, a.token);
    tasks.filter((_, i) => i % 3 === 0).forEach((t) => g.call("deleteTask", { taskId: t.id }, a.token));
    g.call("purgeTasks", { taskIds: ["t0", "t3", "t6", "t9"] }, a.token);
    const titles = g.rows("Tasks").map((t) => t.title);
    expect(titles.length).toBe(8);
    expect(titles).toContain("Задача 11");
    expect(titles).not.toContain("Задача 3");
  });
});
