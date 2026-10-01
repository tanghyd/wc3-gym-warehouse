import Link from "next/link";

export default function ReplayNotFound() {
  return (
    <main className="wrap flex flex-col items-center gap-6 py-16 text-center">
      <h1>No game with this id</h1>
      <Link href="/" className="btn btn-gold">
        Search replays
      </Link>
    </main>
  );
}
