// Синхронизация клиента с сервером (js/sync.js + auth.js + app.js) против
// настоящего gas/Code.gs на эмуляторе — сценарии, где раньше терялись
// данные или "откатывался" экран.
import { describe, it, expect } from "vitest";
import { createGasWorld } from "../dev/gas-emulator.js";
import { loadAppWithServer, tick, readState, assertNoJsErrors } from "./helpers/loadApp.js";

async function world() {
  const gas = createGasWorld();
  const a = await gas.login("anna", "pw", "Аня");
  const b = await gas.login("boris", "pw", "Борис");
  const st = gas.call("createStarterProject", {}, a.token);
  const pid = st.project.id;
  const sid = st.sections[0].id;
  gas.call("saveTask", { task: { id: "t1", projectId: pid, sectionId: sid, title: "Первая", assigneeId: b.user.id, tags: [], watchers: [], dependencies: [] } }, a.token);
  gas.call("saveTask", { task: { id: "t2", projectId: pid, sectionId: sid, title: "Вторая", tags: [], watchers: [], dependencies: [] } }, a.token);
  return { gas, a, b, pid, sid };
}

function localTask(dom, id) {
  const st = dom.window.TaskingGetState();
  return st.projects.flatMap((p) => p.tasks).find((t) => t.id === id);
}

async function waitSaved(dom) {
  const until = Date.now() + 5000;
  await tick(500); // app.js откладывает запись на 400 мс, и только потом зовёт push()
  while (dom.window.TaskingSync.hasPendingChanges() && Date.now() < until) await tick(50);
}

describe("синхронизация с сервером", () => {
  it("вход тянет данные, изменения уходят одним пакетом", async () => {
    const { gas, a } = await world();
    const { dom, jsErrors, calls } = await loadAppWithServer({ gas, session: { token: a.token, user: a.user } });
    expect(localTask(dom, "t1").title).toBe("Первая");

    localTask(dom, "t1").priority = "high";
    localTask(dom, "t2").priority = "low";
    dom.window.TaskingSync.push(dom.window.TaskingGetState());
    await waitSaved(dom);

    expect(calls.filter((c) => c === "saveBatch").length).toBe(1);
    expect(calls).not.toContain("saveTask");
    const rows = gas.rows("Tasks");
    expect(rows.find((r) => r.id === "t1").priority).toBe("high");
    expect(rows.find((r) => r.id === "t2").priority).toBe("low");
    assertNoJsErrors(jsErrors);
  });

  it("правка автора не затирает то, что тем временем сделал исполнитель (К3)", async () => {
    const { gas, a, b } = await world();
    const { dom } = await loadAppWithServer({ gas, session: { token: a.token, user: a.user } });
    // Борис отметил выполнение и написал заметку, а у Ани экран ещё старый.
    gas.call("saveTask", { task: { id: "t1", completed: true, description: "готово, см. файл" } }, b.token);
    localTask(dom, "t1").priority = "high";
    dom.window.TaskingSync.push(dom.window.TaskingGetState());
    await waitSaved(dom);
    const row = gas.rows("Tasks").find((r) => r.id === "t1");
    expect(row.priority).toBe("high");
    expect(row.completed).toBe(true);
    expect(row.description).toBe("готово, см. файл");
  });

  it("чужое удаление доходит до экрана — опрос не «замерзает» (В2)", async () => {
    const { gas, a } = await world();
    const { dom } = await loadAppWithServer({ gas, session: { token: a.token, user: a.user } });
    expect(localTask(dom, "t2")).toBeTruthy();
    // Удаляем на сервере (как будто с другого устройства) и добавляем новую.
    gas.call("deleteTask", { taskId: "t2" }, a.token);
    const pid = dom.window.TaskingGetState().projects[0].id;
    const sid = dom.window.TaskingGetState().projects[0].sections[0].id;
    gas.call("saveTask", { task: { id: "t3", projectId: pid, sectionId: sid, title: "Новая с другого устройства" } }, a.token);
    await dom.window.TaskingSync.refreshNow();
    expect(localTask(dom, "t2")).toBeUndefined();
    expect(localTask(dom, "t3").title).toBe("Новая с другого устройства");
  });

  it("обновление с сервера не закрывает открытую задачу и не стирает черновик сообщения (В1)", async () => {
    const { gas, a, b } = await world();
    const { dom, jsErrors } = await loadAppWithServer({ gas, session: { token: a.token, user: a.user } });
    const doc = dom.window.document;
    doc.querySelector('[data-task-id="t2"] .card-title').dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await tick(100);
    expect(doc.getElementById("detailPanel").hidden).toBe(false);
    doc.getElementById("commentText").value = "пишу ответ…";

    gas.call("saveTask", { task: { id: "t1", description: "Борис дописал" } }, b.token);
    await dom.window.TaskingSync.refreshNow();

    expect(localTask(dom, "t1").notes).toBe("Борис дописал");
    expect(doc.getElementById("detailPanel").hidden).toBe(false);
    expect(doc.getElementById("detailTitle").value).toBe("Вторая");
    expect(doc.getElementById("commentText").value).toBe("пишу ответ…");
    assertNoJsErrors(jsErrors);
  });

  it("отказ сервера не блокирует синхронизацию, а экран возвращается к правде сервера (К2)", async () => {
    const { gas, b } = await world();
    const { dom } = await loadAppWithServer({ gas, session: { token: b.token, user: b.user } });
    // Борис — исполнитель, менять название ему нельзя: сервер отклонит.
    localTask(dom, "t1").title = "Взлом";
    localTask(dom, "t1").completed = true;
    dom.window.TaskingSync.push(dom.window.TaskingGetState());
    await waitSaved(dom);
    expect(dom.window.TaskingSync.hasPendingChanges()).toBe(false);
    const row = gas.rows("Tasks").find((r) => r.id === "t1");
    expect(row.title).toBe("Первая");
    expect(row.completed).toBe(true);
    await dom.window.TaskingSync.refreshNow();
    expect(localTask(dom, "t1").title).toBe("Первая");
  });

  it("со старым сервером без saveBatch всё сохраняется по одной записи", async () => {
    const { gas, a } = await world();
    const { dom, calls } = await loadAppWithServer({ gas, session: { token: a.token, user: a.user }, failActions: ["saveBatch"] });
    localTask(dom, "t1").priority = "high";
    dom.window.TaskingSync.push(dom.window.TaskingGetState());
    await waitSaved(dom);
    expect(calls).toContain("saveTask");
    expect(gas.rows("Tasks").find((r) => r.id === "t1").priority).toBe("high");
  });

  it("мгновенный старт из кэша: приложение открывается без ожидания сервера", async () => {
    const { gas, a } = await world();
    const first = await loadAppWithServer({ gas, session: { token: a.token, user: a.user } });
    const cached = readState(first.dom);
    first.dom.window.close();

    const { dom, calls } = await loadAppWithServer({ gas, session: { token: a.token, user: a.user }, cachedState: cached });
    expect(dom.window.document.querySelector(".app").hidden).toBe(false);
    expect(localTask(dom, "t1").title).toBe("Первая");
    // Проверка сессии идёт в фоне, после показа приложения.
    await tick(100);
    expect(calls).toContain("whoAmI");
  });

  it("восстановление из корзины возвращает задачу с автором и перепиской", async () => {
    const { gas, a, b } = await world();
    gas.call("saveComment", { taskId: "t1", text: "важное" }, b.token);
    const { dom } = await loadAppWithServer({ gas, session: { token: a.token, user: a.user } });
    const doc = dom.window.document;
    doc.querySelector('[data-task-id="t1"] .card-title').dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await tick(100);
    doc.getElementById("detailDelete").click();
    await tick(50);
    doc.querySelector(".modal-actions button:last-child").click();
    await tick(50);
    await waitSaved(dom);
    expect(gas.rows("Tasks").find((r) => r.id === "t1").deletedAt).toBeTruthy();

    doc.getElementById("toastUndoBtn").click();
    await tick(50);
    await waitSaved(dom);
    const row = gas.rows("Tasks").find((r) => r.id === "t1");
    expect(row.deletedAt).toBe("");
    expect(row.creatorId).toBe(a.user.id);
    expect(gas.call("getComments", { taskId: "t1" }, a.token).comments[0].text).toBe("важное");
  });
});
