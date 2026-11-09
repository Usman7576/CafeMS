// Lint rules: ESLint's recommended set plus eslint-plugin-security, which flags risky patterns such as
// eval, dynamic regular expressions, child processes and non-literal file paths. CI fails on any error.
const js = require("@eslint/js");
const security = require("eslint-plugin-security");
const globals = require("globals");

module.exports = [
  { ignores: ["node_modules/", "public/vendor/", "coverage/", "backups/", "uploads/"] },
  js.configs.recommended,
  security.configs.recommended,
  {
    files: ["server/**/*.js", "scripts/**/*.js", "tests/**/*.js", ".zap/**/*.js", "eslint.config.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "commonjs", globals: { ...globals.node } }
  },
  {
    files: ["public/js/**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "script",
      globals: { ...globals.browser, CMS: "writable", Api: "writable", Store: "writable", App: "writable", Session: "writable", Icons: "writable" }
    }
  },
  { files: ["public/js/coffee-scene.js"], languageOptions: { sourceType: "module" } },
  {
    // Scripts are run by the operator on their own files, and tests read their own fixtures and build
    // patterns from known values, so these two warnings do not apply there.
    files: ["scripts/**/*.js", "tests/**/*.js", ".zap/**/*.js"],
    rules: { "security/detect-non-literal-fs-filename": "off", "security/detect-non-literal-regexp": "off" }
  },
  {
    rules: {
      // Flags every obj[key]. All 31 server and script uses were reviewed: each key is a fixed name, a
      // numeric index, or checked with Object.hasOwn first; request input never reaches one, because
      // strict schemas refuse unknown keys (tested with __proto__). The two that took stored text as a
      // key now use a Map or a null-prototype object. Semgrep in CI covers real prototype pollution.
      "security/detect-object-injection": "off",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
      eqeqeq: ["error", "always"],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-script-url": "error",
      strict: "off"
    }
  }
];
