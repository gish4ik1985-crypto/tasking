// Локальный API для разработки: настоящий gas/Code.gs на эмуляторе Apps
// Script, без боевой Google Таблицы. Запуск: npm run dev:api
// Затем в браузере на http://localhost:8934 выполнить в консоли (вход под Аней):
//   localStorage.setItem("tasking-api-url", "http://localhost:8935");
//   localStorage.setItem("tasking-auth-v1", JSON.stringify(await (await fetch("http://localhost:8935/dev-session?user=anna")).json()));
//   location.reload();
// Данные живут в памяти процесса и пропадают при перезапуске.
import http from "node:http";
import { createGasWorld } from "./gas-emulator.js";

const PORT = Number(process.env.PORT || 8935);
const gas = createGasWorld();

// Тестовые пользователи с готовыми сессиями — чтобы войти в браузере без
// формы входа: GET /dev-session?user=anna отдаёт объект сессии, его
// кладут в localStorage["tasking-auth-v1"]. Аня — администратор.
const DEV_USERS = [
  { id: "u-anna", login: "anna", name: "Аня", color: "#6d5dfc", isAdmin: true },
  { id: "u-boris", login: "boris", name: "Борис", color: "#e2554a", isAdmin: false },
  { id: "u-vera", login: "vera", name: "Вера", color: "#2fb380", isAdmin: false }
];
const usersSheet = gas.sheet("Users");
const sessionsSheet = gas.sheet("Sessions");
DEV_USERS.forEach((u) => {
  usersSheet.appendRow([u.id, u.login, "-", u.name, u.color, 40, "", u.isAdmin]);
  sessionsSheet.appendRow(["dev-token-" + u.login, u.id, Date.now() + 365 * 86400000]);
});

function devSession(login) {
  const u = DEV_USERS.find((x) => x.login === login);
  if (!u) return null;
  const who = gas.call("whoAmI", {}, "dev-token-" + u.login);
  return { token: "dev-token-" + u.login, user: who.user };
}
// Искусственная задержка, похожая на реальный Apps Script (~2 с): так
// видно, как интерфейс ведёт себя, пока сервер думает. DELAY=0 — без неё.
const DELAY = Number(process.env.DELAY ?? 1500);

http.createServer((req, res) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
  if (req.method === "GET" && req.url.startsWith("/dev-session")) {
    const login = new URL(req.url, "http://x").searchParams.get("user");
    res.writeHead(200, { ...cors, "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(devSession(login)));
    return;
  }
  if (req.method === "GET") {
    res.writeHead(200, { ...cors, "Content-Type": "text/plain; charset=utf-8" });
    res.end("Tasking mock API работает");
    return;
  }
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    setTimeout(() => {
      let out;
      try {
        out = gas.context.doPost({ postData: { contents: body } }).getContent();
      } catch (e) {
        out = JSON.stringify({ ok: false, error: String(e) });
      }
      res.writeHead(200, { ...cors, "Content-Type": "application/json; charset=utf-8" });
      res.end(out);
    }, DELAY);
  });
}).listen(PORT, () => console.log(`Tasking mock API: http://localhost:${PORT} (задержка ${DELAY} мс)`));
