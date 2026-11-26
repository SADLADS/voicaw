import { describe, it, expect } from 'vitest';
import { isPdf } from './pdf';
import { typeFromName } from './fileTypeFromName';

describe('isPdf', () => {
  it('knows a PDF by its type or its name', () => {
    expect(isPdf('application/pdf', 'x.bin')).toBe(true);
    expect(isPdf('', 'Report.PDF')).toBe(true);
    expect(isPdf('application/octet-stream', 'notes.pdf')).toBe(true);
    expect(isPdf('application/octet-stream', 'notes.pdf.zip')).toBe(false);
    expect(isPdf('text/plain', 'pdf')).toBe(false);
    expect(isPdf(undefined, undefined)).toBe(false);
  });

  it('types files the system gave no type by their names', () => {
    expect(typeFromName('a.pdf')).toBe('application/pdf');
    expect(typeFromName('a.epub')).toBe('application/epub+zip');
    expect(typeFromName('a.docx')).toBe('application/octet-stream');
  });
});
