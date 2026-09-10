import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

/**
 * Проверка кода. Один конфиг на сервер и на фронт: проект один, и правила
 * расходиться не должны.
 *
 * Правила выбраны так, чтобы ловить ошибки, а не спорить о вкусах. Всё, что
 * касается расстановки пробелов и переносов, выключено последним блоком —
 * этим занимается prettier, и две системы на одну задачу только мешают.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'web/public/**',
      'server/lms.db*',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ---------------------------------------------------------------- общее
  {
    rules: {
      // Пустой catch — спрятанная поломка. Если нечего делать, объясни почему:
      // комментарий внутри блока правило принимает.
      'no-empty': ['error', { allowEmptyCatch: false }],
      // Забытый await у промиса — самая дорогая ошибка в асинхронном коде.
      'require-await': 'off',
      'no-return-await': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // `any` в проекте допустим только на границе: строки из SQLite и параметры
      // маршрутов приходят нетипизированными. Поэтому предупреждение, не ошибка —
      // чтобы новое появление было видно, но сборка из-за границы не падала.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },

  // ---------------------------------------------------------------- сервер
  {
    files: ['server/**/*.ts'],
    languageOptions: { globals: globals.node },
  },

  // ------------------------------------------------------------------ фронт
  {
    files: ['web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // Пропущенная зависимость в useEffect — источник «не обновляется, пока
      // не перезайдёшь». Ловится только этим правилом.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // ------------------------------------------------- проверочные скрипты
  {
    // Все расширения, а не только .ts: рядом лежит запускалка наборов на .mjs.
    files: ['server/scripts/**', 'audit-ui.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      // Ответы сервера в проверках разбираются как есть: описывать типы всех
      // ответов ради тестов — работа без отдачи.
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },

  prettier,
);
