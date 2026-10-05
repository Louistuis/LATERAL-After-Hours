/** Resolves to null instead of hanging when the other side never answers. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(null); });
  });
}
