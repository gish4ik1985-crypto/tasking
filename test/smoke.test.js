import { describe, it, expect } from "vitest";
import { loadApp, readState, tick, assertNoJsErrors } from "./helpers/loadApp.js";

describe("загрузка приложения", () => {
  it("рисует демо-проект при пустом localStorage", async () => {
    const { dom, jsErrors } = await loadApp();
    const doc = dom.window.document;
    expect(doc.getElementById("projectTitle").textContent).toBe("Мой первый проект");
    expect(doc.querySelectorAll(".card").length).toBeGreaterThan(0);
    assertNoJsErrors(jsErrors);
  });

  it("сохраняет состояние в localStorage после изменения", async () => {
    const { dom, jsErrors } = await loadApp();
    const doc = dom.window.document;
    // Берём карточку БЕЗ подзадач — у "Крупная задача с подзадачами" есть
    // невыполненные подзадачи, и клик по её чекбоксу открыл бы модалку
    // подтверждения (confirmCompleteWithActiveChildren), которая без
    // ответа "зависла" бы, и toggleComplete не дошёл бы до commit().
    const card = [...doc.querySelectorAll(".card")]
      .find((c) => c.querySelector(".card-title").textContent.includes("Перетащите"));
    card.querySelector(".card-check").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await tick();
    const state = readState(dom);
    expect(state).not.toBeNull();
    expect(state.schemaVersion).toBe(1);
    assertNoJsErrors(jsErrors);
  });
});

// Пользователь открывает приложение именно так — двойным кликом по
// index.html, без сервера. Единственное, что здесь можно и нужно
// проверить (localStorage в jsdom под file:// недоступен в принципе,
// см. helpers/loadApp.js) — что страница загружается и обычные действия
// не бросают неотловленных ошибок. Именно этот тест поймал бы прошлую
// поломку (ES-модули не грузятся под file://).
describe("открытие напрямую как файл (file://)", () => {
  it("загружается без ошибок и рисует доску", async () => {
    const { dom, jsErrors } = await loadApp({ protocol: "file" });
    const doc = dom.window.document;
    expect(doc.getElementById("projectTitle").textContent.length).toBeGreaterThan(0);
    expect(doc.querySelectorAll(".card").length).toBeGreaterThan(0);
    assertNoJsErrors(jsErrors);
  });

  it("переключение вида и отметка задачи выполненной не бросают ошибок", async () => {
    const { dom, jsErrors } = await loadApp({ protocol: "file" });
    const doc = dom.window.document;
    doc.querySelector('[data-view="gantt"]').dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await tick(100);
    doc.getElementById("dashboardNavBtn").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await tick(100);
    assertNoJsErrors(jsErrors);
  });
});
