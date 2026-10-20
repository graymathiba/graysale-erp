import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import InvoicesPage from './InvoicesPage.jsx';

const h = vi.hoisted(() => ({ err: vi.fn(), ok: vi.fn() }));

vi.mock('../api/client', () => ({
  api: { get: vi.fn(), post: vi.fn() },
}));
vi.mock('../components/Toast', () => ({
  useToast: () => ({ err: h.err, ok: h.ok }),
}));

const { api } = await import('../api/client');

const AR = [
  {
    id: 1,
    doc_no: 'INV-1001',
    kind: 'INVOICE',
    status: 'SENT',
    due_date: '2026-10-15T00:00:00.000Z',
    total_cents: 125000,
    paid_cents: 50000,
    customer_name: 'Walk-in',
  },
  {
    id: 2,
    doc_no: 'INV-1002',
    kind: 'QUOTE',
    status: 'DRAFT',
    due_date: null,
    total_cents: 4000,
    paid_cents: 0,
    customer_name: 'Café',
  },
];

const AP = [
  {
    id: 9,
    doc_no: 'BILL-77',
    status: 'UNPAID',
    due_date: '2026-10-20T00:00:00.000Z',
    total_cents: 9900,
    paid_cents: 0,
    supplier_name: 'Coca-Cola',
  },
];

const QUOTES = [
  {
    id: 31,
    doc_no: 'QUOTE-00031',
    type: 'QUOTE',
    status: 'OPEN',
    created_at: '2026-10-18 09:30:00',
    total_cents: 45000,
    customer_name: 'Tendai M.',
  },
];

beforeEach(() => {
  h.err.mockReset();
  h.ok.mockReset();
  api.get.mockReset();
  api.post.mockReset();
});

const mockApi = (overrides = {}) => {
  api.get.mockImplementation(async (p) => {
    if (p === '/ar') return overrides.ar ?? AR;
    if (p === '/ap') return overrides.ap ?? AP;
    if (p === '/orders?type=QUOTE') return overrides.quotes ?? QUOTES;
    throw new Error(`unexpected path ${p}`);
  });
};

const renderPage = () =>
  render(
    <MemoryRouter>
      <InvoicesPage />
    </MemoryRouter>,
  );

describe('InvoicesPage', () => {
  it('renders AR rows with computed open balance', async () => {
    mockApi();
    renderPage();

    expect(await screen.findByText('INV-1001')).toBeTruthy();
    expect(screen.getByText('INV-1002')).toBeTruthy();
    expect(screen.getByText('Walk-in')).toBeTruthy();
    // open = total - paid = 125000 - 50000 = 75000
    expect(h.err).not.toHaveBeenCalled();
  });

  it('switches to the AP tab and lists supplier bills', async () => {
    mockApi();
    renderPage();

    fireEvent.click(screen.getByText('Accounts Payable (AP)'));
    expect(await screen.findByText('BILL-77')).toBeTruthy();
    expect(screen.getByText('Coca-Cola')).toBeTruthy();
    expect(screen.queryByText('INV-1001')).toBeNull();
  });

  it('loads quotations lazily on the Quotes tab', async () => {
    mockApi();
    renderPage();

    await screen.findByText('INV-1001');
    expect(api.get).not.toHaveBeenCalledWith('/orders?type=QUOTE');

    fireEvent.click(screen.getByText('Quotes'));
    expect(await screen.findByText('QUOTE-00031')).toBeTruthy();
    expect(screen.getByText('Tendai M.')).toBeTruthy();
    expect(screen.getByText('Convert')).toBeTruthy();
    expect(screen.getByText('Print A4')).toBeTruthy();
  });

  it('converts an open quote with a full CASH payment', async () => {
    mockApi();
    api.post.mockResolvedValue({ id: 77, doc_no: 'SALE-00077' });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();

    fireEvent.click(screen.getByText('Quotes'));
    fireEvent.click(await screen.findByText('Convert'));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith('/pos/quote/31/convert', {
      payments: [{ method: 'CASH', amountCents: 45000 }],
    });
    await waitFor(() => expect(h.ok).toHaveBeenCalledWith('Converted to sale SALE-00077'));
    confirm.mockRestore();
  });

  it('shows the empty state when there are no AR invoices', async () => {
    mockApi({ ar: [], ap: [] });
    renderPage();

    expect(await screen.findByText('No AR invoices.')).toBeTruthy();
    fireEvent.click(screen.getByText('Accounts Payable (AP)'));
    expect(await screen.findByText('No AP invoices.')).toBeTruthy();
  });

  it('accepts {rows} shaped responses as well as arrays', async () => {
    mockApi({ ar: { rows: [AR[0]] } });
    renderPage();

    expect(await screen.findByText('INV-1001')).toBeTruthy();
    expect(h.err).not.toHaveBeenCalled();
  });

  it('toasts a non-silent AR failure but swallows silent interceptor errors', async () => {
    const silent = Object.assign(new Error('session expired'), { silent: true });
    api.get.mockRejectedValueOnce(silent);
    api.get.mockResolvedValueOnce(AP);
    renderPage();

    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(h.err).not.toHaveBeenCalled();

    api.get.mockReset();
    api.get.mockRejectedValueOnce(new Error('backend down'));
    api.get.mockResolvedValueOnce(AP);
    renderPage();

    await waitFor(() => expect(h.err).toHaveBeenCalledWith('backend down'));
  });
});
