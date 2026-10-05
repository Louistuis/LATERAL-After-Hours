/** Return local JavaScript chunks referenced through static, side-effect or dynamic imports. */
export function javascriptChunkReferences(source) {
  return [...source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)(["'`])([^"'`]+\.js(?:\?[^"'`]*)?)\1/g)]
    .map(match => match[2].split('?')[0])
    .filter(specifier => specifier.startsWith('.'));
}
