/** The header band at the height of page.tsx's header, a progress bar under it. */
export default function ReplayLoading() {
  return (
    <>
      <section className="bg-band" aria-hidden>
        <div className="wrap py-7">
          <h1>&nbsp;</h1>
          <p className="mt-3 text-lg">&nbsp;</p>
          <p className="mt-2">&nbsp;</p>
        </div>
      </section>
      <div className="progress" role="progressbar" aria-label="Loading replay" />
    </>
  );
}
