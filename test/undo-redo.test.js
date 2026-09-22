import { describe, it, expect } from "vitest";
import { loadApp, tick, click, readState, assertNoJsErrors } from "./helpers/loadApp.js";
import { makeState, makeProject, makeTask } from "./helpers/fixtures.js";

function ctrlZ(win, { shift = false } = {}) {
  win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: "z", ctrlKey: true, shiftKey: shift, bubbles: true, cancelable: true }));
}

describe("отмена/повтор действий (Ctrl+Z / Ctrl+Shift+Z)", () => {
  it("Ctrl+Z отменяет удаление задачи, Ctrl+Shift+Z повторяет его", async () => {
    const proj = makeProject();
    const task = makeTask({ sectionId: proj._sTodo, title: "Удаляемая" });
    proj.tasks = [task];
    const { dom, jsErrors } = await loadApp({ seedState: makeState({ projects: [proj] }) });
    const doc = dom.window.document;

    doc.querySelector(`[data-task-id="${task.id}"]`).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await tick(50);
    click(doc.getElementById("detailDelete"));
    await tick(50);
    click(doc.getElementById("modalActions").querySelector(".danger"));
    await tick(500);

    expect(readState(dom).projects[0].tasks).toHaveLength(0);
    expect(readState(dom).trash).toHaveLength(1);

    ctrlZ(dom.window);
    await tick(500);
    let state = readState(dom);
    expect(state.projects[0].tasks.map((t) => t.id)).toEqual([task.id]);
    expect(state.trash).toHaveLength(0);

    ctrlZ(dom.window, { shift: true });
    await tick(500);
    state = readState(dom);
    expect(state.projects[0].tasks).toHaveLength(0);
    expect(state.trash).toHaveLength(1);

    assertNoJsErrors(jsErrors);
  });

  it("Ctrl+Z отменяет отметку «выполнено» на доске", async () => {
    const proj = makeProject();
    const task = makeTask({ sectionId: proj._sTodo, title: "Задача" });
    proj.tasks = [task];
    const { dom, jsErrors } = await loadApp({ seedState: makeState({ projects: [proj] }) });
    const doc = dom.window.document;

    click(doc.querySelector(`.card-check[data-task-id="${task.id}"]`));
    await tick(500);
    expect(readState(dom).projects[0].tasks[0].completed).toBe(true);

    ctrlZ(dom.window);
    await tick(500);
    expect(readState(dom).projects[0].tasks[0].completed).toBe(false);

    assertNoJsErrors(jsErrors);
  });

  it("несколько быстрых изменений подряд отменяются одним Ctrl+Z", async () => {
    const proj = makeProject();
    const t1 = makeTask({ sectionId: proj._sTodo, title: "Раз" });
    const t2 = makeTask({ sectionId: proj._sTodo, title: "Два" });
    proj.tasks = [t1, t2];
    const { dom, jsErrors } = await loadApp({ seedState: makeState({ projects: [proj] }) });
    const doc = dom.window.document;

    click(doc.querySelector(`.card-check[data-task-id="${t1.id}"]`));
    click(doc.querySelector(`.card-check[data-task-id="${t2.id}"]`));
    await tick(500);
    let state = readState(dom);
    expect(state.projects[0].tasks.every((t) => t.completed)).toBe(true);

    ctrlZ(dom.window);
    await tick(500);
    state = readState(dom);
    expect(state.projects[0].tasks.every((t) => !t.completed)).toBe(true);

    ctrlZ(dom.window);
    await tick(500);
    expect(readState(dom).trash).toHaveLength(0);

    assertNoJsErrors(jsErrors);
  });

  it("Ctrl+Z в текстовом поле не трогает данные (остаётся браузеру)", async () => {
    const proj = makeProject();
    const task = makeTask({ sectionId: proj._sTodo, title: "Заметка" });
    proj.tasks = [task];
    const { dom, jsErrors } = await loadApp({ seedState: makeState({ projects: [proj] }) });
    const doc = dom.window.document;

    click(doc.querySelector(`.card-check[data-task-id="${task.id}"]`));
    await tick(500);
    expect(readState(dom).projects[0].tasks[0].completed).toBe(true);

    const notes = doc.getElementById("detailNotes");
    notes.focus();
    notes.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
    await tick(500);

    expect(readState(dom).projects[0].tasks[0].completed).toBe(true);
    assertNoJsErrors(jsErrors);
  });

  it("импорт JSON сбрасывает историю — Ctrl+Z после импорта не возвращает старые данные", async () => {
    const proj = makeProject();
    const task = makeTask({ sectionId: proj._sTodo, title: "До импорта" });
    proj.tasks = [task];
    const { dom, jsErrors } = await loadApp({ seedState: makeState({ projects: [proj] }) });
    const doc = dom.window.document;

    click(doc.querySelector(`.card-check[data-task-id="${task.id}"]`));
    await tick(500);

    const importedProj = makeProject({ name: "Импортированный" });
    const importedTask = makeTask({ sectionId: importedProj._sTodo, title: "После импорта" });
    importedProj.tasks = [importedTask];
    const imported = makeState({ projects: [importedProj] });

    const file = new dom.window.File([JSON.stringify(imported)], "import.json", { type: "application/json" });
    const input = doc.getElementById("importDataInput");
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await tick(300);
    click(doc.getElementById("modalActions").querySelector(".danger"));
    await tick(500);

    let state = readState(dom);
    expect(state.projects.map((p) => p.name)).toEqual(["Импортированный"]);

    ctrlZ(dom.window);
    await tick(500);
    state = readState(dom);
    expect(state.projects.map((p) => p.name)).toEqual(["Импортированный"]);

    assertNoJsErrors(jsErrors);
  });
});
