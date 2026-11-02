// The one criterion for code migrated to the refactor's rules (docs/proposals/web-wallet-refactor-preamble.md):
// ESLint rules plus the repo's Prettier format, reported by one `eslint` run. Each package passes the paths it has
// migrated; a slice grows those lists and never weakens the rules.
import js from "@eslint/js"
import prettier from "eslint-plugin-prettier"
import reactHooks from "eslint-plugin-react-hooks"
import tseslint from "typescript-eslint"

const SWALLOW = "CallExpression[callee.property.name='catch'] > ArrowFunctionExpression"
const swallow = (shape) => ({ selector: `${SWALLOW}${shape}`, message: "Do not swallow errors." })
const NO_SWALLOW = [
  swallow("[body.type='BlockStatement'][body.body.length=0]"),
  swallow("[body.type='Literal']"),
  swallow("[body.type='Identifier'][body.name='undefined']"),
]
const NO_THROW = {
  selector: "ThrowStatement > NewExpression[callee.name='Error']",
  message: 'Throw WalletError(code) instead of new Error("…")',
}
const NO_MODULE_MOCKS = {
  selector: "CallExpression[callee.object.name='vi'][callee.property.name='mock']",
  message: "Inject an in-memory fake of the public interface instead of mocking modules.",
}
// A negated matcher asserts absence, as a privacy check does, so it pins no wording.
const MATCHER =
  "CallExpression[callee.property.name=/^(toBe|toEqual|toStrictEqual|toContain|toContainEqual|toMatch|toMatchObject|toThrow|toThrowError|toHaveProperty|toHaveTextContent)$/]" +
  ":not([callee.object.property.name='not'])"
const copy = (target) => ({
  selector: `${MATCHER} > ${target}, ${MATCHER} > :matches(ObjectExpression, ArrayExpression) ${target}`,
  message: "Assert copy through the constant or error that owns it, not a literal.",
})
// ponytail: prose is a literal with a space; a one-word message slips through.
const NO_COPY = [
  copy("Literal[value=/\\s/]"),
  copy("Literal[regex.pattern=/ /]"),
  copy("TemplateLiteral:has(TemplateElement[value.raw=/\\s/])"),
]
const COPY_ATTR = "JSXAttribute[name.name=/^(title|label|placeholder|aria-label|alt)$/]"
const jsxCopy = (selector) => ({ selector, message: "Render copy from the component's Foo.copy.ts." })
const NO_JSX_COPY = [
  jsxCopy("JSXText[value=/[A-Za-z]/]"),
  jsxCopy(`${COPY_ATTR} > Literal[value=/[A-Za-z]/]`),
  jsxCopy(`${COPY_ATTR} > JSXExpressionContainer > Literal[value=/[A-Za-z]/]`),
  jsxCopy(`${COPY_ATTR} > JSXExpressionContainer > TemplateLiteral:has(TemplateElement[value.raw=/[A-Za-z]/])`),
]

/**
 * @param {object} migrated
 * @param {string} migrated.tsconfigRootDir the package directory (`import.meta.dirname`)
 * @param {string[]} [migrated.engine] framework-free code: no React, no event emitters, no floating promises
 * @param {string[]} [migrated.react] hooks and components
 * @param {string[]} [migrated.views] components in folders: also no copy literals in JSX
 * @param {string[]} [migrated.tests] tests: no module mocks
 * @param {boolean} [migrated.copyFreeTests] tests also never assert copy
 */
export function migrated({ tsconfigRootDir, engine = [], react = [], views = [], tests = [], copyFreeTests = false }) {
  const all = [...engine, ...react, ...views, ...tests]
  return tseslint.config(
    { ignores: ["dist/**"] },
    {
      files: all,
      extends: [js.configs.recommended, ...tseslint.configs.recommended],
      plugins: { prettier },
      rules: {
        "prettier/prettier": "error",
        "no-empty": ["error", { allowEmptyCatch: false }],
        "no-restricted-syntax": ["error", ...NO_SWALLOW],
      },
    },
    engine.length > 0 && {
      files: engine,
      languageOptions: { parserOptions: { projectService: true, tsconfigRootDir } },
      rules: {
        "@typescript-eslint/no-floating-promises": "error",
        "no-restricted-syntax": ["error", ...NO_SWALLOW, NO_THROW],
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              { group: ["react", "react-dom", "react/*"], message: "The engine runs without React." },
              { group: ["eventemitter3", "**/GlobalEventEmitter"], message: "State changes go through stores." },
            ],
          },
        ],
      },
    },
    react.length + views.length > 0 && {
      files: [...react, ...views],
      plugins: { "react-hooks": reactHooks },
      rules: {
        ...reactHooks.configs.recommended.rules,
        "no-restricted-syntax": ["error", ...NO_SWALLOW, NO_THROW],
      },
    },
    views.length > 0 && {
      files: views,
      rules: { "no-restricted-syntax": ["error", ...NO_SWALLOW, NO_THROW, ...NO_JSX_COPY] },
    },
    tests.length > 0 && {
      files: tests,
      rules: {
        "no-restricted-syntax": ["error", ...NO_SWALLOW, NO_MODULE_MOCKS, ...(copyFreeTests ? NO_COPY : [])],
      },
    },
  ).filter(Boolean)
}
