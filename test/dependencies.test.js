// Связи "сначала выполнить" (dependsOn): задача не должна начинаться
// раньше, чем закончится предшественник, и добавление связи не должно
// уметь создать цикл (A зависит от B, B зависит от A).
import { describe, it, expect } from "vitest";
import { loadApp, tick, assertNoJsErrors } from "./helpers/loadApp.js";
import { makeState, makeProject, makeTask } from "./helpers/fixtures.js";

describe("зависимости между задачами", () => {
  it("незавершённый предшественник помечает задачу как заблокированную", async () => {
    const proj = makeProject();
    const blocker = makeTask({ sectionId: proj._sTodo, title: "Сначала это", completed: false });
    const dependent = makeTask({ sectionId: proj._sTodo, title: "Потом это", dependsOn: [blocker.id] });
    proj.tasks = [blocker, dependent];
    const { dom, jsErrors } = await loadApp({ seedState: makeState({ projects: [proj] }) });
    const card = [...dom.window.document.querySelectorAll(".card")]
      .find((c) => c.querySelector(".card-title").textContent === "Потом это");
    expect(card.querySelector(".badge-blocked")).not.toBeNull();
    assertNoJsErrors(jsErrors);
  });

  it("завершённый предшественник снимает блокировку", async () => {
    const proj = makeProject();
    const blocker = makeTask({ sectionId: proj._sTodo, title: "Сначала это", completed: true });
    const dependent = makeTask({ sectionId: proj._sTodo, title: "Потом это", dependsOn: [blocker.id] });
    proj.tasks = [blocker, dependent];
    const { dom, jsErrors } = await loadApp({ seedState: makeState({ projects: [proj] }) });
    const card = [...dom.window.document.querySelectorAll(".card")]
      .find((c) => c.querySelector(".card-title").textContent === "Потом это");
    expect(card.querySelector(".badge-blocked")).toBeNull();
    assertNoJsErrors(jsErrors);
  });

  it("нельзя выбрать в качестве зависимости задачу, которая создала бы цикл", async () => {
    // A уже зависит от B ("A после B"). Открываем B и смотрим на список
    // "+ Добавить зависимость" — там не должно быть A, иначе выбор A
    // сделал бы B зависимым от A, а A уже зависит от B — цикл.
    const proj = makeProject();
    const taskB = makeTask({ sectionId: proj._sTodo, title: "B" });
    const taskA = makeTask({ sectionId: proj._sTodo, title: "A", dependsOn: [taskB.id] });
    proj.tasks = [taskA, taskB];
    const { dom, jsErrors } = await loadApp({ seedState: makeState({ projects: [proj] }) });
    const doc = dom.window.document;
    doc.querySelector(`[data-task-id="${taskB.id}"]`).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await tick(50);
    const options = [...doc.getElementById("depsAddSelect").options].map((o) => o.textContent);
    expect(options).not.toContain("A");
    assertNoJsErrors(jsErrors);
  });

  it("добавление зависимости через селект сохраняется", async () => {
    const proj = makeProject();
    const taskB = makeTask({ sectionId: proj._sTodo, title: "B" });
    const taskA = makeTask({ sectionId: proj._sTodo, title: "A" });
    proj.tasks = [taskA, taskB];
    const { dom, jsErrors } = await loadApp({ seedState: makeState({ projects: [proj] }) });
    const doc = dom.window.document;
    doc.querySelector(`[data-task-id="${taskA.id}"]`).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await tick(50);
    const select = doc.getElementById("depsAddSelect");
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value").set;
    setter.call(select, taskB.id);
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await tick(500);
    const raw = JSON.parse(dom.window.localStorage.getItem("tasking-state-v1"));
    const savedA = raw.projects[0].tasks.find((t) => t.id === taskA.id);
    expect(savedA.dependsOn).toContain(taskB.id);
    assertNoJsErrors(jsErrors);
  });
});
