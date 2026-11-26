// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { readPosition, savePosition, readZoom, saveZoom } from './pdfPosition';

describe('pdfPosition', () => {
  beforeEach(() => localStorage.clear());

  it("keeps where each PDF was left, on this device", () => {
    expect(readPosition('abc.bin')).toBeNull();
    savePosition('abc.bin', { page: 7, fraction: 0.33333 });
    expect(localStorage.getItem('pdfPosition:abc.bin')).toBe('{"page":7,"fraction":0.333}');
    expect(readPosition('abc.bin')).toEqual({ page: 7, fraction: 0.333 });
    savePosition('abc.bin', { page: 2, fraction: 3 });
    expect(readPosition('abc.bin')).toEqual({ page: 2, fraction: 1 });
  });

  it('remembers nothing without a key, and ignores nonsense', () => {
    savePosition(null, { page: 3, fraction: 0 });
    savePosition('x.bin', { page: 0, fraction: 0 });
    expect(localStorage.length).toBe(0);
    localStorage.setItem('pdfPosition:y.bin', '{"page":"two"}');
    expect(readPosition('y.bin')).toBeNull();
    localStorage.setItem('pdfPosition:z.bin', 'not json');
    expect(readPosition('z.bin')).toBeNull();
  });

  it("keeps the device's zoom: automatic, fit width, fit page or a scale within bounds", () => {
    expect(readZoom()).toBe('auto');
    saveZoom('page-width');
    expect(readZoom()).toBe('page-width');
    saveZoom('page-fit');
    expect(readZoom()).toBe('page-fit');
    saveZoom(1.234);
    expect(readZoom()).toBe(1.23);
    saveZoom(40);
    expect(readZoom()).toBe(1.23);
    localStorage.setItem('pdfZoom', 'huge');
    expect(readZoom()).toBe('auto');
  });
});
