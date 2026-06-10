import Link from "next/link";

export function PagerLink({
  page,
  disabled,
  baseQuery,
  label,
  basePath = "/signs",
}: {
  page: number;
  disabled: boolean;
  baseQuery: string;
  label: string;
  basePath?: string;
}) {
  if (disabled) {
    return <span className="text-zinc-700">{label}</span>;
  }
  const params = new URLSearchParams(baseQuery);
  params.set("page", String(page));
  return (
    <Link
      href={`${basePath}?${params.toString()}`}
      className="rounded border border-zinc-700 px-3 py-1 hover:bg-zinc-800"
    >
      {label}
    </Link>
  );
}
