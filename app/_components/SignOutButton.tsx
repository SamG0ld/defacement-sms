"use client";

// The sign-out submit button. On click it tells the service worker to purge the
// shell cache (PURGE_CACHE) BEFORE the form's server action runs signOut() — so
// on a shared field device the next user can't pull the previous user's cached
// /deploy shell out of CacheStorage. postMessage is fire-and-forget; the button
// still submits the enclosing <form> normally, so sign-out is unaffected if the
// SW is absent or the message is dropped.
export function SignOutButton() {
  const purgeCache = () => {
    try {
      navigator.serviceWorker?.controller?.postMessage("PURGE_CACHE");
    } catch {
      /* no SW / not controlled — nothing to purge, sign-out proceeds */
    }
  };

  return (
    <button
      type="submit"
      onClick={purgeCache}
      className="rounded border border-zinc-700 px-2 py-0.5 hover:bg-zinc-800"
    >
      Sign out
    </button>
  );
}
