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
  // Seed local state from the server prop ONCE. Local `value` is the source of
  // truth while mounted; we deliberately don't sync it back from `defaultValue`,
  // because the only soft-nav that changes `q` is this box's own typing (where
  // `value` is already ahead of the prop). Every OTHER way `q` or the filters
  // change is a hard nav that remounts this island and reseeds: the "Apply
  // filters" form submit (native GET) and the "Clear" <Link>. Pager <Link>s and
  // our search soft-nav leave `q`/`otherParams` untouched. If a future filter is
  // ever changed via a soft nav that DOES alter `q`/`otherParams` without a
  // remount, revisit this (add a keyed remount or a sync effect) — see Tech Debt.
  const [value, setValue] = useState(defaultValue);

  // Skip the navigation on initial mount — only react to the user typing.
  const mounted = useRef(false);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const timer = setTimeout(() => {
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
