import { describe, it, expect } from "vitest";
import { loadApp, tick, click, readState, assertNoJsErrors } from "./helpers/loadApp.js";
import { makeState, makeProject, makeTask } from "./helpers/fixtures.js";

// getProjectStats()/getUserStats() теперь кэшируются по stateVersion (см.
// getStatsCache() в app.js) — эти тесты проверяют не сам факт кэширования
// (это деталь реализации), а то, что кэш не показывает устаревшие цифры:
// счётчик открытых задач в сайдбаре обязан меняться сразу после каждого
// изменения данных, а не отставать на один рендер.
describe("кэш статистики проекта/людей не даёт устаревших чисел", () => {
  it("счётчик открытых задач в сайдбаре обновляется при отметке «выполнено» и после отмены", async () => {
    const proj = makeProject();
    const t1 = makeTask({ sectionId: proj._sTodo, title: "Раз" });
    const t2 = makeTask({ sectionId: proj._sTodo, title: "Два" });
    proj.tasks = [t1, t2];
    const { dom, jsErrors } = await loadApp({ seedState: makeState({ projects: [proj] }) });
    const doc = dom.window.document;

    const countEl = () => doc.querySelector(`[data-project-id="${proj.id}"] .count`);
    expect(countEl().textContent).toBe("2");

    click(doc.querySelector(`.card-check[data-task-id="${t1.id}"]`));
    await tick(500);
    expect(countEl().textContent).toBe("1");
    expect(readState(dom).projects[0].tasks.find((t) => t.id === t1.id).completed).toBe(true);

    click(doc.querySelector(`.card-check[data-task-id="${t2.id}"]`));
    await tick(500);
    expect(countEl().textContent).toBe("");

    assertNoJsErrors(jsErrors);
  });

  it("статистика человека (открытые задачи/часы) в справочнике «Люди» пересчитывается после изменений", async () => {
    const proj = makeProject();
    const user = { id: "u1", name: "Тестовый", color: "#6d5dfc", weeklyHours: 40 };
    const t1 = makeTask({ sectionId: proj._sTodo, title: "Задача 1", assigneeId: user.id, estimateHours: 4 });
    const t2 = makeTask({ sectionId: proj._sTodo, title: "Задача 2", assigneeId: user.id, estimateHours: 6 });
    proj.tasks = [t1, t2];
    const { dom, jsErrors } = await loadApp({ seedState: makeState({ projects: [proj], users: [user] }) });
    const doc = dom.window.document;

    click(doc.getElementById("peopleNavBtn"));
    await tick(50);
    const row = () => doc.querySelector(`[data-user-id="${user.id}"]`);
    expect(row().querySelector(".people-stat").textContent.trim()).toBe("2");
    expect(row().querySelector(".people-util-label").textContent.trim()).toBe("10/40 ч");

    click(doc.querySelector(`.project-item[data-project-id="${proj.id}"]`)); // назад на доску проекта
    await tick(50);
    doc.querySelector(`[data-task-id="${t1.id}"]`).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await tick(50);
    click(doc.getElementById("detailDelete"));
    await tick(50);
    click(doc.getElementById("modalActions").querySelector(".danger"));
    await tick(500);

    click(doc.getElementById("peopleNavBtn"));
    await tick(50);
    expect(row().querySelector(".people-stat").textContent.trim()).toBe("1");
    expect(row().querySelector(".people-util-label").textContent.trim()).toBe("6/40 ч");

    assertNoJsErrors(jsErrors);
  });
});
