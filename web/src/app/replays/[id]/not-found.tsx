import Link from "next/link";

export default function ReplayNotFound() {
  return (
    <main className="wrap py-12 text-center">
      <h2>No game with this id</h2>
      <Link href="/" className="btn mt-4">
        Search replays
      </Link>
    </main>
  );
}
