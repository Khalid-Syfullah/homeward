import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "public/**",
    "art/**",
    "tools/**",
    "logs/**",
    // Playwright's output (npm test).
    "playwright-report/**",
    "test-results/**",
  ]),
]);

export default eslintConfig;
