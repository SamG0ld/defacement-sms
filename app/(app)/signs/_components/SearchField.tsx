"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { buildSearchHref } from "../_lib";

// Live search box for the signs list. Server-side filtering is preserved (the
// term still hits Prisma over the FULL paginated dataset — see buildSignWhere),
// but instead of an "Apply filters" round-trip the box debounces and does a soft
// router.replace as you type. Soft navigation keeps this client island mounted,
// so the input retains focus + cursor while the server-rendered list updates.
//
// `otherParams` is the other active filters as a query string WITHOUT q/page, so
// a search preserves status/zone/tag/etc. and resets to page 1.
export function SearchField({
  defaultValue,
  otherParams,
  className,
}: {
  defaultValue: string;
  otherParams: string;
  // When provided, replaces the default styling — pass "" to let a parent
  // `.searchbox` style the input. Defaults to the standalone field styling.
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  // Local `value` is the source of truth while typing — it runs ahead of the prop
  // between a keystroke and the debounced round-trip, so blindly syncing from
  // `defaultValue` would fight the cursor. But it must NOT be seeded once and left
  // alone either: the "Clear" <Link> on the filter panel is a Next <Link>, i.e. a
  // SOFT nav, so it drops `q` from the URL without remounting this island. The box
  // would keep showing the cleared term and the next keystroke would debounce
  // straight back to a URL containing it, silently undoing the Clear.
  const [value, setValue] = useState(defaultValue);

  // The term the URL currently carries because WE put it there, stored the way
  // the server hands it back (trimmed — buildSearchHref trims, and the page
  // re-trims `q` off searchParams). Anything arriving in `defaultValue` that
  // doesn't match this was set by something other than us (Clear, Back, a link).
  const pushed = useRef(defaultValue);

  useEffect(() => {
    if (defaultValue === pushed.current) return;
    pushed.current = defaultValue;
    setValue(defaultValue);
  }, [defaultValue]);

  // Skip the navigation on initial mount — only react to the user typing.
  const mounted = useRef(false);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    // The URL already says this — an external resync (above), not a keystroke.
    // Navigating again would just replace the current entry with itself.
    if (value === pushed.current) return;
    const timer = setTimeout(() => {
      pushed.current = value.trim();
      router.replace(buildSearchHref(pathname, otherParams, value), {
        scroll: false,
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [value, otherParams, pathname, router]);

  return (
    <input
      type="text"
      name="q"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      placeholder="search text · id · area"
      aria-label="Search signs by text, item ID, or area"
      className={
        className ??
        "rounded border border-zinc-700 bg-black px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600"
      }
    />
  );
}
