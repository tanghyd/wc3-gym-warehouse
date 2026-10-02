import Link from "next/link";

/** A path no page answers. */
export default function NotFound() {
  return (
    <main className="wrap flex flex-col items-center gap-6 py-16 text-center">
      <h1>No such page</h1>
      <Link className="btn btn-gold" href="/">
        Replays
      </Link>
    </main>
  );
}
