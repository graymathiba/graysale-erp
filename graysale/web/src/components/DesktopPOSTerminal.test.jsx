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

import DesktopPOSTerminal from './DesktopPOSTerminal';

const SHIFT = { id: 1, doc_no: 'SH-1', status: 'OPEN', opening_cash_cents: 0, opened_at: '2026-10-06T08:00:00Z' };

// $15.00 hammer taxed at 15% (1500 bps) — totals must include the server tax.
const HAMMER = {
  id: 10,
  name: 'Hammer',
  sku: 'HW-1',
  price_cents: 1500,
  qty_on_hand: 5,
  qty_reserved: 0,
  tax_rate_bps: 1500,
};

function mockBackend({ shift = SHIFT } = {}) {
  apiMock.get.mockImplementation((path) => {
    if (path.startsWith('/eod/current')) {
      return shift ? Promise.resolve({ shift }) : Promise.reject(new Error('NO_OPEN_SHIFT'));
    }
    if (path.startsWith('/categories')) return Promise.resolve([{ id: 1, name: 'Hardware' }]);
    if (path.startsWith('/products')) return Promise.resolve([HAMMER]);
    if (path.startsWith('/settings')) return Promise.resolve({ company: 'Test Store' });
    if (path.startsWith('/printers')) return Promise.resolve([]);
    if (path.startsWith('/customers')) return Promise.resolve([]);
    return Promise.resolve({});
  });
  apiMock.post.mockResolvedValue({
    doc_no: 'SALE-1',
    id: 501,
    status: 'PAID',
    total_cents: 1725,
    subtotal_cents: 1500,
    tax_cents: 225,
    meta: '{}',
    created_at: '2026-10-06T09:00:00Z',
  });
}

function renderPOS() {
  return render(
    <MemoryRouter>
      <DesktopPOSTerminal />
    </MemoryRouter>,
  );
}

async function addHammer(user) {
  await user.click(await screen.findByRole('button', { name: /Hammer/ }));
  await waitFor(() => expect(screen.getAllByText('$17.25').length).toBeGreaterThan(0), { timeout: 3000 });
}

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  Object.values(toast).forEach((fn) => fn.mockClear());
  localStorage.clear();
});

describe('DesktopPOSTerminal', () => {
  test('blocks selling until a shift is open', async () => {
    mockBackend({ shift: null });
    renderPOS();
    const user = userEvent.setup();

    expect(await screen.findByText(/No open shift/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Pay\s*F2/ }));

    expect(toast.warn).toHaveBeenCalledWith('Open a shift first');
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  test('rings a product with tax included in the total and summary row', async () => {
    mockBackend();
    renderPOS();
    const user = userEvent.setup();

    await addHammer(user);

    // $15.00 + 15% tax = $17.25 shows in the fin box AND the summary row.
    expect(screen.getAllByText('$17.25').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('$2.25').length).toBeGreaterThanOrEqual(2); // TAX col + summary
    expect(screen.getAllByText('$15.00').length).toBeGreaterThanOrEqual(2); // Amount $ + summary
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  test('completes a cash sale charging the tax-inclusive total', async () => {
    mockBackend();
    renderPOS();
    const user = userEvent.setup();

    await addHammer(user);

    await user.click(screen.getByRole('button', { name: /^Pay\s*F2/ }));
    expect(await screen.findByText('Cash received')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Charge/ }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith('/pos/sell', {
        items: [{ productId: 10, qty: 1 }],
        payments: [{ method: 'CASH', amountCents: 1725 }],
        orderDiscountPercent: 0,
      }),
    );
    expect(toast.ok).toHaveBeenCalledWith('Sale SALE-1 recorded');

    // Cart cleared after the sale lands.
    await waitFor(() => expect(screen.getAllByText('$0.00').length).toBeGreaterThan(0));
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

  test('order discount shrinks the taxable base on screen', async () => {
    mockBackend();
    renderPOS();
    const user = userEvent.setup();

    await addHammer(user);

    await user.type(screen.getByLabelText('Discount %'), '10');

    // 1500 - 10% = 1350 net; tax 15% = 203 (server rounding); total $15.53.
    await waitFor(() => expect(screen.getAllByText('$15.53').length).toBeGreaterThan(0), { timeout: 3000 });
  });
});
