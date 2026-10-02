"use client";
import { useRouter } from "next/navigation";
import { startTransition } from "react";

/** A failed read of the API: the warehouse is down, or has no marts yet (the API answers 503 until the first dbt build). */
export default function ErrorPage({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  const building = error.message.includes("503");
  const retry = () =>
    startTransition(() => {
      router.refresh();
      reset();
    });
  return (
    <main className="wrap flex flex-col items-center gap-6 py-16 text-center">
      <h1>{building ? "Warehouse still building" : "Warehouse offline"}</h1>
      <button type="button" className="btn btn-gold" onClick={retry}>
        Retry
      </button>
    </main>
  );
}
