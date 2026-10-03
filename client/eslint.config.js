import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import i18next from 'eslint-plugin-i18next'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // DeepFilterNet's generated wasm-bindgen glue (scripts/build-deepfilternet.sh).
  globalIgnores(['dist', 'src/voice/noise/deepfilter']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs['recommended-latest'],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
    },
  },
  // The app's text goes through t() (src/i18n), so it can be translated: no words written
  // straight into JSX or its user-facing attributes.
  {
    files: ['src/**/*.jsx'],
    ignores: ['src/**/*.test.jsx'],
    plugins: { i18next },
    rules: {
      'i18next/no-literal-string': ['error', {
        mode: 'jsx-only',
        'jsx-attributes': { include: ['title', 'placeholder', 'aria-label', 'alt', 'label', 'aria-description'] },
        'jsx-components': { exclude: ['Trans', 'code', 'kbd'] },
        // The plugin's defaults (punctuation, CONSTANTS, entities, emoji), plus identifiers
        // starting lower case ('category', 'dmy', 'btn-sm'): words people read have a space or
        // a capital.
        words: {
          exclude: [
            '[0-9!-/:-@[-`{-~]+', '[A-Z_-]+', /^[\p{Emoji}️‍]+$/u, /^&[a-z]+;$/,
            '[a-z][a-zA-Z0-9_.:/#-]*',
            // Symbols outside ASCII used as separators and buttons (·, ×, —, arrows).
            /^[\s·×•—–…→←↑↓▸▾✓✕]+$/u,
          ],
        },
      }],
    },
  },
  // Build config runs in Node.
  {
    files: ['vite.config.js', 'vitest.config.js'],
    languageOptions: { globals: globals.node },
  },
])
