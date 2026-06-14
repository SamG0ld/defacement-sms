import Link from "next/link";

// Branded 404, matching the login/error aesthetic. Renders within the root
// layout. notFound() calls and unmatched routes land here.
export default function NotFound() {
  return (
    <div className="relative flex min-h-full flex-1 items-center justify-center overflow-hidden bg-zinc-950 p-4">
      <div aria-hidden className="dot-grid pointer-events-none absolute inset-0" />
      <div className="relative z-10 w-full max-w-sm space-y-5 rounded-2xl border border-zinc-800 bg-gradient-to-b from-zinc-900 to-zinc-950 p-8 text-center text-zinc-100 shadow-2xl shadow-black/50">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Page not found</h1>
          <p className="text-xs text-zinc-400">
            That page doesn&apos;t exist, or you don&apos;t have access to it.
          </p>
        </div>
        <Link
          href="/"
          className="btn-primary inline-block w-full rounded px-4 py-2 text-sm font-medium"
        >
          Go home
        </Link>
      </div>
    </div>
  );
}
