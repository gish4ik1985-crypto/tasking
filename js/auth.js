// Авторизация: страница-визитка + вход/регистрация + меню профиля.
// Отдельный от app.js файл, чтобы не трогать его логику задач — этот
// скрипт только решает, показывать ли основное приложение (`.app`) или
// стартовую страницу, и хранит сессию пользователя в localStorage этого
// браузера. Обычный <script> (не ES-модуль) — та же причина, что и в
// остальных файлах: приложение открывают и через file://.
(function () {
  "use strict";

  // Публичный URL Google Apps Script Web App (см. gas/Code.gs).
  const PROD_API_URL = "https://script.google.com/macros/s/AKfycbxxbIRLKjIOItiPCc74hpXAxCSvMH-xHTjBSc8VpPz5v2elLYmE303C1kt4lIpRGSs/exec";
  // Для разработки: localStorage["tasking-api-url"] = "http://localhost:8935"
  // направляет приложение на локальный эмулятор (npm run dev:api) вместо
  // боевой таблицы. Работает только для адресов localhost/127.0.0.1.
  const API_URL = (function () {
    try {
      const custom = localStorage.getItem("tasking-api-url");
      if (custom && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(custom)) return custom;
    } catch (e) { /* нет доступа к localStorage — берём боевой адрес */ }
    return PROD_API_URL;
  })();
  const STATE_KEY = "tasking-state-v1";
  const SESSION_KEY = "tasking-auth-v1";

  function loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function saveSession(session) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }

  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
  }

  function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  // 2 повторные попытки при сетевом сбое (fetch бросает исключение — обрыв
  // соединения, таймаут и т.п.), прежде чем сдаться. Без этого случайный
  // разовый сбой посреди отправки многих изменений (например, при большом
  // импорте) навсегда оставлял бы одну задачу несинхронизированной, пока
  // пользователь случайно не тронет что-то ещё.
  async function api(action, payload, attempt) {
    attempt = attempt || 0;
    const session = loadSession();
    const body = Object.assign({ action }, payload, session ? { token: session.token } : {});
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(body)
      });
      return await res.json();
    } catch (err) {
      if (attempt >= 2) throw err;
      await wait(800 * (attempt + 1));
      return api(action, payload, attempt + 1);
    }
  }

  // ---------- Разметка ----------

  const appRoot = document.querySelector(".app");

  const landing = document.createElement("div");
  landing.className = "auth-landing";
  landing.id = "authLanding";
  landing.innerHTML = `
    <div class="auth-card">
      <div class="auth-brand">
        <span class="brand-mark">T</span>
        <span class="brand-name">Tasking</span>
      </div>
      <p class="auth-tagline">Менеджер задач для команды: доска, список, Гант и сроки — без лишнего.</p>
      <p class="auth-status" id="authStatus" hidden></p>
      <form class="auth-form" id="authForm">
        <label class="auth-field">
          <span>Логин</span>
          <input type="text" id="authLogin" autocomplete="username" required>
        </label>
        <label class="auth-field">
          <span>Пароль</span>
          <input type="password" id="authPassword" autocomplete="current-password" required>
        </label>
        <div class="auth-error" id="authError" hidden></div>
        <button type="submit" class="auth-submit" id="authSubmit">Войти</button>
        <p class="auth-hint">Если вы заходите первый раз — аккаунт с этим логином и паролем создастся автоматически.</p>
      </form>
    </div>
  `;
  document.body.appendChild(landing);

  const profileMenu = document.createElement("div");
  profileMenu.className = "profile-menu";
  profileMenu.id = "profileMenu";
  profileMenu.hidden = true;
  profileMenu.innerHTML = `
    <button class="profile-btn" id="profileBtn" type="button"></button>
    <div class="profile-panel" id="profilePanel" hidden>
      <label class="auth-field">
        <span>Имя</span>
        <input type="text" id="profileName">
      </label>
      <label class="auth-field">
        <span>Цвет</span>
        <input type="color" id="profileColor">
      </label>
      <label class="auth-field">
        <span>Часов в неделю</span>
        <input type="number" id="profileHours" min="0" step="1">
      </label>
      <div class="auth-field">
        <span>Показывать вкладки</span>
        <div class="profile-views-list" id="profileViewsList">
          <label class="profile-view-check"><input type="checkbox" value="board"> Доска</label>
          <label class="profile-view-check"><input type="checkbox" value="list"> Список</label>
          <label class="profile-view-check"><input type="checkbox" value="tree"> По статусам</label>
          <label class="profile-view-check"><input type="checkbox" value="structure"> Структура</label>
          <label class="profile-view-check"><input type="checkbox" value="gantt"> Гант</label>
          <label class="profile-view-check"><input type="checkbox" value="calendar"> Календарь</label>
        </div>
      </div>
      <label class="auth-field">
        <span>Почта для уведомлений</span>
        <input type="email" id="profileEmail" placeholder="name@example.com" autocomplete="email">
      </label>
      <label class="profile-view-check">
        <input type="checkbox" id="profileNotify"> Присылать письма: назначения, сообщения, упоминания, согласования
      </label>
      <div class="auth-error" id="profileError" hidden></div>
      <button type="button" class="auth-submit" id="profileSaveBtn">Сохранить</button>
      <button type="button" class="profile-admin-btn" id="profileAdminBtn" hidden>⚙ Управление пользователями</button>
      <button type="button" class="profile-logout" id="profileLogoutBtn">Выйти</button>
    </div>
  `;
  const sidebarTop = document.querySelector(".sidebar-top");
  if (sidebarTop) sidebarTop.appendChild(profileMenu);

  // ---------- Логика ----------

  const authForm = document.getElementById("authForm");
  const authLoginInput = document.getElementById("authLogin");
  const authPasswordInput = document.getElementById("authPassword");
  const authError = document.getElementById("authError");
  const authSubmit = document.getElementById("authSubmit");
  const authStatus = document.getElementById("authStatus");

  const profileBtn = document.getElementById("profileBtn");
  const profilePanel = document.getElementById("profilePanel");
  const profileName = document.getElementById("profileName");
  const profileColor = document.getElementById("profileColor");
  const profileHours = document.getElementById("profileHours");
  const profileError = document.getElementById("profileError");
  const profileSaveBtn = document.getElementById("profileSaveBtn");
  const profileAdminBtn = document.getElementById("profileAdminBtn");
  const profileLogoutBtn = document.getElementById("profileLogoutBtn");
  const profileViewChecks = Array.from(document.querySelectorAll("#profileViewsList input[type=checkbox]"));
  const profileEmail = document.getElementById("profileEmail");
  const profileNotify = document.getElementById("profileNotify");
  const ALL_VIEWS = ["board", "list", "tree", "structure", "gantt", "calendar"];

  // Показывает/прячет кнопки-вкладки (Доска/Список/.../Гант) в шапке
  // проекта согласно выбору пользователя в профиле. app.js ничего не знает
  // об этом — просто прячем лишние кнопки переключателя видов снаружи.
  function applyViewVisibility(views) {
    const list = Array.isArray(views) && views.length ? views : ALL_VIEWS;
    const buttons = document.querySelectorAll(".view-switch .view-btn[data-view]");
    if (!buttons.length) return;
    buttons.forEach((btn) => { btn.hidden = !list.includes(btn.dataset.view); });
    const activeBtn = document.querySelector(".view-switch .view-btn.active");
    if (activeBtn && activeBtn.hidden) {
      const firstVisible = document.querySelector(".view-switch .view-btn[data-view]:not([hidden])");
      if (firstVisible) firstVisible.click();
    }
  }

  let scriptsLoaded = false;
  // Подгружает analytics.js и app.js динамически (в том же порядке, что
  // раньше был в index.html статически) — только когда данные уже лежат
  // в localStorage, чтобы app.js при старте (`let state = loadState()`,
  // выполняется синхронно в момент выполнения скрипта) сразу увидел
  // свежие данные с сервера, а не старые локальные.
  function loadAppScripts() {
    if (scriptsLoaded) return Promise.resolve();
    return new Promise((resolve, reject) => {
      // Кэш-бастинг: скрипты подгружаются динамически (не статическим
      // <script> тегом из index.html), а браузеры иногда агрессивно кэшируют
      // такие запросы между заходами — без этого правки app.js/analytics.js
      // могли бы не доходить до уже открытых у пользователей вкладок.
      const v = Date.now();
      const analyticsScript = document.createElement("script");
      analyticsScript.src = "js/analytics.js?v=" + v;
      analyticsScript.onload = () => {
        const appScript = document.createElement("script");
        appScript.src = "js/app.js?v=" + v;
        appScript.onload = () => { scriptsLoaded = true; resolve(); };
        appScript.onerror = () => reject(new Error("Не удалось загрузить js/app.js"));
        document.body.appendChild(appScript);
      };
      analyticsScript.onerror = () => reject(new Error("Не удалось загрузить js/analytics.js"));
      document.body.appendChild(analyticsScript);
    });
  }

  function updateProfileUi(user) {
    profileBtn.textContent = (user.name || user.login || "?").slice(0, 1).toUpperCase();
    profileBtn.title = user.name || user.login;
    profileName.value = user.name || "";
    profileColor.value = user.color || "#6d5dfc";
    profileHours.value = user.weeklyHours != null ? user.weeklyHours : 40;
    const views = Array.isArray(user.visibleViews) && user.visibleViews.length ? user.visibleViews : ALL_VIEWS;
    profileViewChecks.forEach((cb) => { cb.checked = views.includes(cb.value); });
    profileEmail.value = user.email || "";
    profileNotify.checked = !!user.notifyEmail;
    applyViewVisibility(views);
    profileAdminBtn.hidden = !user.isAdmin;
  }

  profileAdminBtn.addEventListener("click", () => {
    profilePanel.hidden = true;
    if (window.TaskingAdmin) window.TaskingAdmin.open();
  });

  // Тянет задачи с сервера и только потом открывает приложение — до этого
  // момента неавторизованный (или ещё не проверенный) посетитель не видит
  // ничего, кроме стартовой карточки, и код app.js вообще не загружен.
  async function enterApp(user) {
    authStatus.hidden = false;
    authStatus.textContent = "Загружаем ваши задачи...";
    authForm.hidden = true;
    authError.hidden = true;
    try {
      await window.TaskingSync.pull();
      await loadAppScripts();
      landing.hidden = true;
      appRoot.hidden = false;
      profileMenu.hidden = false;
      updateProfileUi(user);
      window.TaskingSync.startPolling();
    } catch (err) {
      authForm.hidden = false;
      authStatus.hidden = true;
      authError.textContent = "Не удалось загрузить задачи: " + (err && err.message ? err.message : err);
      authError.hidden = false;
    }
  }

  function showLanding() {
    landing.hidden = false;
    authForm.hidden = false;
    authStatus.hidden = true;
    if (appRoot) appRoot.hidden = true;
    profileMenu.hidden = true;
    profilePanel.hidden = true;
  }

  authForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    authError.hidden = true;
    authSubmit.disabled = true;
    authSubmit.textContent = "Входим...";
    try {
      const login = authLoginInput.value.trim();
      const password = authPasswordInput.value;
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "login", login, password })
      }).then((r) => r.json());
      if (!res.ok) {
        authError.textContent = res.error || "Не удалось войти";
        authError.hidden = false;
        return;
      }
      saveSession({ token: res.token, user: res.user });
      authPasswordInput.value = "";
      await enterApp(res.user);
    } catch (err) {
      authError.textContent = "Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.";
      authError.hidden = false;
    } finally {
      authSubmit.disabled = false;
      authSubmit.textContent = "Войти";
    }
  });

  profileBtn.addEventListener("click", () => {
    profilePanel.hidden = !profilePanel.hidden;
  });

  document.addEventListener("click", (e) => {
    if (!profileMenu.contains(e.target)) profilePanel.hidden = true;
  });

  profileSaveBtn.addEventListener("click", async () => {
    profileError.hidden = true;
    const checkedViews = profileViewChecks.filter((cb) => cb.checked).map((cb) => cb.value);
    if (!checkedViews.length) {
      profileError.textContent = "Оставьте хотя бы одну вкладку.";
      profileError.hidden = false;
      return;
    }
    profileSaveBtn.disabled = true;
    try {
      const res = await api("updateProfile", {
        profile: {
          name: profileName.value.trim(), color: profileColor.value, weeklyHours: profileHours.value, visibleViews: checkedViews,
          email: profileEmail.value.trim(), notifyEmail: profileNotify.checked
        }
      });
      if (!res.ok) {
        profileError.textContent = res.error || "Не удалось сохранить";
        profileError.hidden = false;
        return;
      }
      if (profileEmail.value.trim() && !res.user.email && res.user.email !== undefined) {
        profileError.textContent = "Почта не сохранена — проверьте адрес.";
        profileError.hidden = false;
      }
      const session = loadSession();
      session.user = res.user;
      saveSession(session);
      profileBtn.textContent = (res.user.name || res.user.login || "?").slice(0, 1).toUpperCase();
      profileBtn.title = res.user.name || res.user.login;
      applyViewVisibility(res.user.visibleViews);
      if (profileError.hidden) profilePanel.hidden = true;
    } catch (err) {
      profileError.textContent = "Нет связи с сервером.";
      profileError.hidden = false;
    } finally {
      profileSaveBtn.disabled = false;
    }
  });

  // Выход: дожидаемся отправки несохранённого, отзываем сессию на сервере
  // и стираем данные из браузера — на общем компьютере следующий человек
  // не должен видеть чужие задачи.
  profileLogoutBtn.addEventListener("click", async () => {
    profileLogoutBtn.disabled = true;
    profileLogoutBtn.textContent = "Выходим…";
    try {
      if (window.TaskingSync && window.TaskingSync.flush) await window.TaskingSync.flush(8000);
      await Promise.race([api("logout", {}), new Promise((r) => setTimeout(r, 4000))]);
    } catch (e) { /* нет связи — сессия всё равно истечёт сама */ }
    try { localStorage.removeItem(STATE_KEY); } catch (e) { /* игнор */ }
    clearSession();
    // Перезагружаем страницу целиком — самый надёжный способ сбросить уже
    // выполнившийся app.js (его внутреннее состояние живёт в переменных
    // модуля, а не в чём-то, что можно аккуратно "остановить" снаружи).
    location.reload();
  });

  window.TaskingAuth = { api, getSession: loadSession };

  // ---------- Старт ----------

  if (appRoot) appRoot.hidden = true; // ничего не показываем, пока не проверим сессию
  authStatus.hidden = false;
  authStatus.textContent = "Проверяем сессию...";
  authForm.hidden = true;

  // Сервер сообщил, что сессия больше не действительна (истекла, отозвана
  // сменой пароля) — возвращаем на экран входа.
  window.addEventListener("tasking:auth-lost", () => {
    clearSession();
    location.reload();
  });

  // Мгновенный старт: если данные с прошлого раза лежат в браузере,
  // показываем приложение сразу, а сессию и свежие данные проверяем в фоне
  // (раньше каждое открытие ждало два похода на сервер — 4–8 секунд).
  async function enterFromCache(session) {
    try {
      await loadAppScripts();
    } catch (err) {
      return false;
    }
    landing.hidden = true;
    appRoot.hidden = false;
    profileMenu.hidden = false;
    updateProfileUi(session.user);
    window.TaskingSync.startPolling();
    window.TaskingSync.refreshNow();
    api("whoAmI", {}).then((res) => {
      if (res.ok) {
        session.user = res.user;
        saveSession(session);
        updateProfileUi(res.user);
      } else if (res.error === "unauthorized") {
        clearSession();
        location.reload();
      }
    }).catch(() => { /* нет связи — работаем с кэшем, опрос повторит */ });
    return true;
  }

  // Запуск — когда загружены все скрипты страницы (sync.js идёт после auth.js).
  function start() {
  const session = loadSession();
  if (session && session.token && session.user && typeof window.TaskingSync.initFromCache === "function" && window.TaskingSync.initFromCache()) {
    enterFromCache(session).then((ok) => { if (!ok) location.reload(); });
  } else if (session && session.token) {
    // Есть сохранённый токен — проверяем, что он ещё действителен (мог
    // истечь через 30 дней или после пересоздания таблицы), и только
    // потом тянем задачи и открываем приложение.
    api("whoAmI", {}).then((res) => {
      if (res.ok) {
        session.user = res.user;
        saveSession(session);
        return enterApp(res.user);
      }
      clearSession();
      showLanding();
    }).catch(() => {
      authForm.hidden = false;
      authStatus.hidden = true;
      authError.textContent = "Нет связи с сервером. Проверьте интернет и обновите страницу.";
      authError.hidden = false;
    });
  } else {
    showLanding();
  }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
