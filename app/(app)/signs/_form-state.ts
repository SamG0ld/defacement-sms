// Action-state shape shared by the single-sign create/edit form (SignForm) and
// the createSign / updateSign Server Actions it drives. A plain type module (no
// prisma / server-only imports) so it can be imported from both the client form
// and the "use server" actions. `error` is set only on a failed submit; success
// ends in a redirect, so there is no success payload to carry back.
export type SignFormState = { error?: string };

export const EMPTY_SIGN_FORM_STATE: SignFormState = {};
