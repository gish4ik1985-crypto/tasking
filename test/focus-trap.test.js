// Доступность модальных окон (Y2): при открытии панели деталей, окна
// аналитики, нашего confirm/alert и командной палитры фокус должен уходить
// внутрь, Tab/Shift+Tab не должен выпускать его за пределы окна, а при
// закрытии фокус должен возвращаться туда, откуда открывали. См.
// openModalFocus()/closeModalFocus()/trapTabWithin() в app.js.
import { describe, it, expect } from "vitest";
import { loadApp, tick, assertNoJsErrors } from "./helpers/loadApp.js";
import { makeState, makeProject, makeTask } from "./helpers/fixtures.js";

// Программный el.click() (в отличие от настоящего клика мышью) не переводит
// фокус на элемент сам по себе — приходится делать это явно. Это в точности
// повторяет то, что происходит у клавиатурного пользователя: элемент уже в
// фокусе (дошёл до него по Tab), затем Enter/Space его активирует, не снимая
// фокуса, — то есть именно тот сценарий, ради которого нужен возврат фокуса.
function focusThenClick(el) {
  el.focus();
  el.click();
}

function tabKey(win, shift = false) {
  win.document.activeElement.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Tab", shiftKey: shift, bubbles: true, cancelable: true }));
}

// Копия focusableIn() из app.js — jsdom не считает раскладку, поэтому
// offsetParent тут не годится в отличие от настоящего браузера.
function focusableIds(win, container) {
  return Array.from(container.querySelectorAll(
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter((el) => {
    if (el.closest("[hidden]")) return false;
    const style = win.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  });
}

describe("панель деталей: фокус-ловушка и возврат фокуса", () => {
  it("открытие переносит фокус на заголовок задачи, закрытие крестиком возвращает его на триггер", async () => {
    const proj = makeProject();
    const task = makeTask({ sectionId: proj._sTodo, title: "Задача" });
    proj.tasks = [task];
    const { dom, jsErrors } = await loadApp({ seedState: makeState({ projects: [proj] }) });
    const doc = dom.window.document;

    const card = doc.querySelector(`[data-task-id="${task.id}"] .card-title`);
    card.tabIndex = -1;
    focusThenClick(card);
    await tick(50);
    expect(doc.activeElement.id).toBe("detailTitle");

    doc.getElementById("detailClose").click();
    await tick(50);
    expect(doc.getElementById("detailPanel").hidden).toBe(true);
    expect(doc.activeElement).toBe(card);
    assertNoJsErrors(jsErrors);
  });

  it("Escape закрывает панель и тоже возвращает фокус на триггер", async () => {
    const proj = makeProject();
    const task = makeTask({ sectionId: proj._sTodo, title: "Задача" });
    proj.tasks = [task];
    const { dom, jsErrors } = await loadApp({ seedState: makeState({ projects: [proj] }) });
    const doc = dom.window.document;

    const card = doc.querySelector(`[data-task-id="${task.id}"] .card-title`);
    card.tabIndex = -1;
    focusThenClick(card);
    await tick(50);

    doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await tick(50);
    expect(doc.getElementById("detailPanel").hidden).toBe(true);
    expect(doc.activeElement).toBe(card);
    assertNoJsErrors(jsErrors);
  });

  it("Shift+Tab на первом поле переносит фокус на последнее, Tab с последнего — на первое", async () => {
    const proj = makeProject();
    const task = makeTask({ sectionId: proj._sTodo, title: "Задача" });
    proj.tasks = [task];
    const { dom, jsErrors } = await loadApp({ seedState: makeState({ projects: [proj] }) });
    const doc = dom.window.document;

    doc.querySelector(`[data-task-id="${task.id}"] .card-title`).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await tick(50);

    const panel = doc.getElementById("detailPanel");
    const items = focusableIds(dom.window, panel);
    expect(items.length).toBeGreaterThan(1);

    items[0].focus();
    tabKey(dom.window, true);
    expect(doc.activeElement).toBe(items[items.length - 1]);

    tabKey(dom.window, false);
    expect(doc.activeElement).toBe(items[0]);

    assertNoJsErrors(jsErrors);
  });

  it("подтверждение удаления открывается поверх панели деталей и возвращает фокус на кнопку «Удалить задачу» после отмены", async () => {
    const proj = makeProject();
    const task = makeTask({ sectionId: proj._sTodo, title: "Задача" });
    proj.tasks = [task];
    const { dom, jsErrors } = await loadApp({ seedState: makeState({ projects: [proj] }) });
    const doc = dom.window.document;

    doc.querySelector(`[data-task-id="${task.id}"] .card-title`).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await tick(50);

    const deleteBtn = doc.getElementById("detailDelete");
    focusThenClick(deleteBtn);
    await tick(50);
    expect(doc.getElementById("modalOverlay").hidden).toBe(false);
    expect(doc.activeElement.textContent).toBe("Отмена"); // безопасный дефолт, а не "Удалить"

    doc.activeElement.click();
    await tick(50);
    expect(doc.getElementById("modalOverlay").hidden).toBe(true);
    expect(doc.getElementById("detailPanel").hidden).toBe(false); // отмена — задача НЕ удалена, панель осталась открытой
    expect(doc.activeElement).toBe(deleteBtn);

    assertNoJsErrors(jsErrors);
  });
});

describe("командная палитра и окно аналитики: возврат фокуса", () => {
  it("Escape в палитре возвращает фокус туда, откуда она была открыта", async () => {
    const proj = makeProject();
    const { dom, jsErrors } = await loadApp({ seedState: makeState({ projects: [proj] }) });
    const doc = dom.window.document;

    const trigger = doc.getElementById("addProjectBtn");
    trigger.focus();
    doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }));
    expect(doc.activeElement.id).toBe("paletteInput");

    doc.getElementById("paletteInput").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(doc.getElementById("paletteOverlay").hidden).toBe(true);
    expect(doc.activeElement).toBe(trigger);

    assertNoJsErrors(jsErrors);
  });

  it("окно аналитики открывается по кнопке проекта и возвращает фокус на неё при закрытии", async () => {
    const proj = makeProject();
    const { dom, jsErrors } = await loadApp({ seedState: makeState({ projects: [proj] }) });
    const doc = dom.window.document;

    const btn = doc.querySelector(`[data-analytics="${proj.id}"]`);
    focusThenClick(btn);
    await tick(50);
    expect(doc.getElementById("analyticsPanel").hidden).toBe(false);
    expect(doc.getElementById("analyticsPanel").contains(doc.activeElement)).toBe(true);

    doc.getElementById("analyticsClose").click();
    await tick(50);
    expect(doc.getElementById("analyticsPanel").hidden).toBe(true);
    expect(doc.activeElement).toBe(btn);

    assertNoJsErrors(jsErrors);
  });
});
