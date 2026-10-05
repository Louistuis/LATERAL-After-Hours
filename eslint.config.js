import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default tseslint.config(js.configs.recommended, ...tseslint.configs.recommended, {
  files: ['tests/**/*.mjs', 'tools/**/*.mjs'],
  // Browser automation files run in Node and include callbacks evaluated in the page.
  languageOptions: { globals: {
    process:'readonly',Buffer:'readonly',console:'readonly',setTimeout:'readonly',clearTimeout:'readonly',
    URL:'readonly',fetch:'readonly',HTMLCanvasElement:'readonly',window:'readonly',document:'readonly',navigator:'readonly',performance:'readonly',
    Event:'readonly',PointerEvent:'readonly',KeyboardEvent:'readonly',DOMException:'readonly',
    Storage:'readonly',localStorage:'readonly',requestAnimationFrame:'readonly',cancelAnimationFrame:'readonly',
  } },
}, {
  files: ['src/**/*.ts', 'tests/**/*.ts'],
  languageOptions: { globals: { window:'readonly',document:'readonly',navigator:'readonly', console:'readonly',performance:'readonly', requestAnimationFrame:'readonly',cancelAnimationFrame:'readonly',setTimeout:'readonly',clearTimeout:'readonly',fetch:'readonly',URL:'readonly',Blob:'readonly',AudioContext:'readonly',HTMLElement:'readonly',HTMLCanvasElement:'readonly',KeyboardEvent:'readonly',PointerEvent:'readonly',localStorage:'readonly', __BUILD__:'readonly', __OWNER_REVIEW__:'readonly', __SELFHOST__:'readonly', WebSocket:'readonly', AbortController:'readonly', Event:'readonly', MessageEvent:'readonly', CloseEvent:'readonly', Storage:'readonly', clearInterval:'readonly', setInterval:'readonly', HTMLInputElement:'readonly', HTMLButtonElement:'readonly', File:'readonly', navigator:'readonly' } },
  rules: { '@typescript-eslint/no-unused-vars':['error', {argsIgnorePattern:'^_',varsIgnorePattern:'^_'}], '@typescript-eslint/no-explicit-any':'error' }
});
