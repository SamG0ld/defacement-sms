import { redirect } from "next/navigation";

import { auth, signIn } from "@/lib/auth";

type LoginPageProps = {
  searchParams: Promise<{ callbackUrl?: string; error?: string; type?: string }>;
};

// NextAuth surfaces failures as ?error=<code>. Map the ones a user can actually
// hit to plain copy; everything else falls back to a generic line. Closed-reg
// rejection is deliberately silent (no email arrives) — there's no error code
// for it, by design.
function errorMessage(code: string): string {
  switch (code) {
    case "AccessDenied":
      return "Your account is not authorized. Ask an admin for an invite.";
    case "EmailSignin":
      return "Couldn't send the sign-in link. Please try again.";
    case "Verification":
      return "That sign-in link is invalid or has expired. Request a new one.";
    default:
      return "Sign in failed. Please try again.";
  }
}

// Same-site guard for ?callbackUrl=. Allows only relative paths; rejects
// absolute URLs, protocol-relative ("//evil") and backslash ("/\\evil") forms
// that next/navigation's redirect() would otherwise follow off-site.
function safeRelativePath(url?: string): string {
  if (
    url &&
    url.startsWith("/") &&
    !url.startsWith("//") &&
    !url.startsWith("/\\")
  ) {
    return url;
  }
  return "/";
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const session = await auth();
  const { callbackUrl, error, type } = await searchParams;
  const dest = safeRelativePath(callbackUrl);
  // After the email form submits, NextAuth's verifyRequest redirect lands here
  // with ?type=email appended (see pages.verifyRequest in lib/auth.ts) — that's
  // the "magic link sent" signal for the confirmation screen.
  const sent = type === "email";

  if (session?.user?.isActive) {
    redirect(dest);
  }

  return (
    <div className="relative flex min-h-full flex-1 items-center justify-center overflow-hidden bg-zinc-950 p-4">
      <div aria-hidden className="dot-grid pointer-events-none absolute inset-0" />
      <div className="relative z-10 w-full max-w-sm space-y-6 rounded-2xl border border-zinc-800 bg-gradient-to-b from-zinc-900 to-zinc-950 p-8 text-zinc-100 shadow-2xl shadow-black/50">
        <div className="space-y-1 text-center">
          <h1 className="text-xl font-semibold">Defacement SMS</h1>
          <p className="text-xs text-zinc-400">Sign in to continue</p>
        </div>

        {error && (
          <div className="rounded border border-red-900 bg-red-950 px-3 py-2 text-xs text-red-200">
            {errorMessage(error)}
          </div>
        )}

        {sent ? (
          <div className="space-y-4">
            <div className="rounded border border-emerald-900 bg-emerald-950 px-3 py-3 text-sm text-emerald-200">
              <p className="font-medium">Check your inbox.</p>
              <p className="mt-1 text-xs text-emerald-300/80">
                If that email is on the team, a one-time sign-in link is on its
                way. It expires shortly. Don&apos;t see it? Check spam, or try
                again.
              </p>
            </div>
            <a
              href={`/login${callbackUrl ? `?callbackUrl=${encodeURIComponent(dest)}` : ""}`}
              className="block text-center text-xs text-zinc-400 underline-offset-2 hover:underline"
            >
              Use a different sign-in method
            </a>
          </div>
        ) : (
          <div className="space-y-4">
            <form
              action={async () => {
                "use server";
                await signIn("google", { redirectTo: dest });
              }}
            >
              <button
                type="submit"
                className="btn-primary w-full rounded px-4 py-2 text-sm font-medium"
              >
                Continue with Google
              </button>
            </form>

            <div className="flex items-center gap-3 text-[11px] uppercase tracking-wide text-zinc-600">
              <span className="h-px flex-1 bg-zinc-800" />
              or
              <span className="h-px flex-1 bg-zinc-800" />
            </div>

            <form
              action={async (formData: FormData) => {
                "use server";
                const email = String(formData.get("email") ?? "").trim();
                await signIn("resend", { email, redirectTo: dest });
              }}
              className="space-y-2"
            >
              <input
                type="email"
                name="email"
                required
                autoComplete="email"
                placeholder="you@example.com"
                className="w-full rounded border border-zinc-700 bg-black px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600"
              />
              <button
                type="submit"
                className="w-full rounded border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-800"
              >
                Email me a sign-in link
              </button>
              <p className="text-center text-[11px] text-zinc-500">
                Works with any email — no password needed.
              </p>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
