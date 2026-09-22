import { describe, it, expect } from "vitest";
import { loadApp, tick, click, assertNoJsErrors } from "./helpers/loadApp.js";
import { makeState, makeProject, makeTask } from "./helpers/fixtures.js";

function seedWithOneTask(title = "Удаляемая") {
  const proj = makeProject();
  const task = makeTask({ sectionId: proj._sTodo, title });
  proj.tasks = [task];
  return { proj, task };
}

describe("удаление задачи и корзина", () => {
  it("удаление задачи убирает её из проекта и добавляет в корзину", async () => {
    const { proj, task } = seedWithOneTask();
    const { dom, jsErrors } = await loadApp({ seedState: makeState({ projects: [proj] }) });
    const doc = dom.window.document;
    doc.querySelector(`[data-task-id="${task.id}"]`).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await tick(50);
    click(doc.getElementById("detailDelete"));
    await tick(50);
    click(doc.getElementById("modalActions").querySelector(".danger"));
    await tick(500);

    const state = JSON.parse(dom.window.localStorage.getItem("tasking-state-v1"));
    expect(state.projects[0].tasks.find((t) => t.id === task.id)).toBeUndefined();
    expect(state.trash).toHaveLength(1);
    expect(state.trash[0].tasks[0].id).toBe(task.id);
    assertNoJsErrors(jsErrors);
  });

  it("кнопка «Отменить» в тосте сразу возвращает задачу", async () => {
    const { proj, task } = seedWithOneTask();
    const { dom, jsErrors } = await loadApp({ seedState: makeState({ projects: [proj] }) });
    const doc = dom.window.document;
    doc.querySelector(`[data-task-id="${task.id}"]`).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await tick(50);
    click(doc.getElementById("detailDelete"));
    await tick(50);
    click(doc.getElementById("modalActions").querySelector(".danger"));
    await tick(50);

    expect(doc.getElementById("toast").hidden).toBe(false);
    click(doc.getElementById("toastUndoBtn"));
    await tick(500);

    const state = JSON.parse(dom.window.localStorage.getItem("tasking-state-v1"));
    expect(state.projects[0].tasks.find((t) => t.id === task.id)).toBeDefined();
    expect(state.trash).toHaveLength(0);
    assertNoJsErrors(jsErrors);
  });

  it("восстановление из экрана «Корзина» тоже возвращает задачу", async () => {
    const { proj, task } = seedWithOneTask();
    const { dom, jsErrors } = await loadApp({ seedState: makeState({ projects: [proj] }) });
    const doc = dom.window.document;
    doc.querySelector(`[data-task-id="${task.id}"]`).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await tick(50);
    click(doc.getElementById("detailDelete"));
    await tick(50);
    click(doc.getElementById("modalActions").querySelector(".danger"));
    await tick(500);

    click(doc.getElementById("trashNavBtn"));
    await tick(50);
    click(doc.querySelector("[data-restore]"));
    await tick(500);

    const state = JSON.parse(dom.window.localStorage.getItem("tasking-state-v1"));
    expect(state.projects[0].tasks.find((t) => t.id === task.id)).toBeDefined();
    expect(state.trash).toHaveLength(0);
    assertNoJsErrors(jsErrors);
  });

  it("удаление родителя с подзадачей отправляет в корзину обе задачи одной записью", async () => {
    const proj = makeProject();
    const parent = makeTask({ sectionId: proj._sTodo, title: "Родитель" });
    const child = makeTask({ sectionId: proj._sTodo, parentTaskId: parent.id, title: "Ребёнок" });
    proj.tasks = [parent, child];
    const { dom, jsErrors } = await loadApp({ seedState: makeState({ projects: [proj] }) });
    const doc = dom.window.document;
    doc.querySelector(`[data-task-id="${parent.id}"]`).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await tick(50);
    click(doc.getElementById("detailDelete"));
    await tick(50);
    click(doc.getElementById("modalActions").querySelector(".danger"));
    await tick(500);

    const state = JSON.parse(dom.window.localStorage.getItem("tasking-state-v1"));
    expect(state.projects[0].tasks).toHaveLength(0);
    expect(state.trash).toHaveLength(1);
    expect(state.trash[0].tasks.map((t) => t.id).sort()).toEqual([parent.id, child.id].sort());
    assertNoJsErrors(jsErrors);
  });
});
