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
    <main className="wrap py-12 text-center">
      <h2>Warehouse offline</h2>
      <button type="button" className="btn mt-4" onClick={retry}>
        Retry
      </button>
    </main>
  );
}
