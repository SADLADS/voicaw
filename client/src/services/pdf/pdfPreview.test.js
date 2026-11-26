import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

// In Node, PDF.js runs its worker in this thread from the worker file itself.
const require = createRequire(import.meta.url);
const pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
vi.mock('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url', () => ({ default: path.join(pdfjsRoot, 'legacy/build/pdf.worker.min.mjs') }));

const { readPdfPreview } = await import('./pdfPreview');
const { openPdf, PdfPasswordError } = await import('./pdfjs');
const { makePdf, makeHostilePdf } = await import('./testPdfs');

const assets = `${pdfjsRoot}/`;
const fileOf = (bytes) => new Blob([bytes], { type: 'application/pdf' });
// Stands in for the canvas (there's none in Node): what it was asked to draw.
const draw = vi.fn(async (page, viewport) => ({ blob: new Blob(['jpeg']), width: Math.round(viewport.width), height: Math.round(viewport.height) }));

describe('readPdfPreview', () => {
  it("gives a PDF's number of pages and its first page, at most 280×400", async () => {
    const preview = await readPdfPreview(fileOf(makePdf({ pages: 5 })), { draw, assets });
    expect(preview).toMatchObject({ pages: 5, width: 280, height: 396 });
    expect(preview.thumbnail).toBeInstanceOf(Blob);
    expect(draw.mock.calls[0][0].pageNumber).toBe(1);
  });

  it('still counts the pages when the first one cannot be drawn', async () => {
    const preview = await readPdfPreview(fileOf(makePdf({ pages: 2 })), { draw: async () => { throw new Error('no canvas'); }, assets });
    expect(preview).toEqual({ pages: 2 });
  });

  it('says nothing about a locked, broken or fake PDF', async () => {
    const locked = fs.readFileSync(path.join(import.meta.dirname, 'fixtures/locked.pdf'));
    expect(await readPdfPreview(fileOf(locked), { draw, assets })).toBeNull();
    expect(await readPdfPreview(fileOf(new TextEncoder().encode('%PDF-1.7 not really')), { draw, assets })).toBeNull();
    expect(await readPdfPreview(fileOf(new TextEncoder().encode('<html>hello</html>')), { draw, assets })).toBeNull();
  });

  it('opens a hostile PDF like any other, without running anything in it', async () => {
    const alert = vi.fn();
    globalThis.app = { alert, launchURL: alert };
    try {
      const preview = await readPdfPreview(fileOf(makeHostilePdf()), { draw, assets });
      expect(preview).toMatchObject({ pages: 2 });
      expect(alert).not.toHaveBeenCalled();
    } finally {
      delete globalThis.app;
    }
  });
});

describe('openPdf', () => {
  it('asks for the password, says when it was wrong, and opens with the right one', async () => {
    const locked = fs.readFileSync(path.join(import.meta.dirname, 'fixtures/locked.pdf'));
    const asked = [];
    const answers = ['wrong', 'secret'];
    const doc = await openPdf(new Uint8Array(locked), {
      assets,
      onPassword: async (wrong) => {
        asked.push(wrong);
        return answers.shift();
      },
    });
    expect(asked).toEqual([false, true]);
    expect(doc.numPages).toBe(2);
    await doc.loadingTask.destroy();
  });

  it('gives up when no password is given', async () => {
    const locked = fs.readFileSync(path.join(import.meta.dirname, 'fixtures/locked.pdf'));
    await expect(openPdf(new Uint8Array(locked), { assets, onPassword: async () => null })).rejects.toBeInstanceOf(PdfPasswordError);
    await expect(openPdf(new Uint8Array(locked), { assets })).rejects.toBeInstanceOf(PdfPasswordError);
  });
});
