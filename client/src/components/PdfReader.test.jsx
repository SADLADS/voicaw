// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const openPdf = vi.fn();
class PdfPasswordError extends Error {}
vi.mock('../services/pdf/pdfjs', () => ({
  openPdf: (...args) => openPdf(...args),
  PdfPasswordError,
  pdfjsLib: { AnnotationMode: { ENABLE: 1 }, TouchManager: class {} },
}));

// PDF.js's viewer, standing in: one 1000px page per page, the place kept in properties.
const viewers = [];
vi.mock('pdfjs-dist/legacy/web/pdf_viewer.mjs', () => {
  class EventBus {
    constructor() { this.handlers = {}; }
    on(name, fn) { (this.handlers[name] ??= []).push(fn); }
    dispatch(name, data) { (this.handlers[name] ?? []).forEach((fn) => fn(data)); }
  }
  class PDFViewer {
    constructor(options) {
      Object.assign(this, options);
      this.currentScale = 1;
      this.pagesCount = 0;
      this._page = 1;
      viewers.push(this);
    }
    get currentPageNumber() { return this._page; }
    set currentPageNumber(n) {
      this._page = n;
      this.eventBus.dispatch('pagechanging', { pageNumber: n });
    }
    set currentScaleValue(v) { this.scaleValue = v; this.eventBus.dispatch('scalechanging', { scale: 1.5 }); }
    getPageView(i) { return { div: { offsetTop: i * 1000, offsetHeight: 1000 } }; }
    setDocument(doc) {
      this.pdfDocument = doc;
      if (doc) {
        this.pagesCount = doc.numPages;
        queueMicrotask(() => this.eventBus.dispatch('pagesinit', {}));
      }
    }
    nextPage() { this.currentPageNumber = this._page + 1; }
    previousPage() { this.currentPageNumber = this._page - 1; }
    updateScale() {}
  }
  class PDFLinkService {
    constructor(options) { Object.assign(this, options); }
    setViewer(viewer) { this.viewer = viewer; }
    setDocument() {}
    goToDestination = vi.fn();
  }
  class PDFFindController { constructor(options) { Object.assign(this, options); } }
  return { EventBus, LinkTarget: { BLANK: 2 }, PDFFindController, PDFLinkService, PDFViewer };
});

const { default: PdfReader } = await import('./PdfReader');

const fakeDoc = (numPages = 12, outline = []) => ({
  numPages,
  getOutline: async () => outline,
  loadingTask: { destroy: vi.fn() },
});
const load = () => Promise.resolve(new Blob(['%PDF']));

beforeEach(() => {
  localStorage.clear();
  openPdf.mockReset();
  viewers.length = 0;
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:pdf');
  globalThis.URL.revokeObjectURL = vi.fn();
  Blob.prototype.arrayBuffer ??= async function arrayBuffer() { return new ArrayBuffer(4); };
});

describe('PdfReader', () => {
  it('shows the pages with the page number, zoom, Find and Contents', async () => {
    openPdf.mockResolvedValue(fakeDoc(12, [{ title: 'Introduction', dest: 'intro', items: [] }]));
    render(<PdfReader name="report.pdf" load={load} positionKey="abc.bin" onClose={() => {}} />);
    expect(await screen.findByText('of 12')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'report.pdf' })).toBeInTheDocument();
    await waitFor(() => expect(viewers[0]?.scaleValue).toBe('auto'));
    // Forms drawn, not fillable; no download manager or scripting.
    expect(viewers[0].annotationMode).toBe(1);
    expect(viewers[0].downloadManager).toBeUndefined();
    expect(viewers[0].scriptingManager).toBeUndefined();

    const pageBox = screen.getByRole('textbox', { name: 'Page number, of 12' });
    fireEvent.change(pageBox, { target: { value: '7' } });
    fireEvent.submit(pageBox.closest('form'));
    expect(viewers[0].currentPageNumber).toBe(7);

    fireEvent.click(await screen.findByRole('button', { name: 'Contents' }));
    fireEvent.click(screen.getByRole('button', { name: 'Introduction' }));
    expect(viewers[0].linkService.goToDestination).toHaveBeenCalledWith('intro');

    fireEvent.click(screen.getByRole('button', { name: 'Find in PDF' }));
    expect(screen.getByRole('searchbox', { name: 'Find in PDF' })).toBeInTheDocument();
  });

  it('goes back to where the PDF was left, and remembers the place when closed', async () => {
    localStorage.setItem('pdfPosition:abc.bin', JSON.stringify({ page: 3, fraction: 0.5 }));
    openPdf.mockResolvedValue(fakeDoc(12));
    const { unmount } = render(<PdfReader name="report.pdf" load={load} positionKey="abc.bin" onClose={() => {}} />);
    await waitFor(() => expect(viewers[0]?.currentPageNumber).toBe(3));
    const container = viewers[0].container;
    expect(container.scrollTop).toBe(2500);
    act(() => { viewers[0].currentPageNumber = 5; });
    container.scrollTop = 4250;
    unmount();
    expect(JSON.parse(localStorage.getItem('pdfPosition:abc.bin'))).toEqual({ page: 5, fraction: 0.25 });
  });

  it('asks for a password, says when it was wrong, and never keeps it', async () => {
    let answers = [];
    openPdf.mockImplementation(async (bytes, { onPassword }) => {
      answers.push(await onPassword(false));
      answers.push(await onPassword(true));
      return fakeDoc(2);
    });
    render(<PdfReader name="locked.pdf" load={load} positionKey="l.bin" onClose={() => {}} />);
    const box = await screen.findByLabelText('Password');
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.change(box, { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("That password didn't open it.");
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByText('of 2')).toBeInTheDocument();
    expect(answers).toEqual(['wrong', 'secret']);
    expect(JSON.stringify({ ...localStorage })).not.toContain('secret');
  });

  it('closes when the password is cancelled', async () => {
    const onClose = vi.fn();
    openPdf.mockImplementation(async (bytes, { onPassword }) => {
      if (await onPassword(false) == null) throw new PdfPasswordError();
      return fakeDoc(1);
    });
    render(<PdfReader name="locked.pdf" load={load} positionKey={null} onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });

  it("says when a file isn't a PDF it can open, and when the download failed", async () => {
    openPdf.mockRejectedValue(new Error('Invalid PDF structure'));
    const { unmount } = render(<PdfReader name="broken.pdf" load={load} positionKey={null} onClose={() => {}} />);
    expect(await screen.findByText("This PDF couldn't be opened")).toBeInTheDocument();
    unmount();
    render(<PdfReader name="gone.pdf" load={() => Promise.reject(new Error('404'))} positionKey={null} onClose={() => {}} />);
    expect(await screen.findByText('Download failed')).toBeInTheDocument();
  });

  it("lets only another site's http(s) and mailto links out of a PDF", async () => {
    openPdf.mockResolvedValue(fakeDoc(1));
    render(<PdfReader name="links.pdf" load={load} positionKey={null} onClose={() => {}} />);
    await screen.findByText('of 1');
    const pages = viewers[0].viewer;
    const click = (href) => {
      const a = document.createElement('a');
      a.setAttribute('href', href);
      pages.append(a);
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      a.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(click('https://example.com/')).toBe(false);
    expect(click('mailto:a@example.com')).toBe(false);
    expect(click('tel:123')).toBe(true);
    expect(click('ftp://example.com/x')).toBe(true);
    expect(click('javascript:alert(1)')).toBe(true);
  });
});
