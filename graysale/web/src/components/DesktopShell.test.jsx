import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const { logout } = vi.hoisted(() => ({ logout: vi.fn() }));

vi.mock('../api/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, username: 'admin', full_name: 'Admin User', role: 'owner' },
    tenant: { company_name: 'Test Store' },
    can: () => true,
    ready: true,
    needsActivation: false,
    logout,
  }),
}));

vi.mock('../components/Toast', () => ({
  useToast: () => ({ ok: vi.fn(), err: vi.fn(), warn: vi.fn() }),
}));

import DesktopShell from './DesktopShell';

function renderShell() {
  return render(
    <MemoryRouter initialEntries={['/desktop']}>
      <Routes>
        <Route path="/desktop" element={<DesktopShell />}>
          <Route index element={<div data-testid="route-home" />} />
          <Route path="pos" element={<div data-testid="route-pos" />} />
          <Route path="stock" element={<div data-testid="route-stock" />} />
        </Route>
        <Route path="/dashboard" element={<div data-testid="route-modern" />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  logout.mockClear();
});

describe('DesktopShell', () => {
  test('renders the classic title bar with company and signed-in user', async () => {
    renderShell();
    expect(await screen.findByText(/GraySale Classic — Test Store/)).toBeInTheDocument();
    expect(screen.getByText(/Admin User/)).toBeInTheDocument();
    expect(screen.getByTestId('route-home')).toBeInTheDocument();
  });

  test('menu bar opens Sales and navigates to the desktop POS', async () => {
    renderShell();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Sales' }));
    // The dropdown item and the toolbar tile share a label — the dropdown comes first.
    const posBtns = await screen.findAllByRole('button', { name: /Point of Sale/ });
    await user.click(posBtns[0]);

    expect(await screen.findByTestId('route-pos')).toBeInTheDocument();
    // menu folds away after navigating
    await waitFor(() => expect(screen.queryByRole('button', { name: /Invoices \/ Quotes/ })).not.toBeInTheDocument());
  });

  test('shortcut toolbar navigates to Stock', async () => {
    renderShell();
    const user = userEvent.setup();

    // "Stock" exists both in the menu bar and as a toolbar tile — pick the tile.
    const tiles = screen.getAllByRole('button', { name: 'Stock' });
    await user.click(tiles[tiles.length - 1]);

    expect(await screen.findByTestId('route-stock')).toBeInTheDocument();
  });

  test('Payroll shortcut opens the stub window', async () => {
    renderShell();
    const user = userEvent.setup();

    // "Payroll" is a menu title and a toolbar tile — pick the tile.
    const tiles = screen.getAllByRole('button', { name: 'Payroll' });
    await user.click(tiles[tiles.length - 1]);

    expect(await screen.findByRole('dialog', { name: 'Payroll' })).toBeInTheDocument();
    expect(screen.getByText(/not available in the web build/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Payroll' })).not.toBeInTheDocument());
  });

  test('Escape closes an open menu', async () => {
    renderShell();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Maintenance' }));
    expect(await screen.findByRole('button', { name: /Hardware Setup/ })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('button', { name: /Hardware Setup/ })).not.toBeInTheDocument());
  });

  test('lock overlay locks and unlocks the workspace', async () => {
    renderShell();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Lock screen' }));
    expect(await screen.findByText('Session locked')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(screen.queryByText('Session locked')).not.toBeInTheDocument());
    expect(logout).not.toHaveBeenCalled();
  });
});
