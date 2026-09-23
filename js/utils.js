// Общие для js/app.js и js/analytics.js вспомогательные функции — раньше
// дублировались (буквально одним и тем же кодом) в обоих файлах, потому
// что там негде было их "импортировать" одно из другого: это обычные
// <script>, не ES-модули (см. комментарий в начале app.js — приложение
// открывают через file://, а браузеры блокируют загрузку ES-модулей
// оттуда). Обычный script такого ограничения не имеет, так что первый шаг
// к разбиению app.js на файлы — вынести то, что не завязано на состояние
// приложения, сюда и отдать через общий window.TaskingUtils. Загружается
// первым, до analytics.js и app.js (см. index.html).
(function () {
  "use strict";

  // Объект Date (в локальном времени) -> строка "ГГГГ-ММ-ДД". В отличие от
  // toISOString() не уходит в UTC, поэтому не "съезжает" на соседний день
  // у пользователей в часовых поясах, отличных от UTC+0.
  function dateToStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  // Строка "ГГГГ-ММ-ДД" -> объект Date в полночь ЛОКАЛЬНОГО времени. В
  // отличие от new Date("ГГГГ-ММ-ДД") (которая трактует такую строку как
  // UTC-полночь) не сдвигает календарный день при чтении в часовых поясах
  // западнее UTC.
  function strToDate(s) {
    const [y, m, day] = s.split("-").map(Number);
    return new Date(y, m - 1, day);
  }

  // Сегодняшняя дата в формате "ГГГГ-ММ-ДД" (как в <input type="date">).
  function todayStr() {
    return dateToStr(new Date());
  }

  // Дата "base" плюс/минус days дней, тоже в формате "ГГГГ-ММ-ДД".
  function addDays(base, days) {
    const d = strToDate(base);
    d.setDate(d.getDate() + days);
    return dateToStr(d);
  }

  // Экранирует &<>"' для безопасной вставки пользовательского текста в
  // HTML через шаблонные строки + innerHTML.
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  // Цвет для вставки в style="..." — только #rgb / #rrggbb, иначе запасной.
  // Цвета приходят с сервера (профили, проекты), и без этой проверки строка
  // вида '#fff" onmouseover="…' выполнилась бы как код в чужом браузере.
  function safeColor(value, fallback) {
    const s = String(value == null ? "" : value).trim();
    return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s) ? s : (fallback || "#6d5dfc");
  }

  window.TaskingUtils = { dateToStr, strToDate, todayStr, addDays, escapeHtml, safeColor };
})();
