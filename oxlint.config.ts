import { defineConfig } from "oxlint"

export default defineConfig({
  categories: {
    correctness: "error",
    suspicious: "error",
    perf: "warn",
  },
  rules: {
    "eslint/no-await-in-loop": "off",
    "eslint/no-underscore-dangle": "off",
    "eslint/no-unused-vars": "error",
    "oxc/no-map-spread": "off",
    "unicorn/consistent-function-scoping": "off",
    "unicorn/no-array-sort": "off",
  },
})
