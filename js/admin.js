// Панель администратора: пользователи (переименовать, цвет, сбросить пароль,
// удалить, создать нового) и настройка регистрации. Видна только тем, у кого
// в таблице (лист Users, столбец isAdmin) стоит TRUE — это поле нарочно
// нельзя выставить из самого приложения, только руками в таблице.
// Обычный <script> (не ES-модуль) — та же причина, что и в остальных файлах.
(function () {
  "use strict";

  const { escapeHtml, safeColor } = window.TaskingUtils;

  function api(action, payload) {
    return window.TaskingAuth.api(action, payload);
  }

  // Окна самого приложения (app.js), а если оно ещё не загружено —
  // встроенные браузерные.
  function ui() {
    return window.TaskingUI || {
      showConfirm: (m) => Promise.resolve(window.confirm(m)),
      showAlert: (m) => { window.alert(m); return Promise.resolve(); },
      showToast: (m) => window.alert(m)
    };
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
      <div class="admin-settings" id="adminSettings"></div>
      <form class="admin-create" id="adminCreateForm">
        <input type="text" id="adminNewLogin" placeholder="Логин" autocomplete="off" required>
        <input type="text" id="adminNewName" placeholder="Имя" autocomplete="off">
        <input type="password" id="adminNewPassword" placeholder="Пароль" autocomplete="new-password" required>
        <button type="submit" class="admin-user-btn">+ Создать пользователя</button>
      </form>
      <div class="admin-body" id="adminBody"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  const adminBody = document.getElementById("adminBody");
  const adminSettings = document.getElementById("adminSettings");
  const createForm = document.getElementById("adminCreateForm");

  function close() { overlay.hidden = true; }
  document.getElementById("adminCloseBtn").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !overlay.hidden) close(); });

  async function loadSettings() {
    const res = await api("adminSettings", {}).catch(() => null);
    if (!res || !res.ok) {
      adminSettings.innerHTML = res && res.error === "unknown action"
        ? `<div class="admin-status">Обновите серверную часть (gas/Code.gs), чтобы управлять регистрацией.</div>`
        : "";
      createForm.hidden = !!(res && res.error === "unknown action");
      return;
    }
    const open = res.settings.registrationOpen;
    adminSettings.innerHTML = `
      <label class="admin-toggle">
        <input type="checkbox" id="adminRegOpen" ${open ? "checked" : ""}>
        <span>Открытая регистрация — любой, кто знает адрес сайта, может создать себе аккаунт</span>
      </label>
      ${open ? `<div class="admin-warning">Рекомендуем выключить и заводить людей вручную формой ниже.</div>` : ""}`;
    document.getElementById("adminRegOpen").addEventListener("change", async (e) => {
      const r = await api("adminSettings", { patch: { registrationOpen: e.target.checked } }).catch(() => null);
      if (!r || !r.ok) { ui().showToast((r && r.error) || "Не удалось сохранить"); }
      loadSettings();
    });
  }

  createForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const login = document.getElementById("adminNewLogin").value.trim();
    const name = document.getElementById("adminNewName").value.trim();
    const password = document.getElementById("adminNewPassword").value;
    const res = await api("adminCreateUser", { login, name, password }).catch(() => null);
    if (!res || !res.ok) { ui().showToast((res && res.error) || "Не удалось создать пользователя"); return; }
    createForm.reset();
    ui().showToast(`Пользователь «${res.user.name}» создан — передайте ему логин и пароль`);
    loadUsers();
  });

  async function loadUsers() {
    adminBody.innerHTML = `<div class="admin-status">Загрузка...</div>`;
    const res = await api("listUsers", {}).catch(() => null);
    if (!res || !res.ok) {
      adminBody.innerHTML = `<div class="admin-status">Не удалось загрузить: ${escapeHtml((res && res.error) || "нет связи с сервером")}</div>`;
      return;
    }
    renderUsers(res.users);
  }

  function renderUsers(users) {
    const session = window.TaskingAuth.getSession();
    const myId = session && session.user.id;
    adminBody.innerHTML = users.map((u) => `
      <div class="admin-user-row" data-user-id="${escapeHtml(u.id)}">
        <input class="admin-user-color" type="color" value="${safeColor(u.color)}" data-field="color" title="Цвет">
        <input class="admin-user-name" type="text" value="${escapeHtml(u.name)}" data-field="name" title="Имя">
        <span class="admin-user-login">${escapeHtml(u.login || "")}${u.isAdmin ? ' <span class="admin-badge">админ</span>' : ""}</span>
        <button class="admin-user-btn" data-action="save">Сохранить</button>
        <span class="admin-pw">
          <input type="password" class="admin-pw-input" placeholder="Новый пароль" autocomplete="new-password" aria-label="Новый пароль для ${escapeHtml(u.name)}">
          <button class="admin-user-btn" data-action="resetpw">Сменить пароль</button>
        </span>
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
        const res = await api("adminUpdateUser", { targetUserId: userId, patch: { name, color } }).catch(() => null);
        btn.disabled = false;
        ui().showToast(res && res.ok ? "Сохранено" : ((res && res.error) || "Не удалось сохранить"));
      });

      row.querySelector('[data-action="resetpw"]').addEventListener("click", async () => {
        const input = row.querySelector(".admin-pw-input");
        const pw = input.value;
        if (!pw) { input.focus(); return; }
        const res = await api("adminUpdateUser", { targetUserId: userId, patch: { newPassword: pw } }).catch(() => null);
        input.value = "";
        ui().showToast(res && res.ok ? "Пароль изменён — пользователь выйдет со всех устройств" : ((res && res.error) || "Не удалось изменить пароль"));
      });

      const delBtn = row.querySelector('[data-action="delete"]');
      if (delBtn) {
        delBtn.addEventListener("click", async () => {
          if (!(await ui().showConfirm("Удалить этого пользователя безвозвратно? Он не сможет войти под этим логином. Его задачи и проекты не удаляются.", "Удалить"))) return;
          const res = await api("adminDeleteUser", { targetUserId: userId }).catch(() => null);
          if (!res || !res.ok) { ui().showToast((res && res.error) || "Не удалось удалить"); return; }
          loadUsers();
        });
      }
    });
  }

  window.TaskingAdmin = {
    open() { overlay.hidden = false; loadSettings(); loadUsers(); }
  };
})();
