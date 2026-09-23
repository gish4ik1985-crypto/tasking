// Тестовый "браузер": загружает настоящий index.html в jsdom и даёт ему
// выполнить обычные <script src="..."> так же, как это делает реальный
// браузер — никакой отдельной, "упрощённой для тестов" копии кода не
// существует, тесты гоняют ровно тот же app.js/analytics.js, что видит
// пользователь.
//
// Один нюанс: в реальном приложении app.js/analytics.js подгружает
// динамически auth.js, и только ПОСЛЕ успешного входа (см. loadAppScripts()
// в auth.js) — так неавторизованный посетитель не получает код приложения
// вообще. Сам вход стучится в живой Google Apps Script по сети, чего в
// тестовом jsdom-окружении нет и мокать его тут не входит в задачу этих
// тестов (они про логику задач/проектов в app.js, а не про сам вход).
// Поэтому здесь <script src="js/auth.js">/sync.js/admin.js заменяются на
// прямую статическую загрузку analytics.js + app.js — в точности то же,
// что подгрузил бы auth.js после входа, просто без сетевого шага перед
// этим. Сам app.js от этого не отличается ни на строчку: все обращения к
// window.TaskingAuth/TaskingSync в нём и так на месте предусмотрены
// опциональными (`if (window.TaskingSync) ...`) именно для случая, когда
// синхронизация недоступна/отключена.
//
// Два режима:
//  - loadApp() (по умолчанию) — фиктивный origin http://localhost/, но
//    файлы всё равно читаются с диска (см. LocalResourceLoader ниже, а не
//    настоящий сетевой запрос). localStorage в jsdom работает только на
//    таких "нормальных" origin — под file:// jsdom считает origin
//    "непрозрачным" и глушит localStorage целиком, ЧЕГО НЕ ДЕЛАЮТ реальные
//    браузеры (у пользователя данные под file:// прекрасно сохраняются) —
//    это ограничение именно jsdom, не приложения. Поэтому весь тест
//    бизнес-логики и сохранения данных идёт через этот режим.
//  - loadApp({ protocol: "file" }) — настоящий file:///.../index.html, как
//    открывает страницу пользователь. localStorage здесь недоступен (см.
//    выше), так что этим режимом проверяется только один инвариант, зато
//    самый важный: приложение должно ЗАПУСКАТЬСЯ и РАБОТАТЬ без единой
//    неотловленной ошибки именно в этом протоколе — ровно то, что не
//    выполнялось, когда app.js был временно переведён на ES-модули.
import { JSDOM, VirtualConsole, requestInterceptor } from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "../..");

// Отдаёт содержимое <script src="..."> прямо с диска, вместо настоящего
// сетевого запроса на фиктивный http://localhost/ — тестам не нужен ни
// реальный сервер, ни интернет, а код при этом ровно тот же, что лежит в
// репозитории. (Раньше для этого использовался класс ResourceLoader — в
// установленной версии jsdom он заменён на requestInterceptor().)
const localFileInterceptor = requestInterceptor((request) => {
  const u = new URL(request.url);
  const filePath = path.join(ROOT, decodeURIComponent(u.pathname).replace(/^\//, ""));
  return new Response(readFileSync(filePath), {
    headers: { "Content-Type": "text/javascript" }
  });
});

// Загружает приложение и дожидается, пока app.js доотработает свою
// стартовую инициализацию (renderAll() в конце его IIFE). Возвращает
// { dom, jsErrors } — jsErrors копится и после загрузки (слушатель не
// снимается), так что им можно пользоваться и после кликов в тесте.
export async function loadApp({ seedState, rawLocalStorage, protocol = "http" } = {}) {
  const indexPath = path.join(ROOT, "index.html");
  const html = readFileSync(indexPath, "utf-8").replace(
    /<script src="js\/auth\.js"><\/script>\r?\n<script src="js\/sync\.js"><\/script>\r?\n<script src="js\/admin\.js"><\/script>/,
    '<script src="js/analytics.js"></script>\n<script src="js/app.js"></script>'
  );

  const jsErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.forwardTo(console, { omitJSDOMErrors: true });
  virtualConsole.on("jsdomError", (e) => jsErrors.push(e));

  const isFile = protocol === "file";
  const dom = new JSDOM(html, {
    url: isFile ? pathToFileURL(indexPath).href : "http://localhost/",
    runScripts: "dangerously",
    resources: isFile ? "usable" : { interceptors: [localFileInterceptor] },
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      // rawLocalStorage — для тестов вроде "битый JSON в localStorage", где
      // нужна строка, которая НЕ является валидным JSON.stringify(objект).
      const raw = rawLocalStorage !== undefined ? rawLocalStorage : (seedState ? JSON.stringify(seedState) : undefined);
      if (raw !== undefined) {
        try {
          window.localStorage.setItem("tasking-state-v1", raw);
        } catch (e) { /* под file:// localStorage недоступен в jsdom — см. комментарий выше */ }
      }
    }
  });

  await new Promise((resolve, reject) => {
    dom.window.addEventListener("load", resolve);
    setTimeout(() => reject(new Error("Страница не загрузилась за 5 секунд")), 5000);
  });

  return { dom, jsErrors };
}

// Полное приложение как у пользователя — с auth.js/sync.js/admin.js — но
// сервер вместо Google Apps Script — эмулятор (dev/gas-emulator.js): fetch
// страницы уходит прямо в doPost() настоящего gas/Code.gs. session —
// объект сессии, который кладётся в localStorage (вход без формы).
// failActions — действия, на которые "сервер" отвечает unknown action
// (так имитируется старая версия сервера).
export async function loadAppWithServer({ gas, session, cachedState, failActions = [], hash = "" }) {
  const indexPath = path.join(ROOT, "index.html");
  const html = readFileSync(indexPath, "utf-8");
  const jsErrors = [];
  const calls = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.forwardTo(console, { omitJSDOMErrors: true });
  virtualConsole.on("jsdomError", (e) => jsErrors.push(e));
  const dom = new JSDOM(html, {
    url: "http://localhost/" + hash,
    runScripts: "dangerously",
    resources: { interceptors: [localFileInterceptor] },
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.localStorage.setItem("tasking-auth-v1", JSON.stringify(session));
      if (cachedState) window.localStorage.setItem("tasking-state-v1", JSON.stringify(cachedState));
      window.fetch = async (_url, opts) => {
        const body = JSON.parse(opts.body);
        calls.push(body.action);
        const out = failActions.includes(body.action)
          ? JSON.stringify({ ok: false, error: "unknown action" })
          : gas.context.doPost({ postData: { contents: opts.body } }).getContent();
        return { json: async () => JSON.parse(out) };
      };
    }
  });
  await new Promise((resolve, reject) => {
    dom.window.addEventListener("load", resolve);
    setTimeout(() => reject(new Error("Страница не загрузилась за 5 секунд")), 5000);
  });
  // Ждём, пока auth.js подгрузит app.js и приложение появится.
  const until = Date.now() + 5000;
  while (!dom.window.TaskingApplyExternalState && Date.now() < until) await tick(50);
  return { dom, jsErrors, calls };
}

// Небольшая пауза — на debounce внутри save()/поиска и на завершение
// текущей очереди микрозадач/таймеров после клика или ввода.
export function tick(ms = 450) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Текущее состояние приложения, как оно реально лежит в localStorage
// тестовой страницы (то же самое, что видит save()/loadState()).
export function readState(dom) {
  const raw = dom.window.localStorage.getItem("tasking-state-v1");
  return raw ? JSON.parse(raw) : null;
}

// Кидает с понятным сообщением, если во время теста в приложении
// произошла хоть одна неотловленная ошибка.
export function assertNoJsErrors(jsErrors) {
  if (jsErrors.length) {
    throw new Error(`Неотловленные ошибки JS в приложении:\n${jsErrors.map(String).join("\n")}`);
  }
}

// Кликает по элементу так же, как это делает браузер по-настоящему —
// обычный el.click() в jsdom тоже прекрасно работает и всплывает,
// используется просто как читаемый общий хелпер для тестов.
export function click(el) {
  el.click();
}

// Печатает текст в поле ввода (через нативный сеттер value, чтобы React-
// подобные фреймворки тут ни при чём — это обычный <input>) и, по
// умолчанию, сразу нажимает Enter — ровно то, как оформлено большинство
// полей быстрого ввода в этом приложении.
export function typeInto(win, input, text, { pressEnter = true } = {}) {
  const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set;
  setter.call(input, text);
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  if (pressEnter) {
    input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  }
}
