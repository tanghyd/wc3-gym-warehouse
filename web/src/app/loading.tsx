/** The search page title, a progress bar where the form goes. */
export default function Loading() {
  return (
    <main className="wrap py-6">
      <h1>Replays</h1>
      <div className="progress mt-4" role="progressbar" aria-label="Loading replays" />
    </main>
  );
}
