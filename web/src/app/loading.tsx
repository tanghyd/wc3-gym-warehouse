/** Shown while a page's server reads run. */
export default function Loading() {
  return (
    <main className="wrap py-16 text-center text-muted" aria-busy="true">
      Loading…
    </main>
  );
}
