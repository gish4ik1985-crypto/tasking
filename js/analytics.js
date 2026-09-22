// Аналитика по проекту — отдельный модуль, независимый от основного
// app.js. Не хранит и не меняет никаких данных приложения: получает уже
// готовые данные проекта (плюс несколько функций-помощников из app.js,
// чтобы не дублировать бизнес-логику вроде расчёта эффективных дат или
// блокирующих зависимостей) и строит по ним HTML-сводку.
//
// Публичный API: window.ProjectAnalytics.render(bodyEl, titleEl, ctx)
// ctx = {
//   project,               // проект, для которого показываем аналитику
//   allProjects,           // state.projects целиком (нужно для подпроектов)
//   helpers: {
//     getSubtasks, getTaskDescendantIds, getEffectiveDates,
//     isOverdue, getBlockingDependencies, assigneeName
//   }
// }
(function () {
  "use strict";

  // todayStr/addDays/escapeHtml — общие с app.js, определены один раз в
  // js/utils.js и подключены оттуда (см. index.html — utils.js загружается
  // первым, до этого файла и до app.js).
  const { todayStr, addDays, escapeHtml } = window.TaskingUtils;

  function pct(part, total) {
    return total ? Math.round((part / total) * 100) : 0;
  }

  // "ГГГГ-ММ-ДД" -> "ДД.ММ.ГГГГ"
  function fmtDate(iso) {
    if (!iso) return "";
    const [y, m, d] = iso.split("-");
    return `${d}.${m}.${y}`;
  }

  // Плоский список {task, proj} для проекта и, если includeSub — рекурсивно
  // всех его подпроектов (у "Структуры"/Гантта то же самое понятие вложенности).
  function collectTaskRows(project, allProjects, includeSub) {
    const rows = [];
    function walk(p) {
      // Заархивированные задачи намеренно убраны из аналитики — иначе
      // старая история размывала бы текущий % выполнения (см. F18).
      p.tasks.forEach((t) => { if (!t.archived) rows.push({ task: t, proj: p }); });
      if (includeSub) allProjects.filter((c) => c.parentId === p.id).forEach(walk);
    }
    walk(project);
    return rows;
  }

  function compute(ctx) {
    const { project, allProjects, helpers } = ctx;
    const { getTaskDescendantIds, getEffectiveDates, isOverdue, getBlockingDependencies, assigneeName } = helpers;

    const rows = collectTaskRows(project, allProjects, true);
    const total = rows.length;
    const completed = rows.filter((r) => r.task.completed).length;

    const overdue = rows
      .filter((r) => !r.task.completed && isOverdue(r.proj, r.task))
      .map((r) => Object.assign({ eff: getEffectiveDates(r.proj, r.task) }, r));

    const blocked = rows.filter((r) => !r.task.completed && getBlockingDependencies(r.proj, r.task).length);
    const unassigned = rows.filter((r) => !r.task.completed && !r.task.assigneeId);

    // Задача отмечена выполненной, а среди её потомков (на любую глубину)
    // ещё остались невыполненные — верный признак рассинхронизации данных,
    // стоит проверить руками.
    const staleCompleted = rows.filter((r) => {
      if (!r.task.completed) return false;
      const activeKids = getTaskDescendantIds(r.proj, r.task.id)
        .filter((id) => id !== r.task.id)
        .map((id) => r.proj.tasks.find((t) => t.id === id))
        .filter((t) => t && !t.completed);
      return activeKids.length > 0;
    });

    const today = todayStr();
    const in7 = addDays(today, 7);
    const upcoming = rows
      .filter((r) => !r.task.completed)
      .map((r) => Object.assign({ eff: getEffectiveDates(r.proj, r.task) }, r))
      .filter((r) => r.eff.due)
      .filter((r) => r.eff.due >= today && r.eff.due <= in7)
      .sort((a, b) => (a.eff.due < b.eff.due ? -1 : 1));

    // По разделам (статусам) — только собственные задачи этого проекта:
    // у подпроектов разделы свои, смешивать их в одну шкалу смысла нет.
    const bySection = project.sections.map((s) => {
      const secTasks = project.tasks.filter((t) => t.sectionId === s.id && !t.archived);
      return { name: s.name, total: secTasks.length, completed: secTasks.filter((t) => t.completed).length };
    });

    const priorities = ["high", "medium", "low"];
    const byPriority = priorities.map((p) => ({
      key: p,
      count: rows.filter((r) => !r.task.completed && (r.task.priority || "medium") === p).length
    }));

    const byAssigneeMap = {};
    rows.forEach((r) => {
      if (r.task.completed) return;
      const name = assigneeName(r.task) || "Без исполнителя";
      if (!byAssigneeMap[name]) byAssigneeMap[name] = { name, open: 0, overdue: 0, hours: 0 };
      byAssigneeMap[name].open++;
      if (isOverdue(r.proj, r.task)) byAssigneeMap[name].overdue++;
      if (r.task.estimateHours) byAssigneeMap[name].hours += r.task.estimateHours;
    });

    const subprojects = allProjects.filter((p) => p.parentId === project.id);

    return {
      total, completed, active: total - completed, pct: pct(completed, total),
      overdue, blocked, unassigned, staleCompleted, upcoming,
      bySection, byPriority,
      byAssignee: Object.values(byAssigneeMap).sort((a, b) => b.open - a.open),
      subprojects
    };
  }

  function barRow(label, value, max, color) {
    const width = max ? Math.round((value / max) * 100) : 0;
    return `
      <div class="an-bar-row">
        <span class="an-bar-label">${escapeHtml(label)}</span>
        <div class="progress-bar"><div class="progress-fill" style="width:${width}%;${color ? `background:${color}` : ""}"></div></div>
        <span class="an-bar-value">${value}</span>
      </div>
    `;
  }

  function issueListHtml(rows, emptyText, metaFn) {
    if (!rows.length) return `<div class="dash-empty">${escapeHtml(emptyText)}</div>`;
    const shown = rows.slice(0, 8);
    const rest = rows.length - shown.length;
    return `<div class="an-issue-list">` +
      shown.map((r) => `
        <div class="an-issue-row">
          <span class="an-issue-title">${escapeHtml(r.task.title)}</span>
          <span class="an-issue-meta">${escapeHtml(metaFn(r))}</span>
        </div>
      `).join("") +
      (rest > 0 ? `<div class="an-issue-more">и ещё ${rest}…</div>` : "") +
      `</div>`;
  }

  function render(bodyEl, titleEl, ctx) {
    const proj = ctx.project;
    const data = compute(ctx);

    titleEl.textContent = `📊 ${proj.name}`;

    const maxSection = Math.max(1, ...data.bySection.map((s) => s.total));
    const maxPriority = Math.max(1, ...data.byPriority.map((p) => p.count));
    const priorityLabels = { high: "Высокий", medium: "Средний", low: "Низкий" };
    const priorityColors = { high: "var(--danger)", medium: "var(--accent)", low: "var(--text-faint)" };

    const problems = [];
    if (data.overdue.length) problems.push(`⏰ Просрочено: ${data.overdue.length}`);
    if (data.blocked.length) problems.push(`⛔ Заблокировано незавершёнными зависимостями: ${data.blocked.length}`);
    if (data.staleCompleted.length) problems.push(`⚠️ Отмечено выполненным, хотя есть активные подзадачи: ${data.staleCompleted.length}`);
    if (data.unassigned.length) problems.push(`👤 Без исполнителя: ${data.unassigned.length}`);

    bodyEl.innerHTML = `
      <div class="kpi-row">
        <div class="kpi-card"><div class="kpi-value">${data.total}</div><div class="kpi-label">Всего задач (с подпроектами)</div></div>
        <div class="kpi-card"><div class="kpi-value">${data.pct}%</div><div class="kpi-label">Выполнено (${data.completed}/${data.total})</div></div>
        <div class="kpi-card ${data.overdue.length ? "warn" : ""}"><div class="kpi-value">${data.overdue.length}</div><div class="kpi-label">Просрочено</div></div>
        <div class="kpi-card ${data.blocked.length ? "warn" : ""}"><div class="kpi-value">${data.blocked.length}</div><div class="kpi-label">Заблокировано</div></div>
      </div>

      ${problems.length
        ? `<div class="dash-section an-problems"><h2>⚠ Что требует внимания</h2><ul class="an-problem-list">${problems.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul></div>`
        : `<div class="dash-section an-problems an-ok"><h2>✓ Явных проблем не найдено</h2></div>`}

      <div class="dash-grid">
        <div class="dash-section">
          <h2>Движение по разделам (свои задачи проекта)</h2>
          ${data.bySection.map((s) => barRow(`${s.name} — ${s.completed}/${s.total}`, s.total, maxSection)).join("") || `<div class="dash-empty">Нет разделов</div>`}
        </div>
        <div class="dash-section">
          <h2>Активные задачи по приоритету</h2>
          ${data.byPriority.map((p) => barRow(priorityLabels[p.key], p.count, maxPriority, priorityColors[p.key])).join("")}
        </div>
      </div>

      <div class="dash-grid">
        <div class="dash-section">
          <h2>Ближайшие сроки (7 дней)</h2>
          ${issueListHtml(data.upcoming, "Нет задач с ближайшим сроком", (r) => fmtDate(r.eff.due))}
        </div>
        <div class="dash-section">
          <h2>Просроченные задачи</h2>
          ${issueListHtml(data.overdue, "Просроченных задач нет", (r) => "срок был " + fmtDate(r.eff.due))}
        </div>
      </div>

      <div class="dash-section">
        <h2>Загрузка по исполнителям (активные задачи)</h2>
        ${data.byAssignee.length ? `
          <div class="an-assignee-table">
            ${data.byAssignee.map((a) => `
              <div class="an-assignee-row">
                <span class="an-assignee-name">${escapeHtml(a.name)}</span>
                <span class="an-assignee-stat">${a.open} задач${a.overdue ? `, <span class="an-assignee-overdue">${a.overdue} просрочено</span>` : ""}</span>
                <span class="an-assignee-hours">${a.hours ? a.hours + " ч оценки" : ""}</span>
              </div>
            `).join("")}
          </div>
        ` : `<div class="dash-empty">Нет активных задач с исполнителем</div>`}
      </div>

      ${data.subprojects.length ? `
        <div class="dash-section">
          <h2>Подпроекты (учтены в цифрах выше)</h2>
          <div class="an-subproject-list">${data.subprojects.map((sp) => `<span class="tag-chip">${escapeHtml(sp.name)}</span>`).join("")}</div>
        </div>
      ` : ""}
    `;
  }

  window.ProjectAnalytics = { render };
})();
