// Плоский конфиг ESLint 9. Цель — ловить реальные ошибки (необъявленные
// переменные, забытые await, недостижимый код и т.п.), а не навязывать
// стиль: форматированием занимается Prettier (см. .prettierrc), а не
// ESLint, чтобы два инструмента не спорили друг с другом.
import js from "@eslint/js";
import globals from "globals";

// Значение по умолчанию для no-unused-vars в обоих конфигах ниже:
// - caughtErrors: "none" — в проекте много `catch (e) { /* коммент,
//   почему ошибка намеренно игнорируется */ }`, это осознанный стиль, а
//   не забытый код.
// - argsIgnorePattern: "^_" — параметр, специально названный с
//   подчёркивания, значит "нужен по позиции, но не используется".
const noUnusedVars = ["warn", { argsIgnorePattern: "^_", caughtErrors: "none" }];

export default [
  js.configs.recommended,
  {
    // Код самого приложения: обычные <script> в браузере, без модулей и
    // без сборщика (см. память проекта — index.html открывают напрямую
    // как file://, поэтому это не переиспользуемая деталь, а требование).
    files: ["js/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.browser,
        // analytics.js подключается отдельным <script> ДО app.js и кладёт
        // сюда свой публичный API (см. js/analytics.js) — с точки зрения
        // ESLint, который проверяет app.js в изоляции, это просто ещё один
        // глобальный объект, определённый до его использования.
        ProjectAnalytics: "readonly"
      }
    },
    rules: {
      "no-unused-vars": noUnusedVars
    }
  },
  {
    // Тесты и их хелперы: Node + Vitest, обычные ES-модули (это только
    // для разработки, никак не грузится в браузере пользователя).
    files: ["test/**/*.js", "dev/**/*.js", "dev/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node }
    },
    rules: {
      "no-unused-vars": noUnusedVars
    }
  },
  {
    ignores: ["node_modules/**", "coverage/**"]
  }
];
