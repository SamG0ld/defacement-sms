"use client";

// The public "door": a single client state machine that runs
// landing → booting → signin entirely same-origin (no reload), so the placard,
// the terminal boot, and the sign-in panel feel like one continuous flow. Ported
// from the Claude Design prototype (Defacement.dc.html) onto the app's existing
// console primitives (.prompt / .btn / .field / .badge / .dot-grid) + role tokens;
// the bespoke door chrome (placard glow, scanline sweep, boot wipe, rise, cursor)
// lives in globals.css. Auth is unchanged — the Google button and magic-link form
// post to the real `signIn` server actions passed down from the server wrapper.

import { useCallback, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";

import { BOOT_LINES, charsShown, type DoorPhase } from "./door-logic";

type LoginDoorProps = {
  initialPhase: Exclude<DoorPhase, "booting">;
  sent: boolean;
  errorMessage: string | null;
  googleAction: () => Promise<void>;
  magicLinkAction: (formData: FormData) => Promise<void>;
  // The animated circuit emblem, rendered as a SERVER component by the page and
  // passed in so its 120-path trace data stays out of this client bundle.
  emblem: React.ReactNode;
};

const BOOT_TEXT = BOOT_LINES.join("\n");
const TYPE_MS = 1850; // type-on duration (rAF, smooth)
const WIPE_MS = 2300; // door starts its upward wipe (absolute timer)
const SIGNIN_MS = 2560; // sign-in fully revealed (absolute timer)

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function LoginDoor({
  initialPhase,
  sent,
  errorMessage,
  googleAction,
  magicLinkAction,
  emblem,
}: LoginDoorProps) {
  const [phase, setPhase] = useState<DoorPhase>(initialPhase);
  const [boot, setBoot] = useState("");
  const [wipe, setWipe] = useState(false);

  const rafRef = useRef<number | null>(null);
  const wipeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const signinTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Always clear the rAF loop + the two door timers on unmount (and if arm() is
  // ever re-entered) so a backgrounded boot can't fire setState after teardown.
  const clearTimers = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    if (wipeTimer.current) clearTimeout(wipeTimer.current);
    if (signinTimer.current) clearTimeout(signinTimer.current);
    rafRef.current = null;
    wipeTimer.current = null;
    signinTimer.current = null;
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  // Mirror the committed phase into a ref so arm()'s re-entrancy guard reads the
  // current value synchronously (not a stale closure) even on rapid taps.
  const phaseRef = useRef<DoorPhase>(initialPhase);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const arm = useCallback(() => {
    if (phaseRef.current !== "landing") return;
    phaseRef.current = "booting"; // block re-entry before the state commit
    // Reduced motion: skip the whole show and reveal the sign-in panel at once.
    if (prefersReducedMotion()) {
      setPhase("signin");
      return;
    }
    clearTimers();
    setPhase("booting");
    setBoot("");
    setWipe(false);

    // Type-on driven by rAF against the wall clock (re-renders only when the
    // visible character count changes).
    const start = performance.now();
    let shown = -1;
    const tick = () => {
      const elapsed = performance.now() - start;
      const n = charsShown(elapsed, TYPE_MS, BOOT_TEXT.length);
      if (n !== shown) {
        shown = n;
        setBoot(BOOT_TEXT.slice(0, n));
      }
      if (elapsed < TYPE_MS) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);

    // The door opening is on ABSOLUTE timers, decoupled from the rAF typer, so it
    // always opens even if the frame loop is throttled on a backgrounded/cheap
    // device.
    wipeTimer.current = setTimeout(() => {
      setBoot(BOOT_TEXT);
      setWipe(true);
    }, WIPE_MS);
    signinTimer.current = setTimeout(() => setPhase("signin"), SIGNIN_MS);
  }, [clearTimers]);

  const isLanding = phase === "landing";
  const isBooting = phase === "booting";
  // Sign-in mounts beneath the boot overlay during the wipe so the upward wipe
  // reveals it.
  const showSignin = phase === "signin" || (phase === "booting" && wipe);

  return (
    <div
      className="relative flex min-h-dvh w-full flex-col overflow-hidden"
      style={{ background: "var(--base)", color: "var(--foreground)" }}
    >
      {isLanding && <Landing onArm={arm} emblem={emblem} />}
      {showSignin && (
        <SignIn
          sent={sent}
          errorMessage={errorMessage}
          googleAction={googleAction}
          magicLinkAction={magicLinkAction}
          onBackToDoor={() => {
            // Return to the placard cleanly so the door can be re-armed. Reset
            // the boot timers + sub-state, and clear the re-entrancy guard
            // SYNCHRONOUSLY — the phaseRef effect only runs post-commit, too
            // late for an immediate back→placard double-tap, which would
            // otherwise leave arm() blocked and strand the user on landing.
            phaseRef.current = "landing";
            clearTimers();
            setBoot("");
            setWipe(false);
            setPhase("landing");
          }}
        />
      )}
      {isBooting && <BootOverlay text={boot} wiping={wipe} />}
    </div>
  );
}

// ── Landing (the placard) ────────────────────────────────────────────────────
function Landing({
  onArm,
  emblem,
}: {
  onArm: () => void;
  emblem: React.ReactNode;
}) {
  return (
    <div
      className="relative flex min-h-dvh w-full flex-col items-center justify-center overflow-hidden"
      style={{
        // viewport-fit=cover (layout.tsx) makes the insets non-zero on notched
        // phones — pad top + bottom so the kicker clears the status bar / notch
        // and the footer clears the home bar.
        paddingTop: "calc(56px + env(safe-area-inset-top))",
        paddingLeft: 26,
        paddingRight: 26,
        paddingBottom: "calc(40px + env(safe-area-inset-bottom))",
      }}
    >
      {/* faint dot-grid backdrop (matches the boot overlay + sign-in panel) */}
      <div aria-hidden className="dot-grid pointer-events-none absolute inset-0" />
      {/* top hairline */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px"
        style={{
          background:
            "linear-gradient(90deg, transparent, color-mix(in oklab, var(--accent) 35%, transparent), transparent)",
        }}
      />

      {/* The door stack. Each item rises in on its own .df-rise with a staggered
          inline animation-delay (kicker 0 / wordmark 60 / emblem 110 / threshold
          160 / CTA 200 / footer 240ms). translateY-only, so it stays visible if a
          frame drops and freezes cleanly under the reduced-motion guard. */}
      <div className="relative z-[1] flex w-full max-w-[460px] flex-col items-center gap-[22px] text-center">
        {/* 1 · kicker — the .prompt class adds the leading ">" */}
        <span className="df-rise prompt" style={{ animationDelay: "0ms" }}>
          RESTRICTED // SIGNAGE MANAGEMENT SYSTEM
          <span
            aria-hidden
            className="df-cursor inline-block"
            style={{ width: 7, height: 13, background: "var(--accent)" }}
          />
        </span>

        {/* 2 · wordmark */}
        <h1
          className="df-rise font-black uppercase"
          style={{
            animationDelay: "60ms",
            margin: 0,
            fontFamily: "var(--font-sans)",
            fontSize: "min(32px, 7.6vw)",
            lineHeight: 1,
            letterSpacing: "0.06em",
            whiteSpace: "nowrap",
            color: "var(--foreground)",
          }}
        >
          DEFACEMENT HQ
        </h1>

        {/* 3 · animated emblem (server-rendered, passed in). The outer .df-rise is
            the entrance; the inner .login-emblem owns the perpetual float — separate
            elements so the two transform animations never collide. */}
        <div className="df-rise" style={{ animationDelay: "110ms" }}>
          {emblem}
        </div>

        {/* 4 · threshold line */}
        <p
          className="df-rise font-black uppercase"
          style={{
            animationDelay: "160ms",
            margin: 0,
            fontFamily: "var(--font-sans)",
            fontSize: 24,
            lineHeight: 1.1,
            letterSpacing: "0.02em",
            color: "var(--foreground)",
          }}
        >
          <span style={{ color: "var(--danger)" }}>Goons Only</span> Beyond This
          Point
        </p>

        {/* 5 · primary CTA — arms the door (landing → boot → sign-in) */}
        <button
          type="button"
          onClick={onArm}
          className="door-cta df-rise"
          style={{ animationDelay: "200ms" }}
        >
          Tap to authenticate
          <span
            aria-hidden
            className="df-cursor inline-block"
            style={{ width: 11, height: 19, background: "var(--highlight)" }}
          />
        </button>

        {/* 6 · footer */}
        <div
          className="df-rise"
          style={{
            animationDelay: "240ms",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: "var(--zinc-600)",
          }}
        >
          Closed system · goon credentials only
        </div>
      </div>
    </div>
  );
}

// ── Sign-in panel ────────────────────────────────────────────────────────────
function SignIn({
  sent,
  errorMessage,
  googleAction,
  magicLinkAction,
  onBackToDoor,
}: {
  sent: boolean;
  errorMessage: string | null;
  googleAction: () => Promise<void>;
  magicLinkAction: (formData: FormData) => Promise<void>;
  onBackToDoor: () => void;
}) {
  return (
    <div
      className="absolute inset-0 z-[5] flex items-center justify-center"
      style={{ background: "var(--base)", padding: "24px 18px" }}
    >
      <div aria-hidden className="dot-grid pointer-events-none absolute inset-0" />

      <div
        className="df-rise relative z-[1] w-full overflow-hidden"
        style={{
          maxWidth: 384,
          background: "linear-gradient(180deg, var(--surface), var(--surface-2))",
          border: "1px solid var(--line)",
          borderRadius: 12,
          boxShadow: "0 24px 60px -24px rgba(0,0,0,.85)",
        }}
      >
        {/* top cyan hairline */}
        <div
          aria-hidden
          style={{
            height: 1,
            background:
              "linear-gradient(90deg, transparent, color-mix(in oklab, var(--accent) 40%, transparent), transparent)",
          }}
        />
        <div style={{ padding: 26 }}>
          {/* return to the placard — the door is a two-way pivot, not a one-shot
              gate; lets a signed-out visitor get back to the front "door" */}
          <button
            type="button"
            onClick={onBackToDoor}
            className="door-back"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              marginBottom: 18,
              padding: 0,
              background: "transparent",
              border: "none",
              cursor: "pointer",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "var(--zinc-500)",
            }}
          >
            <span aria-hidden style={{ fontSize: 13, lineHeight: 1 }}>
              &lsaquo;
            </span>
            Back to the door
          </button>

          {/* header */}
          <div
            className="flex items-center justify-between"
            style={{ gap: 10, marginBottom: 22 }}
          >
            <span className="prompt">SECURE SESSION</span>
            <span className="badge badge-ok">UPLINK LIVE</span>
          </div>

          <h1
            style={{
              margin: "0 0 7px",
              fontFamily: "var(--font-sans)",
              fontWeight: 800,
              fontSize: 24,
              lineHeight: 1.15,
              letterSpacing: "-0.01em",
              color: "var(--foreground)",
            }}
          >
            DEFACEMENT
            <br />
            Signage Management System
          </h1>
          <p
            style={{
              margin: "0 0 22px",
              fontFamily: "var(--font-reading)",
              fontSize: 13,
              lineHeight: 1.5,
              color: "var(--zinc-400)",
            }}
          >
            You must be added as a user by the admin. Reach out to your team
            lead for support.
          </p>

          {errorMessage && (
            <div
              role="alert"
              style={{
                marginBottom: 16,
                border:
                  "1px solid color-mix(in oklab, var(--danger) 45%, transparent)",
                background: "color-mix(in oklab, var(--danger) 12%, transparent)",
                color: "color-mix(in oklab, var(--danger) 75%, white)",
                borderRadius: 8,
                padding: "10px 12px",
                fontFamily: "var(--font-reading)",
                fontSize: 12.5,
                lineHeight: 1.45,
              }}
            >
              {errorMessage}
            </div>
          )}

          {/* Google */}
          <form action={googleAction}>
            <SubmitButton
              className="btn btn-primary btn-lg w-full justify-center"
              leading={<GoogleG />}
              idle="Continue with Google"
              pending="Connecting…"
            />
          </form>

          {/* divider */}
          <div
            className="flex items-center"
            style={{ gap: 12, margin: "18px 0" }}
          >
            <span
              className="h-px flex-1"
              style={{ background: "var(--line)" }}
            />
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 10.5,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: "var(--zinc-600)",
              }}
            >
              or magic link
            </span>
            <span
              className="h-px flex-1"
              style={{ background: "var(--line)" }}
            />
          </div>

          {sent ? (
            <div
              className="flex items-start"
              style={{
                gap: 11,
                border:
                  "1px solid color-mix(in oklab, var(--accent) 40%, transparent)",
                background: "color-mix(in oklab, var(--accent) 10%, transparent)",
                borderRadius: 8,
                padding: "13px 14px",
              }}
            >
              <CheckGlyph />
              <div>
                <div
                  style={{
                    fontFamily: "var(--font-sans)",
                    fontWeight: 700,
                    fontSize: 14,
                    color: "var(--foreground)",
                  }}
                >
                  Link dispatched
                </div>
                <div
                  style={{
                    fontFamily: "var(--font-reading)",
                    fontSize: 12.5,
                    lineHeight: 1.5,
                    color: "var(--zinc-400)",
                  }}
                >
                  If that email is on the team, a one-time sign-in link is on its
                  way. It expires in 15 minutes — check spam if you don&apos;t
                  see it.
                </div>
              </div>
            </div>
          ) : (
            <form
              action={magicLinkAction}
              className="flex flex-col"
              style={{ gap: 9 }}
            >
              <label htmlFor="crew-email" className="prompt">
                Email address
              </label>
              <input
                id="crew-email"
                type="email"
                name="email"
                required
                autoComplete="email"
                placeholder="you@example.com"
                className="field w-full"
                style={{
                  borderRadius: 8,
                  padding: "10px 12px",
                  fontFamily: "var(--font-reading)",
                  fontSize: 14,
                }}
              />
              <SubmitButton
                className="btn btn-lg w-full justify-center"
                idle="Send magic link"
                pending="Sending…"
              />
            </form>
          )}

          {/* footer */}
          <div
            className="flex items-center justify-between"
            style={{
              marginTop: 22,
              paddingTop: 15,
              gap: 10,
              borderTop: "1px solid var(--line)",
            }}
          >
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 10.5,
                letterSpacing: "0.06em",
                color: "var(--zinc-600)",
              }}
            >
              app.example.com
            </span>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 10.5,
                letterSpacing: "0.06em",
                color: "color-mix(in oklab, var(--accent) 65%, white)",
              }}
            >
              [ ok ] console linked
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Boot overlay ─────────────────────────────────────────────────────────────
function BootOverlay({ text, wiping }: { text: string; wiping: boolean }) {
  return (
    <div
      className="absolute inset-0 z-10 flex items-center justify-center"
      style={{
        background: "var(--base)",
        padding: 28,
        transform: wiping ? "translateY(-101%)" : "translateY(0)",
        transition: "transform .26s var(--ease-exit)",
      }}
    >
      <div aria-hidden className="dot-grid pointer-events-none absolute inset-0" />
      <div className="relative w-full" style={{ maxWidth: 560 }}>
        <div
          aria-hidden
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: "var(--zinc-600)",
            marginBottom: 14,
          }}
        >
          &gt; defacement // boot
        </div>
        <pre
          aria-hidden
          style={{
            margin: 0,
            fontFamily: "var(--font-mono)",
            fontSize: 13.5,
            lineHeight: 1.7,
            color: "var(--accent)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            textShadow:
              "0 0 12px color-mix(in oklab, var(--accent) 25%, transparent)",
          }}
        >
          {text}
          <span
            className="df-cursor inline-block"
            style={{
              width: 8,
              height: 15,
              background: "var(--accent)",
              verticalAlign: -2,
              marginLeft: 2,
            }}
          />
        </pre>
      </div>
    </div>
  );
}

// Submit button that reflects the form's pending state (useFormStatus) so a slow
// magic-link/OAuth round-trip on hostile RF shows progress instead of dead air.
function SubmitButton({
  className,
  idle,
  pending: pendingLabel,
  leading,
}: {
  className: string;
  idle: string;
  pending: string;
  leading?: React.ReactNode;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={`${className} disabled:cursor-not-allowed disabled:opacity-60`}
    >
      {!pending && leading}
      {pending ? pendingLabel : idle}
    </button>
  );
}

// Cyan check for the "Link dispatched" state. Inlined rather than added to the
// shared Icons set, whose keys double as the app-shell nav screen ids (IconName).
function CheckGlyph() {
  return (
    <svg
      aria-hidden
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flex: "none", marginTop: 1, color: "var(--accent)" }}
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

// 4-color Google "G" on a white chip (kept inline: the shared Icons set is a
// single-color stroke set; this glyph is intentionally multicolor brand art).
function GoogleG() {
  return (
    <span
      aria-hidden
      className="inline-flex"
      style={{ background: "#fff", borderRadius: 3, padding: 2 }}
    >
      <svg width="15" height="15" viewBox="0 0 48 48">
        <path
          fill="#FFC107"
          d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.6-.4-3.5z"
        />
        <path
          fill="#FF3D00"
          d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
        />
        <path
          fill="#4CAF50"
          d="M24 44c5.5 0 10.5-2.1 14.3-5.6l-6.6-5.6C29.6 34.6 26.9 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.6 5.1C9.6 39.6 16.2 44 24 44z"
        />
        <path
          fill="#1976D2"
          d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.3 5.7l6.6 5.6C39.9 36.7 44 31 44 24c0-1.3-.1-2.6-.4-3.5z"
        />
      </svg>
    </span>
  );
}
