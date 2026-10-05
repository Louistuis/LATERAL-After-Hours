import { describe, expect, it } from 'vitest';
import { javascriptChunkReferences } from '../../tools/release/chunk-graph.mjs';

describe('release bundle import graph scanner', () => {
  it('finds side-effect, named static and dynamic relative imports, including minified forms', () => {
    const source = `import"./side-effect.js";import{value}from"./named.js";import("./dynamic.js?x=1");await import(\`./template-dynamic.js\`);`;
    expect(javascriptChunkReferences(source)).toEqual(['./side-effect.js', './named.js', './dynamic.js', './template-dynamic.js']);
  });

  it('ignores bare package and external URL imports', () => {
    const source = `import"three";import("https://example.invalid/app.js");import x from "../local.js";`;
    expect(javascriptChunkReferences(source)).toEqual(['../local.js']);
  });
});
