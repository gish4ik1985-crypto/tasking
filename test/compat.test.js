// Новый клиент против ПРЕДЫДУЩЕЙ версии сервера (test/fixtures/Code.previous.gs —
// то, что сейчас развёрнуто у пользователя). Сайт на GitHub Pages обновляется
// сразу, а Code.gs перезаливается вручную позже — в этом промежутке ничего
// не должно ломаться.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGasWorld } from "../dev/gas-emulator.js";
import { loadAppWithServer, tick, assertNoJsErrors } from "./helpers/loadApp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OLD_CODE = readFileSync(path.join(__dirname, "fixtures/Code.previous.gs"), "utf-8");

function localTask(dom, id) {
  return dom.window.TaskingGetState().projects.flatMap((p) => p.tasks).find((t) => t.id === id);
}

async function waitSaved(dom) {
  const until = Date.now() + 5000;
  await tick(500);
  while (dom.window.TaskingSync.hasPendingChanges() && Date.now() < until) await tick(50);
}

describe("новый клиент со старым сервером", () => {
  it("вход, правки, удаление, опрос и чат работают", async () => {
    const gas = createGasWorld({ code: OLD_CODE });
    const a = await gas.login("anna", "pw", "Аня");
    const b = await gas.login("boris", "pw", "Борис");
    const st = gas.call("createStarterProject", {}, a.token);
    const pid = st.project.id;
    const sid = st.sections[0].id;
    gas.call("saveTask", { task: { id: "t1", projectId: pid, sectionId: sid, title: "Первая", tags: [], watchers: [], dependencies: [] } }, a.token);
    gas.call("saveTask", { task: { id: "t2", projectId: pid, sectionId: sid, title: "Вторая", tags: [], watchers: [], dependencies: [] } }, a.token);

    const { dom, jsErrors, calls } = await loadAppWithServer({ gas, session: { token: a.token, user: a.user } });
    const doc = dom.window.document;
    expect(localTask(dom, "t1").title).toBe("Первая");

    // Правка уходит по одной записи (saveBatch старый сервер не знает).
    localTask(dom, "t1").priority = "high";
    localTask(dom, "t1").assigneeId = b.user.id;
    dom.window.TaskingSync.push(dom.window.TaskingGetState());
    await waitSaved(dom);
    expect(calls).not.toContain("saveBatch");
    const row = gas.rows("Tasks").find((r) => r.id === "t1");
    expect(row.priority).toBe("high");
    expect(row.assigneeId).toBe(b.user.id);

    // Удаление через интерфейс.
    doc.querySelector('[data-task-id="t2"] .card-title').dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await tick(100);
    doc.getElementById("detailDelete").click();
    await tick(50);
    doc.querySelector(".modal-actions button:last-child").click();
    await waitSaved(dom);
    expect(gas.rows("Tasks").some((r) => r.id === "t2")).toBe(false);

    // Опрос подтягивает изменения коллеги.
    gas.call("saveTask", { task: { id: "t1", description: "Борис дописал" } }, b.token);
    await dom.window.TaskingSync.refreshNow();
    expect(localTask(dom, "t1").notes).toBe("Борис дописал");

    // Новые функции, которых старый сервер не умеет, просто не показываются.
    doc.querySelector('[data-task-id="t1"] .card-title').dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await tick(100);
    expect(doc.getElementById("detailApprovalsField").hidden).toBe(true);
    expect(doc.getElementById("detailRecurrenceField").hidden).toBe(true);

    // Чат работает как раньше.
    const res = await dom.window.TaskingSync.saveComment("t1", "привет", null, []);
    expect(res.ok).toBe(true);
    expect(gas.rows("Comments")[0].text).toBe("привет");

    // «Входящие» честно говорят, что нужно обновить сервер.
    doc.getElementById("inboxNavBtn").click();
    await tick(50);
    expect(doc.getElementById("inbox").textContent).toMatch(/обновления серверной части/);
    assertNoJsErrors(jsErrors);
  });
});
