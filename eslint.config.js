// stack-template: dotfiles/eslint-config@1 6bf377526f92
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Flat config. Type-aware linting is deliberately off: `tsc --noEmit` in CI already
 * covers what the typed rules would add, without the slow parser setup.
 *
 * The em dash / en dash ban is enforced by scripts/check-ascii.mjs rather than a lint
 * rule, because it also has to cover Markdown, YAML and shell scripts, which ESLint
 * never parses.
 */
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      ".claude/**",
      ".wrangler/**",
      "tasker/**",
      "logs/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      eqeqeq: ["error", "smart"],
      // `!!x` narrows in TypeScript where Boolean(x) does not; `1 * D` reads as "one day".
      "no-implicit-coercion": ["error", { allow: ["!!", "*"] }],
      // ignoreConstructors: a PascalCase `Name: function` is a constructor (new Option)
      // and a method shorthand cannot be one.
      "object-shorthand": ["error", "always", { ignoreConstructors: true }],
      "prefer-const": "error",
    },
  },
  // Tests poke at loosely typed fakes (D1 stubs, fetch mocks); `any` there is the
  // point, not a leak. src keeps the rule.
  {
    files: ["test/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  // Must stay last: turns off every rule that would fight Prettier.
  prettier,
);
