/** Control fixture for `bundler-portability.test.ts` — the SHAPE this package must
 *  never ship: a bare, statically-analysable `next/headers` specifier. A bundler
 *  resolves it at BUILD time, so the try/catch around it is worthless; the test
 *  asserts this file fails to bundle, which is what proves the detector works. */
export async function readNextCookies(): Promise<unknown> {
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — deliberately unresolvable: next is not a dependency here
    return await import("next/headers");
  } catch {
    return null;
  }
}
