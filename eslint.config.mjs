import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import security from "eslint-plugin-security";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "check.js",
    "local-scripts/**",
    "tests/**",
  ]),
  {
    rules: {
      // Strict: no explicit any, no unescaped entities, no setState in effect.
      // Fix violations by refactoring — never by suppression.
      "@typescript-eslint/no-explicit-any": "error",
      "react/no-unescaped-entities": "error",
      "react-hooks/set-state-in-effect": "error",
    },
  },
  {
    // test/simulator is a standalone Node.js CJS test script, not part of the TS/ESM app.
    // It uses build-in requires (crypto, http, fs). Relax the ESM-only require ban there.
    files: ["test/simulator/**"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  security.configs.recommended,
]);

export default eslintConfig;
