// Transactional email via Resend's REST API (no SDK — a single fetch keeps the
// dependency surface flat and runs anywhere NextAuth does). Hosts the
// magic-link sign-in mail and the welcome mail sent when an admin adds a user.

// Closed-registration gate for magic links: a sign-in link is only ever sent to
// an email that already maps to an active User row. Pure + synchronous so it can
// be unit-tested without NextAuth, Prisma, or the network.
export function canReceiveMagicLink(
  user: { isActive: boolean } | null | undefined,
): boolean {
  return !!user && user.isActive;
}

// HTML-escape before inlining into an attribute / body. The values we inline
// (NextAuth sign-in URL, app login URL) aren't user-controlled today, but
// escaping keeps it safe if that ever changes. Exported for unit testing — it's
// the one security-relevant pure function in this module.
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";

// Shared send. Throws on missing config or a non-2xx so callers (NextAuth, the
// addUser welcome path) can surface or swallow the failure as appropriate.
async function sendViaResend(message: {
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<void> {
  const apiKey = process.env.AUTH_RESEND_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) {
    throw new Error(
      "Email is not configured (AUTH_RESEND_KEY / EMAIL_FROM).",
    );
  }

  const res = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, ...message }),
  });

  if (!res.ok) {
    // Truncate the upstream body before it lands in server logs. Nothing here
    // reaches the client — NextAuth maps a thrown error to a generic code, and
    // the welcome path swallows it.
    const detail = (await res.text().catch(() => "")).slice(0, 500);
    throw new Error(`Resend send failed (${res.status}): ${detail}`);
  }
}

function magicLinkText(url: string): string {
  return [
    "Sign in to Defacement SMS",
    "",
    "Click the link below to sign in. It expires in 15 minutes and can only be used once.",
    "",
    url,
    "",
    "If you didn't request this, you can ignore this email.",
  ].join("\n");
}

function magicLinkHtml(url: string): string {
  const safe = escapeHtml(url);
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#18181b">
<h2 style="margin:0 0 12px">Sign in to Defacement SMS</h2>
<p>Click the button below to sign in. The link expires in 15 minutes and can only be used once.</p>
<p style="margin:24px 0">
  <a href="${safe}" style="background:#1d4ed8;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">Sign in</a>
</p>
<p style="font-size:12px;color:#71717a">If the button doesn't work, paste this link into your browser:<br>${safe}</p>
<p style="font-size:12px;color:#71717a">If you didn't request this, you can ignore this email.</p>
</body></html>`;
}

// Magic-link sign-in mail. The closed-reg gate (canReceiveMagicLink) is checked
// by the caller (lib/auth.ts) BEFORE this is invoked.
export async function sendMagicLinkEmail(
  to: string,
  url: string,
): Promise<void> {
  await sendViaResend({
    to,
    subject: "Your Defacement SMS sign-in link",
    text: magicLinkText(url),
    html: magicLinkHtml(url),
  });
}

function welcomeText(loginUrl: string): string {
  return [
    "You've been added to Defacement SMS",
    "",
    "An admin has given you access. Sign in here to get started:",
    "",
    loginUrl,
    "",
    "Sign in with Google, or request a one-time email link on that page.",
  ].join("\n");
}

function welcomeHtml(loginUrl: string): string {
  const safe = escapeHtml(loginUrl);
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#18181b">
<h2 style="margin:0 0 12px">You've been added to Defacement SMS</h2>
<p>An admin has given you access. Sign in to get started:</p>
<p style="margin:24px 0">
  <a href="${safe}" style="background:#1d4ed8;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">Sign in</a>
</p>
<p style="font-size:12px;color:#71717a">Sign in with Google, or request a one-time email link on that page. If the button doesn't work, paste this in your browser:<br>${safe}</p>
</body></html>`;
}

// Welcome mail sent (best-effort) when an admin adds a user. Carries a plain
// login link (not a one-time token) so it never expires — the login page offers
// both Google and magic-link sign-in.
export async function sendWelcomeEmail(
  to: string,
  loginUrl: string,
): Promise<void> {
  await sendViaResend({
    to,
    subject: "You've been added to Defacement SMS",
    text: welcomeText(loginUrl),
    html: welcomeHtml(loginUrl),
  });
}
