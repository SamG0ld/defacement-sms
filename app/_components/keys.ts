// Keyboard predicates shared by the non-native interactive elements in the app.
//
// A `role="button"` on a non-button element is a promise to assistive tech that
// the thing behaves like a button — which means Enter AND Space activate it, not
// just a pointer click (#180). The predicate lives here, pure and tested, so that
// contract is asserted somewhere rather than only living in a JSX handler.

// WAI-ARIA button activation keys. `" "` is Space; callers must `preventDefault`
// on it or the page scrolls underneath the activation.
export function isActivationKey(key: string): boolean {
  return key === "Enter" || key === " ";
}
