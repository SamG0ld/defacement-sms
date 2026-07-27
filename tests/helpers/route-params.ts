// Next 16 hands route handlers `params` as a promise that is NOT yet settled when
// the handler is entered. Building the mock with a bare `Promise.resolve(...)`
// hands it an already-settled promise instead, so the handler never actually
// crosses the async boundary the real framework forces it across — any behavior
// that depends on that suspension (ordering against other awaited work, code
// that inspects the promise before awaiting it) is untested.
//
// This resolves on a later macrotask so the shape matches production. It does NOT
// catch a plain missing `await` on its own: destructuring an unawaited promise
// yields `undefined` whether or not it is settled (#63).
export function routeParams<T extends object>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), 0));
}
