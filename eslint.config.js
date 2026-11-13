import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      ".claude/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/target/**",
      "src-tauri/gen/**",
      "src-tauri/binaries/**",
      "src-tauri/resources/**",
      "drizzle/migrations/**",
      "spike/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
