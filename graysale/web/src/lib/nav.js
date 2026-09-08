// Sidebar navigation definition grouped into MAIN / OTHERS, VANTUS-style.
// Each item: { key, label, route, cap (optional capability gate) }.

export const NAV_GROUPS = [
  {
    title: 'Main',
    items: [
      { key: 'pos', label: 'Point of Sale', route: '/pos' },
      { key: 'dashboard', label: 'Dashboard', route: '/dashboard' },
      { key: 'accounting', label: 'Accounting', route: '/accounting', cap: 'accounting.view' },
      { key: 'purchasing', label: 'Purchasing', route: '/purchasing', cap: 'purchasing.manage' },
      { key: 'invoices', label: 'Invoicing / Quotes', route: '/invoices', cap: 'invoicing.view' },
      { key: 'stock', label: 'Stock & Products', route: '/stock' },
      { key: 'customers', label: 'Customers', route: '/customers' },
      { key: 'suppliers', label: 'Suppliers', route: '/suppliers', cap: 'suppliers.manage' },
      { key: 'reports', label: 'Sales Analysis', route: '/reports', cap: 'reports.view' },
      { key: 'eod', label: 'Day Close (EOD)', route: '/eod', cap: 'eod.self' },
    ],
  },
  {
    title: 'Others',
    items: [
      { key: 'company-profile', label: 'My Profile', route: '/company-profile', cap: 'settings.manage' },
      { key: 'company', label: 'Company Profile', route: '/company', cap: 'settings.manage' },
      { key: 'settings', label: 'Settings', route: '/settings', cap: 'settings.manage' },
      { key: 'users', label: 'User Management', route: '/users', cap: 'users.manage' },
      { key: 'support', label: 'Support', route: '/support' },
      { key: 'control-tower', label: 'Control Tower', route: '/admin/control-tower', super: true },
    ],
  },
];

// Flat lookup for a group title by route (used by the breadcrumb).
export function findNavItem(route) {
  for (const g of NAV_GROUPS) {
    const it = g.items.find((i) => i.route === route);
    if (it) return { item: it, group: g.title };
  }
  return null;
}

// Guards a route; returns whether the current user may view it.
export function routeAllowed(route, can) {
  for (const g of NAV_GROUPS) {
    const it = g.items.find((i) => i.route === route);
    if (it) {
      if (it.super) return true; // super routes are further gated in the router
      return !it.cap || can(it.cap);
    }
  }
  return true;
}
