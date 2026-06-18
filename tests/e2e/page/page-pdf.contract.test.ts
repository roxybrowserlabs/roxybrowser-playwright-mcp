import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("page pdf contract e2e", () => {
  it("returns real PDF bytes and saves them to disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "roxy-page-pdf-"));
    const outputPath = join(directory, "output.pdf");

    try {
      await withPage(async (page) => {
        await page.setContent(`<!doctype html>
          <html lang="en">
            <body style="margin: 0; background: rgb(240, 240, 240);">
              <main style="padding: 32px;">
                <h1>PDF contract</h1>
                <p>This page should render into a real PDF.</p>
              </main>
            </body>
          </html>`);

        const pdf = await page.pdf({
          path: outputPath,
          printBackground: true
        });

        expect(pdf.byteLength).toBeGreaterThan(0);
        expect(pdf.subarray(0, 4).toString("utf8")).toBe("%PDF");
        expect(await readFile(outputPath)).toEqual(pdf);
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("can generate a larger tagged outline pdf for heading-heavy content", async () => {
    await withPage(async (page) => {
      await page.setContent(`<!doctype html>
        <html lang="en">
          <body>
            <h1>Heading one</h1>
            <p>Alpha paragraph.</p>
            <h2>Heading two</h2>
            <p>Beta paragraph.</p>
            <h3>Heading three</h3>
            <p>Gamma paragraph.</p>
          </body>
        </html>`);

      const plainPdf = await page.pdf();
      const outlinedPdf = await page.pdf({
        tagged: true,
        outline: true
      });

      expect(plainPdf.subarray(0, 4).toString("utf8")).toBe("%PDF");
      expect(outlinedPdf.subarray(0, 4).toString("utf8")).toBe("%PDF");
      expect(outlinedPdf.byteLength).toBeGreaterThan(plainPdf.byteLength);
    });
  });
});
