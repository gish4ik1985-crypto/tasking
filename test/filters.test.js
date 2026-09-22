// Панель фильтров (по исполнителю/приоритету/сроку/тегу) дополняет
// текстовый поиск и применяется одинаково во всех видах — эти тесты
// проверяют доску и список, а сама логика (matchesSearch) общая для всех.
import { describe, it, expect } from "vitest";
import { loadApp, tick, assertNoJsErrors } from "./helpers/loadApp.js";
import { makeState, makeProject, makeTask } from "./helpers/fixtures.js";

function setSelect(win, select, value) {
  const setter = Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, "value").set;
  setter.call(select, value);
  select.dispatchEvent(new win.Event("change", { bubbles: true }));
}

function buildProject() {
  const proj = makeProject();
  const high = makeTask({ sectionId: proj._sTodo, title: "Важная", priority: "high", tags: ["срочно"] });
  const low = makeTask({ sectionId: proj._sTodo, title: "Неважная", priority: "low" });
  proj.tasks = [high, low];
  return { proj, high, low };
}

describe("панель фильтров", () => {
  it("фильтр по приоритету скрывает несовпадающие карточки на доске", async () => {
    const { proj, high } = buildProject();
    const { dom, jsErrors } = await loadApp({ seedState: makeState({ projects: [proj] }) });
    const doc = dom.window.document;
    setSelect(dom.window, doc.getElementById("filterPriority"), "high");
    await tick(50);
    const titles = [...doc.querySelectorAll(".card-title")].map((e) => e.textContent);
    expect(titles).toEqual([high.title]);
    assertNoJsErrors(jsErrors);
  });

  it("фильтр по тегу работает и в виде «Список»", async () => {
    const { proj, high } = buildProject();
    const { dom, jsErrors } = await loadApp({ seedState: makeState({ projects: [proj], view: "list" }) });
    const doc = dom.window.document;
    setSelect(dom.window, doc.getElementById("filterTag"), "срочно");
    await tick(50);
    const titles = [...doc.querySelectorAll(".row-title")].map((e) => e.textContent);
    expect(titles).toEqual([high.title]);
    assertNoJsErrors(jsErrors);
  });

  it("счётчик активных фильтров и «Сбросить» возвращают всё как было", async () => {
    const { proj } = buildProject();
    const { dom, jsErrors } = await loadApp({ seedState: makeState({ projects: [proj] }) });
    const doc = dom.window.document;
    setSelect(dom.window, doc.getElementById("filterPriority"), "high");
    await tick(50);
    expect(doc.getElementById("filterCount").hidden).toBe(false);
    expect(doc.getElementById("filterCount").textContent).toBe("1");

    doc.getElementById("filterResetBtn").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await tick(50);
    expect(doc.getElementById("filterCount").hidden).toBe(true);
    expect(doc.querySelectorAll(".card-title")).toHaveLength(2);
    assertNoJsErrors(jsErrors);
  });

  it("«Без исполнителя» показывает только задачи без назначенного человека", async () => {
    const proj = makeProject();
    const user = { id: "u1", name: "Аня", color: "#000", weeklyHours: 40 };
    const assigned = makeTask({ sectionId: proj._sTodo, title: "Назначена", assigneeId: user.id });
    const unassigned = makeTask({ sectionId: proj._sTodo, title: "Не назначена" });
    proj.tasks = [assigned, unassigned];
    const { dom, jsErrors } = await loadApp({ seedState: makeState({ projects: [proj], users: [user] }) });
    const doc = dom.window.document;
    setSelect(dom.window, doc.getElementById("filterAssignee"), "none");
    await tick(50);
    const titles = [...doc.querySelectorAll(".card-title")].map((e) => e.textContent);
    expect(titles).toEqual([unassigned.title]);
    assertNoJsErrors(jsErrors);
  });

  it("список тегов в фильтре собирается по ВСЕМ проектам, а не только по активному", async () => {
    const tagged = makeProject({ name: "С тегами" });
    tagged.tasks = [makeTask({ sectionId: tagged._sTodo, title: "Задача", tags: ["важное"] })];
    const empty = makeProject({ name: "Без тегов" });
    const { dom, jsErrors } = await loadApp({ seedState: makeState({ projects: [tagged, empty], activeProjectId: empty.id }) });
    const doc = dom.window.document;
    const options = [...doc.getElementById("filterTag").options].map((o) => o.value);
    expect(options).toContain("важное");
    assertNoJsErrors(jsErrors);
  });

  it("панель закрывается кликом снаружи", async () => {
    const { dom, jsErrors } = await loadApp({ seedState: makeState({ projects: [buildProject().proj] }) });
    const doc = dom.window.document;
    doc.getElementById("filterToggleBtn").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    expect(doc.getElementById("filterPanel").hidden).toBe(false);
    doc.body.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    expect(doc.getElementById("filterPanel").hidden).toBe(true);
    assertNoJsErrors(jsErrors);
  });
});
