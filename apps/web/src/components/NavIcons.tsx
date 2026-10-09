// Small line icons for the sidebar (24×24, drawn with the current text colour). Kept in one place so there is no icon package to install.
const PATHS: Record<string, string> = {
  // groups
  sales: 'M3 4h2l2.2 10.2a1 1 0 0 0 1 .8h8.6a1 1 0 0 0 1-.8L19.5 8H6 M9 20a1 1 0 1 0 0-.01 M17 20a1 1 0 1 0 0-.01',
  operations: 'M12 3l8 4.5v9L12 21l-8-4.5v-9z M12 12l8-4.5 M12 12v9 M12 12L4 7.5',
  money: 'M3 7h18v10H3z M12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5 M6.5 10v.01 M17.5 14v.01',
  admin: 'M4 6h16 M4 12h16 M4 18h16 M8 4v4 M15 10v4 M10 16v4',
  // pages
  order: 'M6 3h9l4 4v14H6z M14 3v5h5 M9 13h7 M9 17h5',
  film: 'M4 5h16v14H4z M8 5v14 M16 5v14 M4 9h4 M4 15h4 M16 9h4 M16 15h4',
  artwork: 'M12 3a9 9 0 1 0 0 18c1.2 0 2-.8 2-1.8 0-.5-.2-.9-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1 .8-1.6 1.8-1.6H17a4 4 0 0 0 4-4C21 7 17 3 12 3z M7.5 11v.01 M10 7.5v.01 M14.5 7.5v.01',
  orders: 'M4 6h16 M4 12h16 M4 18h10',
  commission: 'M19 5L5 19 M7 9a2 2 0 1 0 0-.01 M17 19a2 2 0 1 0 0-.01',
  production: 'M3 20V10l6 3V9l6 3V6h4v14z M3 20h16',
  quality: 'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z M9 12l2 2 4-4',
  stock: 'M3 8l9-5 9 5v8l-9 5-9-5z M3 8l9 5 9-5 M12 13v8',
  dtf: 'M5 8h14v8H5z M8 8V4h8v4 M8 16v4h8v-4',
  finance: 'M4 20V10 M10 20V4 M16 20v-7 M22 20H2',
  compliance: 'M9 3h6l1 2h3v16H5V5h3z M9 13l2 2 4-4',
  accounting: 'M5 3h14v18H5z M8 7h8 M8 11h2 M12 11h2 M8 15h2 M12 15h2 M8 18.5h8',
  payments: 'M3 6h18v12H3z M3 10h18 M7 15h3',
  reports: 'M5 21V9 M12 21V3 M19 21v-8',
  masterdata: 'M12 4c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3z M4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7 M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  // controls
  key: 'M14.5 9.5a4 4 0 1 0-3.4 4L21 23 M17 17l2 2 M14 14l2 2',
  logout: 'M9 4H5v16h4 M16 8l4 4-4 4 M20 12H9',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4 7.5 7.5 0 1 0 20 14.5z',
  ivory: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 3v18 M12 3a9 9 0 0 1 0 18z',
  plus: 'M12 5v14 M5 12h14',
  chevron: 'M6 9l6 6 6-6',
  collapse: 'M11 6l-6 6 6 6 M5 12h14',
  expand: 'M13 6l6 6-6 6 M19 12H5',
  palette: 'M12 3a9 9 0 1 0 0 18c1.2 0 2-.8 2-1.8 0-.5-.2-.9-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1 .8-1.6 1.8-1.6H17a4 4 0 0 0 4-4C21 7 17 3 12 3z',
  menu: 'M4 7h16 M4 12h16 M4 17h16',
  close: 'M6 6l12 12 M18 6L6 18',
};

export type IconName = keyof typeof PATHS;

export default function Icon({ name, size = 18 }: { name: IconName | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}>
      <path d={PATHS[name] ?? PATHS.orders} />
    </svg>
  );
}
