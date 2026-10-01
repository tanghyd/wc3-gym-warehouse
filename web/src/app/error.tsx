"use client";
import { useRouter } from "next/navigation";
import { startTransition } from "react";

/** A failed read of the API: the warehouse is down or still loading. */
export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  const retry = () =>
    startTransition(() => {
      router.refresh();
      reset();
    });
  return (
    <main className="wrap flex flex-col items-center gap-6 py-16 text-center">
      <h1>Warehouse offline</h1>
      <button type="button" className="btn btn-gold" onClick={retry}>
        Retry
      </button>
    </main>
  );
}
