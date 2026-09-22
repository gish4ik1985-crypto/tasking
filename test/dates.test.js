// Просрочка считается в ЛОКАЛЬНОМ времени (см. B1 в истории проекта —
// раньше это шло через toISOString()/UTC и "съезжало" на день у
// пользователей западнее UTC). Эти тесты фиксируют правильное поведение,
// чтобы кто-то в будущем случайно не вернул тот баг.
import { describe, it, expect } from "vitest";
import { loadApp, assertNoJsErrors } from "./helpers/loadApp.js";
import { makeState, makeProject, makeTask } from "./helpers/fixtures.js";

function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

describe("просрочка задач", () => {
  it("задача со сроком вчера помечена просроченной", async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const proj = makeProject();
    proj.tasks = [makeTask({ sectionId: proj._sTodo, title: "Вчерашняя", due: localDateStr(yesterday) })];
    const { dom, jsErrors } = await loadApp({ seedState: makeState({ projects: [proj] }) });
    const card = dom.window.document.querySelector(".card");
    expect(card.querySelector(".badge-due").className).toContain("overdue");
    assertNoJsErrors(jsErrors);
  });

  it("задача со сроком завтра НЕ помечена просроченной", async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const proj = makeProject();
    proj.tasks = [makeTask({ sectionId: proj._sTodo, title: "Завтрашняя", due: localDateStr(tomorrow) })];
    const { dom, jsErrors } = await loadApp({ seedState: makeState({ projects: [proj] }) });
    const card = dom.window.document.querySelector(".card");
    expect(card.querySelector(".badge-due").className).not.toContain("overdue");
    assertNoJsErrors(jsErrors);
  });

  it("выполненная просроченная задача НЕ подсвечивается как просроченная", async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const proj = makeProject();
    proj.tasks = [makeTask({ sectionId: proj._sTodo, title: "Готово, хоть и в прошлом", due: localDateStr(yesterday), completed: true })];
    const { dom, jsErrors } = await loadApp({ seedState: makeState({ projects: [proj] }) });
    const card = dom.window.document.querySelector(".card");
    expect(card.querySelector(".badge-due").className).not.toContain("overdue");
    assertNoJsErrors(jsErrors);
  });
});
