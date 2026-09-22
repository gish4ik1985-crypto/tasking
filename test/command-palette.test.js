// Командная палитра (Ctrl+K): ищет по всем проектам сразу (в отличие от
// обычного поиска в топбаре, который смотрит только в открытом проекте).
import { describe, it, expect } from "vitest";
import { loadApp, tick, assertNoJsErrors } from "./helpers/loadApp.js";
import { makeState, makeProject, makeTask } from "./helpers/fixtures.js";

function twoProjectsState() {
  const projA = makeProject({ name: "Проект А" });
  projA.tasks = [makeTask({ sectionId: projA._sTodo, title: "Задача в А" })];
  const projB = makeProject({ name: "Проект Б" });
  const target = makeTask({ sectionId: projB._sTodo, title: "Особая задача в Б" });
  projB.tasks = [target];
  return { state: makeState({ projects: [projA, projB], activeProjectId: projA.id }), projA, projB, target };
}

function openPalette(win) {
  win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }));
}

function setValue(win, input, text) {
  const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set;
  setter.call(input, text);
}

describe("командная палитра (Ctrl+K)", () => {
  it("Ctrl+K открывает палитру и фокусирует поле ввода", async () => {
    const { dom, jsErrors } = await loadApp({ seedState: twoProjectsState().state });
    const doc = dom.window.document;
    openPalette(dom.window);
    expect(doc.getElementById("paletteOverlay").hidden).toBe(false);
    expect(doc.activeElement.id).toBe("paletteInput");
    assertNoJsErrors(jsErrors);
  });

  it("находит задачу из НЕактивного проекта и открывает её при переходе", async () => {
    const { state, projB, target } = twoProjectsState();
    const { dom, jsErrors } = await loadApp({ seedState: state });
    const doc = dom.window.document;
    openPalette(dom.window);
    const input = doc.getElementById("paletteInput");
    setValue(dom.window, input, "Особая");
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await tick(50);

    const items = [...doc.querySelectorAll(".palette-item")];
    expect(items).toHaveLength(1);
    expect(items[0].querySelector(".palette-item-title").textContent).toBe(target.title);

    input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await tick(200);

    expect(doc.getElementById("paletteOverlay").hidden).toBe(true);
    expect(doc.getElementById("detailPanel").hidden).toBe(false);
    expect(doc.getElementById("detailTitle").value).toBe(target.title);
    expect(doc.getElementById("projectTitle").textContent).toBe(projB.name);
    assertNoJsErrors(jsErrors);
  });

  it("Escape закрывает палитру без изменений", async () => {
    const { dom, jsErrors } = await loadApp({ seedState: twoProjectsState().state });
    const doc = dom.window.document;
    openPalette(dom.window);
    doc.getElementById("paletteInput").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(doc.getElementById("paletteOverlay").hidden).toBe(true);
    assertNoJsErrors(jsErrors);
  });

  it("пустой запрос показывает список экранов и всех проектов", async () => {
    const { dom, jsErrors } = await loadApp({ seedState: twoProjectsState().state });
    const doc = dom.window.document;
    openPalette(dom.window);
    const titles = [...doc.querySelectorAll(".palette-item-title")].map((e) => e.textContent);
    expect(titles).toEqual(expect.arrayContaining(["Рабочий стол", "Люди", "Корзина", "Проект А", "Проект Б"]));
    assertNoJsErrors(jsErrors);
  });
});
