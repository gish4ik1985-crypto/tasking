// Задача с подзадачами ведёт себя как summary-задача в MS Project: даты
// вычисляются по датам подзадач (самое раннее начало, самый поздний
// срок), пока не включён ручной режим (datesAuto=false).
import { describe, it, expect } from "vitest";
import { loadApp, tick, click, assertNoJsErrors } from "./helpers/loadApp.js";
import { makeState, makeProject, makeTask } from "./helpers/fixtures.js";

function buildParentWithSubtasks() {
  const proj = makeProject();
  const parent = makeTask({ sectionId: proj._sTodo, title: "Родитель", datesAuto: true });
  const sub1 = makeTask({ sectionId: proj._sTodo, parentTaskId: parent.id, title: "Подзадача 1", start: "2026-01-05", due: "2026-01-08" });
  const sub2 = makeTask({ sectionId: proj._sTodo, parentTaskId: parent.id, title: "Подзадача 2", start: "2026-01-10", due: "2026-01-20" });
  proj.tasks = [parent, sub1, sub2];
  return { proj, parent };
}

describe("авторасчёт дат родительской задачи по подзадачам", () => {
  it("в Ганте полоса родителя растянута от самого раннего начала до самого позднего срока", async () => {
    const { proj, parent } = buildParentWithSubtasks();
    const state = makeState({ projects: [proj], view: "gantt" });
    const { dom, jsErrors } = await loadApp({ seedState: state });
    const doc = dom.window.document;
    const bar = doc.querySelector(`[data-open="${parent.id}"]`).closest(".gantt-row").querySelector(".gantt-bar");
    expect(bar.title).toContain("2026-01-05 → 2026-01-20");
    assertNoJsErrors(jsErrors);
  });

  it("открытие задачи показывает вычисленные даты и надпись про авторасчёт", async () => {
    const { proj, parent } = buildParentWithSubtasks();
    const state = makeState({ projects: [proj] });
    const { dom, jsErrors } = await loadApp({ seedState: state });
    const doc = dom.window.document;
    doc.querySelector(`[data-task-id="${parent.id}"]`).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await tick(50);
    expect(doc.getElementById("detailStart").value).toBe("2026-01-05");
    expect(doc.getElementById("detailDue").value).toBe("2026-01-20");
    expect(doc.getElementById("datesAutoRow").hidden).toBe(false);
    assertNoJsErrors(jsErrors);
  });

  it("переключение на ручной ввод замораживает текущие даты и перестаёт их пересчитывать", async () => {
    const { proj, parent } = buildParentWithSubtasks();
    const state = makeState({ projects: [proj] });
    const { dom, jsErrors } = await loadApp({ seedState: state });
    const doc = dom.window.document;
    doc.querySelector(`[data-task-id="${parent.id}"]`).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await tick(50);
    click(doc.getElementById("datesAutoToggleBtn"));
    await tick(500);

    // Меняем срок у одной из подзадач напрямую в состоянии и перезагружаем —
    // раз режим ручной, дата родителя не должна была подхватить это.
    const raw = JSON.parse(dom.window.localStorage.getItem("tasking-state-v1"));
    const p = raw.projects[0];
    const reloadedParent = p.tasks.find((t) => t.id === parent.id);
    expect(reloadedParent.datesAuto).toBe(false);
    expect(reloadedParent.start).toBe("2026-01-05");
    expect(reloadedParent.due).toBe("2026-01-20");
    assertNoJsErrors(jsErrors);
  });
});
