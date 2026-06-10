import { cache } from "react";

import { auth } from "@/lib/auth";

// Request-scoped session accessor. React cache() memoizes per server request, so
// when the authenticated layout AND the page it wraps both need the session, the
// JWT is decoded once instead of twice (and the periodic jwt-callback DB refresh
// can't fire twice in one render). Use this in Server Components instead of
// calling auth() directly. (Server Actions use lib/rbac, a separate request.)
export const getSession = cache(() => auth());
