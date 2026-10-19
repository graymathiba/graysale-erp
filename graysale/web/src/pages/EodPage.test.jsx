import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import EodPage from './EodPage.jsx';

const h = vi.hoisted(() => {
  const state = { canImpl: () => true, err: vi.fn(), ok: vi.fn() };
  return state;
});

vi.mock('../api/client', () => ({
  api: { get: vi.fn(), post: vi.fn() },
}));
vi.mock('../api/AuthContext', () => ({
  useAuth: () => ({ can: (cap) => h.canImpl(cap) }),
}));
vi.mock('../components/Toast', () => ({
  useToast: () => ({ err: h.err, ok: h.ok }),
}));
vi.mock('../lib/thermalPrinter', () => ({
  printReceipt: vi.fn().mockResolvedValue(undefined),
  buildEodReport: vi.fn(() => ({ kind: 'eod' })),
}));

const { api } = await import('../api/client');
const { printReceipt } = await import('../lib/thermalPrinter');

const OPEN_SHIFT = {
  id: 7,
  doc_no: 'SHIFT-001',
  status: 'OPEN',
  user_id: 1,
  username: 'ada',
  full_name: 'Ada L.',
  opened_at: '2026-10-06T08:00:00.000Z',
  closed_at: null,
  opening_cash_cents: 500,
  cash_in: 1000,
  cash_out: 0,
};

beforeEach(() => {
  h.canImpl = () => true;
  h.err.mockReset();
  h.ok.mockReset();
  api.get.mockReset();
  api.post.mockReset();
  printReceipt.mockClear();
});

const mockBoot = ({ current = null, shifts = [] } = {}) => {
  api.get.mockImplementation(async (p) => {
    if (p === '/eod/current') return current;
    if (p === '/eod/shifts') return shifts;
    throw new Error(`unexpected GET ${p}`);
  });
};

describe('EodPage', () => {
  it('shows the no-shift banner and enables the open button', async () => {
    mockBoot({ current: null, shifts: [] });
    render(<EodPage />);

    expect(await screen.findByText('No open shift. Open one to start selling.')).toBeTruthy();
    expect(screen.getByText('+ Open shift').closest('button').disabled).toBe(false);
    expect(await screen.findByText('No shifts recorded yet.')).toBeTruthy();
  });

  it('shows the live shift banner and disables the open button while a shift is open', async () => {
    mockBoot({ current: OPEN_SHIFT, shifts: [OPEN_SHIFT] });
    render(<EodPage />);

    expect(await screen.findByText('Shift SHIFT-001 is open')).toBeTruthy();
    expect(screen.getByText('+ Open shift').closest('button').disabled).toBe(true);
    expect(screen.getByText('Ada L.')).toBeTruthy();
  });

  it('opens a shift with the entered float and reloads', async () => {
    mockBoot();
    api.post.mockResolvedValueOnce({ ...OPEN_SHIFT });
    render(<EodPage />);

    fireEvent.click(screen.getByText('+ Open shift'));
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '5.00' } });
    fireEvent.click(screen.getByText('Open Shift'));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/eod/open', { openingCashCents: 500 }));
    expect(h.ok).toHaveBeenCalledWith('Shift opened');
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(4)); // boot x2 + reload x2
  });

  it('omits openingCashCents when the float field is left empty', async () => {
    mockBoot();
    api.post.mockResolvedValueOnce(OPEN_SHIFT);
    render(<EodPage />);

    fireEvent.click(screen.getByText('+ Open shift'));
    fireEvent.click(screen.getByText('Open Shift'));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/eod/open', {}));
    expect(h.ok).toHaveBeenCalledWith('Shift opened');
  });

  it('renders the X-report modal with the fetched report', async () => {
    mockBoot({ current: OPEN_SHIFT, shifts: [OPEN_SHIFT] });
    api.get.mockImplementation(async (p) => {
      if (p === '/eod/current') return OPEN_SHIFT;
      if (p === '/eod/shifts') return [OPEN_SHIFT];
      if (p === '/eod/report/7')
        return {
          shift: OPEN_SHIFT,
          cashier: { full_name: 'Ada L.' },
          opening_float_cents: 500,
          expected_cash_cents: 1500,
          sale_count: 3,
          breakdown: { cash: 1000, card: 500 },
        };
      throw new Error(`unexpected GET ${p}`);
    });

    render(<EodPage />);
    fireEvent.click(await screen.findByText('View X-report'));

    const modal = await screen.findByText('X-Report — SHIFT-001');
    const report = modal.closest('.modal') || document.body;
    expect(within(report).getAllByText('Sales count').length).toBeGreaterThan(0);
    expect(within(report).getByText('3')).toBeTruthy();
    await waitFor(() => expect(printReceipt).toHaveBeenCalled());
  });

  it('runs Z-close with counted cash and confirms with the shift number', async () => {
    mockBoot({ current: OPEN_SHIFT, shifts: [OPEN_SHIFT] });
    const closed = { ...OPEN_SHIFT, status: 'CLOSED', closed_at: '2026-10-06T17:00:00.000Z' };
    api.post.mockResolvedValueOnce({
      shift: closed,
      opening_float_cents: 500,
      expected_cash_cents: 1500,
      counted_cash_cents: 1400,
      variance_cents: -100,
      sale_count: 3,
      breakdown: { cash: 1000, card: 500 },
    });

    render(<EodPage />);
    fireEvent.click(await screen.findByText('Z (Close)'));
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '14.00' } });
    fireEvent.click(screen.getByText('Run Z & Close Shift'));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/eod/report/7/z', { countedCashCents: 1400 }));
    expect(h.ok).toHaveBeenCalledWith('Z-report SHIFT-001 — shift closed');
    await waitFor(() => expect(printReceipt).toHaveBeenCalled());
  });

  it('hides the Z action when the user lacks eod.run capability', async () => {
    h.canImpl = (cap) => cap !== 'eod.run';
    mockBoot({ current: OPEN_SHIFT, shifts: [OPEN_SHIFT] });

    render(<EodPage />);
    expect(await screen.findByText('X-Report')).toBeTruthy();
    expect(screen.queryByText('Z (Close)')).toBeNull();
  });
});
