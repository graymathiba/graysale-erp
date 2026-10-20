// Classic Desktop menu bar + shortcut toolbar definition.
// Every real entry maps to an existing ERP page (mounted under /desktop/*);
// Payroll / Diary / Telephones are stubs that open an in-workspace panel.
// Entry shape: { label, route?|action?, icon, cap? }

export const DESKTOP_MENUS = [
  {
    title: 'Sales',
    items: [
      { label: 'Point of Sale', route: '/desktop/pos', icon: 'cart' },
      { label: 'Invoices / Quotes', route: '/desktop/invoices', icon: 'doc', cap: 'invoicing.view' },
      { label: 'Day Close (EOD)', route: '/desktop/eod', icon: 'clock', cap: 'eod.self' },
    ],
  },
  {
    title: 'Stock',
    items: [{ label: 'Stock & Products', route: '/desktop/stock', icon: 'box' }],
  },
  {
    title: 'Purchase',
    items: [
      { label: 'Purchasing', route: '/desktop/purchasing', icon: 'clipboard', cap: 'purchasing.manage' },
      { label: 'Suppliers', route: '/desktop/suppliers', icon: 'truck', cap: 'suppliers.manage' },
    ],
  },
  {
    title: 'Payroll',
    items: [
      { label: 'Employee Payroll', action: 'stub:Payroll', icon: 'money' },
      { label: 'Payslips', action: 'stub:Payslips', icon: 'doc' },
    ],
  },
  {
    title: 'Accounts',
    items: [{ label: 'Accounting Ledger', route: '/desktop/accounting', icon: 'calculator', cap: 'accounting.view' }],
  },
  {
    title: 'Diary',
    items: [{ label: 'Tasks & Reminders', action: 'stub:Diary', icon: 'book' }],
  },
  {
    title: 'Telephones',
    items: [{ label: 'Contacts Book', action: 'stub:Telephones', icon: 'phonebook' }],
  },
  {
    title: 'Maintenance',
    items: [
      { label: 'Company Profile', route: '/desktop/company', icon: 'doc', cap: 'settings.manage' },
      { label: 'Hardware Setup', action: 'hardware', icon: 'wrench', cap: 'settings.manage' },
      { label: 'Activity Log', action: 'activity', icon: 'log', cap: 'users.view' },
      { label: 'Data Storage', route: '/desktop/storage', icon: 'box' },
    ],
  },
  {
    title: 'Help',
    items: [
      { label: 'Support', route: '/desktop/support', icon: 'life' },
      { label: 'About GraySale', action: 'about', icon: 'info' },
    ],
  },
];

// Bottom-of-screen shortcut toolbar (16 tiles, Retail Man style).
export const DESKTOP_SHORTCUTS = [
  { key: 'dashboard', label: 'Dashboard', route: '/desktop/dashboard', icon: 'chart' },
  { key: 'pos', label: 'Point of Sale', route: '/desktop/pos', icon: 'cart' },
  { key: 'stock', label: 'Stock', route: '/desktop/stock', icon: 'box' },
  { key: 'customers', label: 'Customers', route: '/desktop/customers', icon: 'user' },
  { key: 'suppliers', label: 'Suppliers', route: '/desktop/suppliers', icon: 'truck', cap: 'suppliers.manage' },
  { key: 'purchasing', label: 'Purchasing', route: '/desktop/purchasing', icon: 'clipboard', cap: 'purchasing.manage' },
  { key: 'invoices', label: 'Invoices', route: '/desktop/invoices', icon: 'doc', cap: 'invoicing.view' },
  { key: 'accounting', label: 'Accounting', route: '/desktop/accounting', icon: 'calculator', cap: 'accounting.view' },
  { key: 'reports', label: 'Reports', route: '/desktop/reports', icon: 'chart', cap: 'reports.view' },
  { key: 'eod', label: 'Day Close', route: '/desktop/eod', icon: 'clock', cap: 'eod.self' },
  { key: 'payroll', label: 'Payroll', action: 'stub:Payroll', icon: 'money' },
  { key: 'settings', label: 'Settings', route: '/desktop/settings', icon: 'gear', cap: 'settings.manage' },
  { key: 'users', label: 'Users', route: '/desktop/users', icon: 'users', cap: 'users.manage' },
  { key: 'hardware', label: 'Hardware', action: 'hardware', icon: 'wrench', cap: 'settings.manage' },
  { key: 'calculator', label: 'Calculator', action: 'calculator', icon: 'calculator' },
  { key: 'activity', label: 'Activity', action: 'activity', icon: 'log', cap: 'users.view' },
];

// Route table: desktop menu/shortcut routes -> the page that renders them.
// Stubs and shell actions never reach here.
export const DESKTOP_ROUTES = {
  '/desktop/dashboard': 'dashboard',
  '/desktop/stock': 'stock',
  '/desktop/customers': 'customers',
  '/desktop/suppliers': 'suppliers',
  '/desktop/purchasing': 'purchasing',
  '/desktop/invoices': 'invoices',
  '/desktop/accounting': 'accounting',
  '/desktop/reports': 'reports',
  '/desktop/eod': 'eod',
  '/desktop/settings': 'settings',
  '/desktop/users': 'users',
  '/desktop/storage': 'storage',
  '/desktop/company': 'company',
  '/desktop/company-profile': 'company-profile',
  '/desktop/support': 'support',
};
