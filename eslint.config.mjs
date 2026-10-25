import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'contracts/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { console: 'readonly', process: 'readonly', window: 'readonly', document: 'readonly', localStorage: 'readonly', sessionStorage: 'readonly', fetch: 'readonly', crypto: 'readonly', navigator: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', Buffer: 'readonly', Event: 'readonly', FormData: 'readonly', HTMLDivElement: 'readonly', HTMLFormElement: 'readonly', Intl: 'readonly', confirm: 'readonly', prompt: 'readonly', structuredClone: 'readonly' } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
    },
  },
);
