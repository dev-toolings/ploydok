//  @ts-check

import { tanstackConfig } from "@tanstack/eslint-config"

export default [
  {
    ignores: [
      "public/clones/**",
      "test-results/**",
      "playwright-report/**",
      "e2e/fixtures/repos/**",
      ".output/**",
      ".vite/**",
      "src/routeTree.gen.ts",
    ],
  },
  ...tanstackConfig,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "warn",
      "@typescript-eslint/no-unnecessary-condition": "warn",
      "no-restricted-properties": [
        "error",
        {
          object: "navigator",
          property: "clipboard",
          message:
            "Use copyToClipboard from src/lib/clipboard.ts: navigator.clipboard is undefined on plain HTTP origins.",
        },
      ],
    },
  },
  {
    files: ["src/lib/clipboard.ts"],
    rules: {
      "no-restricted-properties": "off",
    },
  },
];
