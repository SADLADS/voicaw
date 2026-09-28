// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import CreateGuild from './CreateGuild';

describe('CreateGuild', () => {
  it('renders the placeholder create-guild view', () => {
    render(<CreateGuild />);

    expect(screen.getByRole('heading', { name: 'Create Guild' })).toBeInTheDocument();
    expect(screen.getByText('This is the Create Guild view.')).toBeInTheDocument();
  });
});
