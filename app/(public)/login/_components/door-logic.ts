// Pure, DOM-free helpers for the login "door" (LoginDoor). Split out so they can
// be unit-tested without a browser or DB (Vitest): the server wrapper imports
// `resolveInitialPhase` to decide landing-vs-sign-in on first paint; the client
// typer imports `charsShown` to drive the boot type-on. No React, no window.

export type DoorPhase = "landing" | "booting" | "signin";

export type InitialPhaseInput = {
  callbackUrl?: string;
  type?: string;
  error?: string;
};

// Where the door opens on first paint. The placard (the full landing experience)
// only shows for a bare `/login` with no query — i.e. the apex-host rewrite. Any
// deep-link bounce (the proxy appends `?callbackUrl=`), a just-sent magic link
// (`?type=email`), or an auth error (`?error=`) skips straight to the sign-in
// panel so the user lands on the relevant state instead of a placard they'd have
// to click through.
export function resolveInitialPhase(
  input: InitialPhaseInput,
): Exclude<DoorPhase, "booting"> {
  if (input.error || input.type === "email" || input.callbackUrl) {
    return "signin";
  }
  return "landing";
}

// Characters of the boot text to reveal at `elapsed` ms into a `dur`-ms type-on
// of a `len`-char string. Linear, clamped to [0, len]. Pulled out of the rAF
// loop so the typer progression is testable independent of requestAnimationFrame.
export function charsShown(elapsed: number, dur: number, len: number): number {
  if (dur <= 0) return len;
  const t = Math.min(1, Math.max(0, elapsed) / dur);
  return Math.floor(t * len);
}

// The terminal "boot" lines, typed on placard click before the door opens. Pure
// data (no markup) so the client typer and any test can share one source.
export const BOOT_LINES: readonly string[] = [
  "[ ok ] palette ............ DC34 / agency",
  "[ ok ] signage management system · v4.2.1",
  "> authenticating goon ...........",
  "> verifying credential chain ....",
  "> linking field console .........",
  "[ ok ] uplink established",
  "> opening door  >",
];
