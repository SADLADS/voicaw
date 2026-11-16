// @vitest-environment jsdom
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorState, FormError, InlineError } from './ErrorState';
import Toasts from './Toasts';
import ConnectionStrip from './ConnectionStrip';
import { LayoutContext } from '../contexts';
import { codedError } from '../utils/errors';
import { noteRequestAnswered, noteRequestUnanswered, noteSocketState, resetConnection } from '../utils/connection';
import { clearToasts, getToasts, showErrorToast } from '../services/toasts';
import { t } from '../i18n';

vi.mock('../utils/api', () => ({ default: { get: vi.fn(() => Promise.resolve({ data: {} })) } }));
vi.mock('../utils/ws-client', () => ({ reconnectNow: vi.fn() }));

const unreachable = () => Object.assign(new Error('Network Error'), { isAxiosError: true, code: 'ERR_NETWORK', config: { method: 'get', url: '/dm-messages/2' } });
const serverError = () => Object.assign(new Error('Request failed with status code 500'), {
  isAxiosError: true, config: { method: 'get', url: '/dm-messages/2' }, response: { status: 500, data: { error: 'Internal server error' } },
});

beforeEach(() => {
  resetConnection();
  clearToasts();
});
afterEach(() => vi.useRealTimers());

describe('ErrorState', () => {
  it("says what failed in words, never axios's, with Try again and Details", () => {
    const onRetry = vi.fn();
    render(<ErrorState error={serverError()} title={t('errors.titles.loadMessages')} onRetry={onRetry} />);
    expect(screen.getByText(t('errors.titles.loadMessages'))).toBeInTheDocument();
    expect(screen.getByText(t('errors.text.server'))).toBeInTheDocument();
    expect(screen.queryByText(/status code/)).toBeNull();
    fireEvent.click(screen.getByText(t('errors.tryAgain')));
    expect(onRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText(t('errors.details')));
    expect(screen.getByText(/^500 · GET \/dm-messages\/2 · /)).toBeInTheDocument();
  });

  it('offers to log out and back in when this device has no keys', () => {
    const onLogout = vi.fn();
    render(
      <LayoutContext.Provider value={{ onLogout }}>
        <ErrorState error={codedError(t('chat.noKeys'), 'no_keys')} onRetry={() => {}} />
      </LayoutContext.Provider>,
    );
    expect(screen.getByText(t('errors.noKeys.title'))).toBeInTheDocument();
    fireEvent.click(screen.getByText(t('errors.noKeys.action')));
    expect(onLogout).toHaveBeenCalled();
    expect(screen.queryByText(t('errors.details'))).toBeNull();
  });

  it('tries again by itself once Voicaw answers again, after failing for want of it', () => {
    const onRetry = vi.fn();
    noteRequestUnanswered();
    render(<ErrorState error={unreachable()} onRetry={onRetry} />);
    expect(screen.getByText(t('errors.text.offline'))).toBeInTheDocument();
    expect(onRetry).not.toHaveBeenCalled();
    act(() => noteRequestAnswered());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('InlineError and FormError', () => {
  it('show the reason, Try again only when it can help', () => {
    const { rerender } = render(<InlineError error={unreachable()} title="Couldn't load" onRetry={() => {}} />);
    expect(screen.getByText(t('errors.tryAgain'))).toBeInTheDocument();
    rerender(<InlineError error={{ response: { status: 403, data: { error: 'Missing permissions' } } }} title="Couldn't load" onRetry={() => {}} />);
    expect(screen.getByText('Missing permissions')).toBeInTheDocument();
    expect(screen.queryByText(t('errors.tryAgain'))).toBeNull();
    rerender(<FormError error={unreachable()} title="Not saved" />);
    expect(screen.getByText('Not saved')).toBeInTheDocument();
    expect(screen.getByText(t('errors.text.offline'))).toBeInTheDocument();
  });
});

describe('toasts', () => {
  it('show, retry and go by themselves', () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    render(<Toasts />);
    act(() => { showErrorToast("Couldn't pin that message", serverError(), { onRetry }); });
    expect(screen.getByText("Couldn't pin that message")).toBeInTheDocument();
    expect(screen.getByText(t('errors.text.server'))).toBeInTheDocument();
    fireEvent.click(screen.getByText(t('errors.tryAgain')));
    expect(onRetry).toHaveBeenCalled();
    expect(getToasts()).toHaveLength(0);
    act(() => { showErrorToast('Gone soon', 'Words'); });
    act(() => { vi.advanceTimersByTime(6100); });
    expect(screen.queryByText('Gone soon')).toBeNull();
  });

  it("aren't shown for a lost connection while the strip already says so", () => {
    noteRequestUnanswered();
    expect(showErrorToast("Couldn't pin that message", unreachable())).toBeNull();
    expect(getToasts()).toHaveLength(0);
  });
});

describe('ConnectionStrip', () => {
  it('shows after a moment without the connection, counting down, and goes once back', () => {
    vi.useFakeTimers();
    render(<ConnectionStrip />);
    act(() => noteSocketState('online'));
    act(() => noteSocketState('connecting', Date.now() + 3000));
    expect(screen.queryByText(t('errors.connection.lost'))).toBeNull();
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.getByText(t('errors.connection.lost'))).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(500); });
    expect(screen.getByText(t('errors.connection.retryIn', { seconds: 1 }))).toBeInTheDocument();
    act(() => noteSocketState('online'));
    expect(screen.queryByText(t('errors.connection.lost'))).toBeNull();
  });

  it("doesn't flash for a moment's reconnect", () => {
    vi.useFakeTimers();
    render(<ConnectionStrip />);
    act(() => noteSocketState('online'));
    act(() => noteSocketState('connecting'));
    act(() => { vi.advanceTimersByTime(1000); });
    act(() => noteSocketState('online'));
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.queryByText(t('errors.connection.lost'))).toBeNull();
  });
});
