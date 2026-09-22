// normalizeState() должна уметь доопределить старые/неполные данные из
// localStorage: например, отсутствующее поле datesAuto/dependsOn, или
// совсем старое текстовое поле "assignee" вместо ссылки assigneeId на
// справочник людей.
import { describe, it, expect } from "vitest";
import { loadApp, tick, click, assertNoJsErrors } from "./helpers/loadApp.js";

describe("совместимость со старыми сохранёнными данными", () => {
  it("задача без datesAuto/dependsOn/estimateHours не роняет приложение", async () => {
    const legacy = {
      // нет schemaVersion, нет updatedAt — как будто сохранено очень старой версией
      users: [],
      projects: [
        {
          id: "p1",
          name: "Старый проект",
          color: "#6d5dfc",
          parentId: null,
          sections: [{ id: "s1", name: "К выполнению" }],
          tasks: [
            { id: "t1", sectionId: "s1", title: "Древняя задача", notes: "", completed: false, order: 0 }
          ]
        }
      ],
      activeProjectId: "p1",
      view: "board",
      showCompleted: true,
      screen: "project"
    };
    const { dom, jsErrors } = await loadApp({ seedState: legacy });
    const doc = dom.window.document;
    expect(doc.querySelector(".card-title").textContent).toBe("Древняя задача");

    // Любая мутация — например, отметить задачу выполненной — должна
    // сохраниться уже в АКТУАЛЬНОЙ, полностью доопределённой форме.
    click(doc.querySelector(".card-check"));
    await tick(500);
    const state = JSON.parse(dom.window.localStorage.getItem("tasking-state-v1"));
    expect(state.schemaVersion).toBe(1);
    expect(state.projects[0].tasks[0].dependsOn).toEqual([]);
    expect(state.projects[0].tasks[0].datesAuto).toBe(true);
    assertNoJsErrors(jsErrors);
  });

  it("старое текстовое поле assignee превращается в запись в справочнике людей", async () => {
    const legacy = {
      users: [],
      projects: [
        {
          id: "p1",
          name: "Проект",
          color: "#6d5dfc",
          parentId: null,
          sections: [{ id: "s1", name: "К выполнению" }],
          tasks: [
            { id: "t1", sectionId: "s1", title: "Задача Пети", notes: "", completed: false, order: 0, assignee: "Петя" }
          ]
        }
      ],
      activeProjectId: "p1",
      view: "board",
      showCompleted: true,
      screen: "project"
    };
    const { dom, jsErrors } = await loadApp({ seedState: legacy });
    const doc = dom.window.document;
    expect(doc.querySelector(".avatar").title).toBe("Петя");
    assertNoJsErrors(jsErrors);
  });

  it("битый JSON в localStorage откатывается на демо-данные, а не роняет страницу", async () => {
    const { dom, jsErrors } = await loadApp({ rawLocalStorage: "{не валидный json" });
    const doc = dom.window.document;
    expect(doc.getElementById("projectTitle").textContent).toBe("Мой первый проект");
    assertNoJsErrors(jsErrors);
  });
});
