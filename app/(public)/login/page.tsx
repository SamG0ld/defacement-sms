import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { startGoogleSignIn, startMagicLinkSignIn } from "@/lib/sign-in";

import { LoginDoor } from "./_components/LoginDoor";
import { LoginEmblem } from "./_components/LoginEmblem";
import { resolveInitialPhase } from "./_components/door-logic";

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
      return "Your account isn’t authorized. Make sure you’re using the exact email an admin added you with — or ask an admin for an invite.";
    case "EmailSignin":
      return "Couldn't send the sign-in link. Please try again.";
    case "Verification":
      return "That sign-in link is invalid or has expired. Request a new one.";
    case "Configuration":
      return "We hit a temporary problem signing you in. Please try again in a moment.";
    // Our own code (not NextAuth's): the per-IP auth limiter turned this attempt
    // away before it reached signIn — see lib/sign-in.ts.
    case "RateLimited":
      return "Too many sign-in attempts from this network. Wait a minute and try again.";
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

// Server wrapper for the public login "door". Stays a server component so the
// pre-auth check + redirect run server-side (no client flash of the sign-in
// screen for an already-authenticated user) and so the closed-registration
// `signIn` actions never ship to the client. The door's landing→boot→signin
// animation lives entirely in the LoginDoor client leaf.
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

  const initialPhase = resolveInitialPhase({ callbackUrl, type, error });

  // Bound server actions — same closed-registration auth as before, just passed
  // to the client door so its <form action> posts hit real NextAuth sign-in.
  // Both bodies live in lib/sign-in.ts so the per-IP rate limiting they now
  // apply (#173) is unit-testable; these wrappers only bind the destination.
  async function googleAction() {
    "use server";
    await startGoogleSignIn(dest);
  }
  async function magicLinkAction(formData: FormData) {
    "use server";
    await startMagicLinkSignIn(dest, String(formData.get("email") ?? ""));
  }

  return (
    <LoginDoor
      initialPhase={initialPhase}
      sent={sent}
      errorMessage={error ? errorMessage(error) : null}
      googleAction={googleAction}
      magicLinkAction={magicLinkAction}
      emblem={<LoginEmblem />}
    />
  );
}
