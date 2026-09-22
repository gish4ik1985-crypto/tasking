// Панель администратора: список пользователей с возможностью переименовать,
// сменить цвет, сбросить пароль и удалить аккаунт. Видна только тем, у кого
// в таблице (лист Users, столбец isAdmin) стоит TRUE — это поле нарочно
// нельзя выставить из самого приложения, только руками в таблице (см.
// комментарий в начале gas/Code.gs). Полные права на сами задачи/проекты
// администратор получает "бесплатно" через обычный интерфейс — сервер
// отдаёт ему canEdit:true везде, тут добавлена только работа с людьми.
// Обычный <script> (не ES-модуль) — та же причина, что и в остальных файлах.
(function () {
  "use strict";

  const { escapeHtml } = window.TaskingUtils;

  function api(action, payload) {
    return window.TaskingAuth.api(action, payload);
  }

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay admin-overlay";
  overlay.id = "adminOverlay";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="admin-modal" role="dialog" aria-modal="true" aria-label="Управление пользователями">
      <div class="admin-header">
        <h2>Пользователи</h2>
        <button class="detail-close" id="adminCloseBtn" title="Закрыть" aria-label="Закрыть">×</button>
      </div>
      <div class="admin-body" id="adminBody"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  const adminBody = document.getElementById("adminBody");

  document.getElementById("adminCloseBtn").addEventListener("click", () => { overlay.hidden = true; });
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.hidden = true; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !overlay.hidden) overlay.hidden = true; });

  async function loadUsers() {
    adminBody.innerHTML = `<div class="admin-status">Загрузка...</div>`;
    const res = await api("listUsers", {});
    if (!res.ok) {
      adminBody.innerHTML = `<div class="admin-status">Не удалось загрузить: ${escapeHtml(res.error || "неизвестная ошибка")}</div>`;
      return;
    }
    renderUsers(res.users);
  }

  function renderUsers(users) {
    const session = window.TaskingAuth.getSession();
    const myId = session && session.user.id;
    adminBody.innerHTML = users.map((u) => `
      <div class="admin-user-row" data-user-id="${u.id}">
        <input class="admin-user-color" type="color" value="${u.color || "#6d5dfc"}" data-field="color" title="Цвет">
        <input class="admin-user-name" type="text" value="${escapeHtml(u.name)}" data-field="name" title="Имя">
        <span class="admin-user-login">${escapeHtml(u.login)}${u.isAdmin ? ' <span class="admin-badge">админ</span>' : ""}</span>
        <button class="admin-user-btn" data-action="save">Сохранить</button>
        <button class="admin-user-btn" data-action="resetpw">Сбросить пароль</button>
        ${u.id !== myId ? `<button class="admin-user-btn admin-user-btn-danger" data-action="delete">Удалить</button>` : ""}
      </div>
    `).join("") || `<div class="admin-status">Пользователей пока нет</div>`;

    adminBody.querySelectorAll(".admin-user-row").forEach((row) => {
      const userId = row.dataset.userId;

      row.querySelector('[data-action="save"]').addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        const name = row.querySelector('[data-field="name"]').value.trim();
        const color = row.querySelector('[data-field="color"]').value;
        btn.disabled = true;
        const res = await api("adminUpdateUser", { targetUserId: userId, patch: { name, color } });
        btn.disabled = false;
        if (!res.ok) alert(res.error || "Не удалось сохранить");
      });

      row.querySelector('[data-action="resetpw"]').addEventListener("click", async () => {
        const pw = prompt("Новый пароль для этого пользователя (он введёт его при следующем входе):");
        if (!pw) return;
        const res = await api("adminUpdateUser", { targetUserId: userId, patch: { newPassword: pw } });
        alert(res.ok ? "Пароль изменён." : (res.error || "Не удалось изменить пароль"));
      });

      const delBtn = row.querySelector('[data-action="delete"]');
      if (delBtn) {
        delBtn.addEventListener("click", async () => {
          if (!confirm("Удалить этого пользователя безвозвратно? Он не сможет войти под этим логином. Его задачи и проекты НЕ удаляются.")) return;
          const res = await api("adminDeleteUser", { targetUserId: userId });
          if (!res.ok) { alert(res.error || "Не удалось удалить"); return; }
          loadUsers();
        });
      }
    });
  }

  window.TaskingAdmin = {
    open() { overlay.hidden = false; loadUsers(); }
  };
})();
