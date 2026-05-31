// ESLint v9 "flat config". One file, applied to every TS/TSX in the repo.
// Kept opinionated but pragmatic: surface real bugs, don't litter warnings.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.vite/**",
      "**/coverage/**",
      "keys/**",
      "infra/**",
    ],
  },

  // ── Base recommended ──────────────────────────────────────────
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ── Project-wide TypeScript rules ─────────────────────────────
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      // High-signal style/quality rules
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        { fixStyle: "inline-type-imports", disallowTypeAnnotations: false },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-misused-promises": "off", // requires type info; off for speed
      "no-console": ["warn", { allow: ["error", "warn"] }],
      "prefer-const": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-restricted-syntax": [
        "error",
        {
          // Custom GUC reads must use NULLIF — see migrations/0005_rls.sql.
          // Catching string literals that drop NULLIF would be too noisy with
          // false positives, so this is a placeholder for future rules.
          selector: "Literal[value='__forbidden_marker__']",
          message: "reserved",
        },
      ],
    },
  },

  // ── React (web package only) ──────────────────────────────────
  {
    files: ["packages/web/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { react, "react-hooks": reactHooks },
    settings: { react: { version: "detect" } },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // React 17+ JSX transform — `import React` not required.
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off", // TS provides this
      "react/jsx-no-target-blank": "warn",
      "react-hooks/exhaustive-deps": "warn",
    },
  },

  // ── Tests can be slightly looser ──────────────────────────────
  {
    files: ["**/tests/**/*.ts", "**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "no-console": "off",
    },
  },

  // ── CLI scripts may console.log freely ───────────────────────
  {
    files: ["scripts/**/*.ts", "packages/shared/src/env.ts"],
    rules: {
      "no-console": "off",
    },
  },

  // ── Prettier must be LAST so it disables conflicting rules ────
  prettier,
);
