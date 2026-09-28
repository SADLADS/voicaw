// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Calendar from './Calendar';

describe('Calendar', () => {
  it('renders the placeholder calendar view', () => {
    render(<Calendar />);

    expect(screen.getByRole('heading', { name: 'Calendar' })).toBeInTheDocument();
    expect(screen.getByText('This is the Calendar view.')).toBeInTheDocument();
  });
});
