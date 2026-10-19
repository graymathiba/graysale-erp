import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const { apiMock, toast } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
  toast: { ok: vi.fn(), err: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('../api/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, username: 'admin', full_name: 'Admin User', role: 'owner' },
    can: () => true,
    ready: true,
    needsActivation: false,
  }),
}));

vi.mock('../components/Toast', () => ({ useToast: () => toast }));

vi.mock('../api/client', () => ({ api: apiMock }));

import ClassicPOSTerminal from './ClassicPOSTerminal';

const SHIFT = { id: 1, doc_no: 'SH-1', status: 'OPEN', opening_cash_cents: 0, opened_at: '2026-10-06T08:00:00Z' };

function mockBackend({ shift = SHIFT } = {}) {
  apiMock.get.mockImplementation((path) => {
    // The backend answers 4xx when no shift is open → refreshShift's catch.
    if (path.startsWith('/eod/current')) {
      return shift ? Promise.resolve({ shift }) : Promise.reject(new Error('NO_OPEN_SHIFT'));
    }
    if (path.startsWith('/categories')) return Promise.resolve([{ id: 1, name: 'Hardware' }]);
    if (path.startsWith('/products')) {
      return Promise.resolve([
        { id: 10, name: 'Hammer', sku: 'HW-1', price_cents: 1500, qty_on_hand: 5, qty_reserved: 0 },
      ]);
    }
    if (path.startsWith('/settings')) return Promise.resolve({ company: 'Test Store' });
    if (path.startsWith('/printers')) return Promise.resolve([]);
    if (path.startsWith('/customers')) return Promise.resolve([]);
    return Promise.resolve({});
  });
  apiMock.post.mockResolvedValue({
    doc_no: 'SALE-1',
    id: 501,
    status: 'PAID',
    total_cents: 1500,
    subtotal_cents: 1500,
    tax_cents: 0,
    meta: '{}',
    created_at: '2026-10-06T09:00:00Z',
  });
}

function renderPOS() {
  return render(
    <MemoryRouter>
      <ClassicPOSTerminal />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  Object.values(toast).forEach((fn) => fn.mockClear());
  localStorage.clear();
});

describe('ClassicPOSTerminal', () => {
  test('blocks selling until a shift is open', async () => {
    mockBackend({ shift: null });
    renderPOS();
    const user = userEvent.setup();

    expect(await screen.findByText(/No open shift/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Pay\s*F2/ }));

    expect(toast.warn).toHaveBeenCalledWith('Open a shift first');
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  test('loads fast-key products and adds one to the cart', async () => {
    mockBackend();
    renderPOS();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /Hammer/ }));

    await waitFor(() => expect(screen.getByText(/Items:/).textContent).toContain('$15.00'), { timeout: 3000 });
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  test('completes a cash sale through the payment screen', async () => {
    mockBackend();
    renderPOS();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /Hammer/ }));
    await waitFor(() => expect(screen.getByText(/Items:/).textContent).toContain('$15.00'), { timeout: 3000 });

    // Pay (F2) opens the payment screen — the only way to charge.
    await user.click(screen.getByRole('button', { name: /^Pay\s*F2/ }));
    expect(await screen.findByText('Cash received')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Charge/ }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith('/pos/sell', {
        items: [{ productId: 10, qty: 1 }],
        payments: [{ method: 'CASH', amountCents: 1500 }],
        orderDiscountPercent: 0,
      }),
    );
    expect(toast.ok).toHaveBeenCalledWith('Sale SALE-1 recorded');

    // Cart cleared after the sale lands.
    await waitFor(() => expect(screen.getByText(/Items:/).textContent).toContain('$0.00'));
  });

  test('refuses to open payment with an empty cart', async () => {
    mockBackend();
    renderPOS();
    const user = userEvent.setup();

    await screen.findByRole('button', { name: /Hammer/ });
    await user.click(screen.getByRole('button', { name: /^Pay\s*F2/ }));

    expect(toast.warn).toHaveBeenCalledWith('Cart is empty');
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  test('shows change for over-tendered cash and blocks short tender', async () => {
    mockBackend();
    renderPOS();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /Hammer/ }));
    await waitFor(() => expect(screen.getByText(/Items:/).textContent).toContain('$15.00'), { timeout: 3000 });

    await user.click(screen.getByRole('button', { name: /^Pay\s*F2/ }));
    const received = await screen.findByPlaceholderText('0.00');
    await user.type(received, '10');

    // Short tender is refused with a plain-English message.
    await user.click(screen.getByRole('button', { name: /^Charge/ }));
    expect(toast.warn).toHaveBeenCalledWith('Not enough paid — $5.00 still due.');
    expect(apiMock.post).not.toHaveBeenCalled();

    // Over-tender shows the change.
    await user.clear(received);
    await user.type(received, '20');
    await waitFor(() => expect(screen.getAllByText('$5.00').length).toBeGreaterThan(0));
  });
});
