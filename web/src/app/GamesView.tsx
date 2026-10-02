"use client";
import { useRouter } from "next/navigation";
import { type ReactNode, useOptimistic, useTransition } from "react";
import { HIDEABLE, type Hideable } from "@/lib/ui";

/**
 * The games list under its Show switches. A switch hides its columns at once and writes the `hide`
 * key with router.replace, so a link reproduces the view; every column shows by default.
 */
export function GamesView({ hidden, children }: { hidden: Hideable[]; children: ReactNode }) {
  const router = useRouter();
  const [now, setNow] = useOptimistic(hidden);
  const [, start] = useTransition();
  const toggle = (k: Hideable) => {
    const next = HIDEABLE.map(([v]) => v).filter((v) => (v === k ? !now.includes(v) : now.includes(v)));
    start(() => {
      setNow(next);
      const q = new URLSearchParams(window.location.search);
      if (next.length) q.set("hide", next.join("."));
      else q.delete("hide");
      router.replace(`${window.location.pathname}${q.toString() ? `?${q}` : ""}`, { scroll: false });
    });
  };
  return (
    <>
      <div role="group" aria-label="Show columns" className="show-cols">
        <span aria-hidden className="text-muted">
          Show
        </span>
        {HIDEABLE.map(([k, label]) => (
          <label key={k} className="flex cursor-pointer items-center gap-1.5">
            <input type="checkbox" className="check" checked={!now.includes(k)} onChange={() => toggle(k)} />
            {label}
          </label>
        ))}
      </div>
      <div data-hide={now.join(" ")}>{children}</div>
    </>
  );
}
