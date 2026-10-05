import { fmtDate } from '@glm/shared';
import type { CompanySettings, P9Data, PayrollData, PayrollRow } from '../api/models';

// Payroll register, payslips and the P9 tax deduction card — all A4 printouts for the accountant, the employee and KRA. Plain, black-and-white
// friendly layouts built as HTML and printed from a popup (the popup must already be open, via a synchronous window.open in the click handler,
// so browser popup blockers do not stop it).

const esc = (s: string | null | undefined) => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (v: number) => v.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dash = (v: string | null | undefined) => (v && v.trim() ? esc(v) : '—');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const BASE_CSS = `
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: Arial, Helvetica, sans-serif; color: #111; font-size: 11px; margin: 0; background: #fff; }
  h1 { font-size: 20px; margin: 0; letter-spacing: 0.02em; }
  h2 { font-size: 13px; margin: 0 0 4px; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; border-bottom: 2px solid #1f2a5e; padding-bottom: 8px; margin-bottom: 10px; }
  .head .co { font-size: 12px; line-height: 1.5; }
  .head .co b { font-size: 14px; }
  .logo { max-width: 90px; max-height: 60px; object-fit: contain; }
  .muted { color: #555; }
  .missing { color: #a33; font-weight: 700; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #999; padding: 4px 6px; vertical-align: top; }
  th { background: #eceef5; text-align: left; font-size: 10.5px; }
  .r { text-align: right; white-space: nowrap; }
  tfoot td { font-weight: 700; background: #f4f5fa; }
  .sign { display: flex; gap: 40px; margin-top: 34px; }
  .sign div { flex: 1; border-top: 1px solid #111; padding-top: 4px; font-size: 10.5px; }
  .page { page-break-after: always; }
  .page:last-child { page-break-after: auto; }
`;

function shell(title: string, orientation: 'portrait' | 'landscape', margin: string, body: string, extraCss = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8" /><title>${esc(title)}</title><style>
  @page { size: A4 ${orientation}; margin: ${margin}; }
  ${BASE_CSS}${extraCss}
</style></head><body>${body}</body></html>`;
}

function header(company: CompanySettings, title: string, sub: string): string {
  const name = esc(company.legalName?.trim() || company.companyName || '');
  const trading = company.legalName?.trim() && company.legalName.trim() !== (company.companyName || '').trim() ? `<div class="muted">Trading as ${esc(company.companyName)}</div>` : '';
  return `<div class="head">
    <div class="co"><b>${name}</b>${trading}
      ${company.companyAddress ? `<div>${esc(company.companyAddress)}</div>` : ''}
      <div>Employer's KRA PIN: ${company.kraPin ? `<b>${esc(company.kraPin)}</b>` : '<span class="missing">not recorded — add it under Master Data → Company Info</span>'}</div>
    </div>
    <div style="text-align:right"><h1>${esc(title)}</h1><div class="muted">${esc(sub)}</div>${company.logoDataUrl ? `<div style="margin-top:6px"><img class="logo" src="${company.logoDataUrl}" alt="" /></div>` : ''}</div>
  </div>`;
}

/** Opens the document in the (already open) popup and prints it. */
export function printHtml(w: Window | null, html: string) {
  if (!w) return;
  w.document.open();
  w.document.write(html);
  w.document.close();
  setTimeout(() => {
    w.focus();
    w.print();
    w.close();
  }, 400);
}

// ── Payroll register: every pay entry in the period, with the employee's identifiers ──────────────────────────────────────────────
export function buildPayrollRegisterHtml(data: PayrollData, company: CompanySettings): string {
  const rows = [...data.rows].sort((a, b) => a.name.localeCompare(b.name) || a.date.localeCompare(b.date));
  const body = `${header(company, 'PAYROLL', `${fmtDate(data.fromDate)} to ${fmtDate(data.toDate)}`)}
  <table>
    <thead><tr>
      <th>Date</th><th>Employee</th><th>National ID</th><th>KRA PIN</th><th>SHIF No.</th>
      <th class="r">Gross pay</th><th class="r">PAYE</th><th class="r">NSSF</th><th class="r">SHIF</th><th class="r">Housing levy</th><th class="r">Net pay</th>
    </tr></thead>
    <tbody>${rows
      .map(
        (r) => `<tr>
      <td>${fmtDate(r.date)}</td>
      <td>${esc(r.name)}<div class="muted">${esc(r.employeeType)}${r.department ? ` · ${esc(r.department)}` : ''}</div></td>
      <td>${dash(r.nationalId)}</td><td>${dash(r.kraPin)}</td><td>${dash(r.shifNumber)}</td>
      <td class="r">${money(r.grossPay)}</td><td class="r">${money(r.paye)}</td><td class="r">${money(r.nssf)}</td><td class="r">${money(r.shif)}</td><td class="r">${money(r.housingLevy)}</td><td class="r">${money(r.netPay)}</td>
    </tr>`,
      )
      .join('')}${rows.length === 0 ? '<tr><td colspan="11" class="muted">No payroll entries in this period.</td></tr>' : ''}</tbody>
    <tfoot><tr><td colspan="5">Totals (${rows.length} entr${rows.length === 1 ? 'y' : 'ies'})</td>
      <td class="r">${money(data.grossPayroll)}</td><td class="r">${money(data.totalPaye)}</td><td class="r">${money(data.totalNssf)}</td><td class="r">${money(data.totalShif)}</td><td class="r">${money(data.totalHousingLevy)}</td><td class="r">${money(data.netPayroll)}</td></tr></tfoot>
  </table>
  <p class="muted" style="margin-top:8px">NSSF, SHIF and the housing levy are taken from the employee's pay before PAYE is worked out; PAYE is charged on what is left, less the KES 2,400 personal relief. The employer also pays ${money(data.totalNssfEmployer)} NSSF and ${money(data.totalHousingLevyEmployer)} housing levy on top of these figures. Casual staff carry no statutory deductions. Printed ${fmtDate(new Date().toISOString().slice(0, 10))}.</p>
  <div class="sign"><div>Prepared by</div><div>Approved by</div><div>Date</div></div>`;
  return shell('Payroll', 'landscape', '10mm', body);
}

// ── Payslips: one A4 page per pay entry ─────────────────────────────────────────────────────────────────────────────────────────
function payslipPage(r: PayrollRow, company: CompanySettings): string {
  const casual = r.employeeType === 'Casual';
  const earnings = casual && r.daysWorked != null && r.rate != null ? `${r.daysWorked} day${r.daysWorked === 1 ? '' : 's'} × ${money(r.rate)}` : 'Salary';
  const line = (label: string, v: number) => `<tr><td>${label}</td><td class="r">${money(v)}</td></tr>`;
  return `<div class="page">
  ${header(company, 'PAYSLIP', `Pay date ${fmtDate(r.date)}`)}
  <table style="margin-bottom:10px"><tbody>
    <tr><th style="width:22%">Employee</th><td style="width:28%">${esc(r.name)}</td><th style="width:22%">Employee type</th><td>${esc(r.employeeType)}${r.department ? ` · ${esc(r.department)}` : ''}</td></tr>
    <tr><th>National ID</th><td>${dash(r.nationalId)}</td><th>KRA PIN</th><td>${r.kraPin ? esc(r.kraPin) : casual ? '—' : '<span class="missing">not recorded</span>'}</td></tr>
    <tr><th>SHIF No.</th><td>${dash(r.shifNumber)}</td><th>Paid from</th><td>${esc(r.paymentSource)}</td></tr>
  </tbody></table>
  <div style="display:flex;gap:14px">
    <div style="flex:1"><table><thead><tr><th>Earnings</th><th class="r">KES</th></tr></thead><tbody>
      <tr><td>${esc(earnings)}</td><td class="r">${money(r.grossPay)}</td></tr>
    </tbody><tfoot><tr><td>Gross pay</td><td class="r">${money(r.grossPay)}</td></tr></tfoot></table></div>
    <div style="flex:1"><table><thead><tr><th>Deductions</th><th class="r">KES</th></tr></thead><tbody>
      ${line('NSSF', r.nssf)}${line('SHIF', r.shif)}${line('Affordable housing levy', r.housingLevy)}${line('PAYE (after personal relief)', r.paye)}
    </tbody><tfoot><tr><td>Total deductions</td><td class="r">${money(r.totalDeductions)}</td></tr></tfoot></table></div>
  </div>
  ${casual ? '' : `<p class="muted" style="margin:8px 0 0">PAYE is charged on taxable pay of KES ${money(r.taxablePay)} (gross pay less NSSF, SHIF and the housing levy), less the personal relief. The employer also pays NSSF of KES ${money(r.nssfEmployer)} and housing levy of KES ${money(r.housingLevyEmployer)} on top of your pay.</p>`}
  <table style="margin-top:12px"><tbody><tr><td style="font-size:15px;font-weight:700">NET PAY</td><td class="r" style="font-size:15px;font-weight:700">KES ${money(r.netPay)}</td></tr></tbody></table>
  ${casual ? '<p class="muted">Casual staff carry no statutory deductions.</p>' : ''}
  <div class="sign"><div>Employer</div><div>Employee's signature</div></div>
</div>`;
}

export function buildPayslipsHtml(rows: PayrollRow[], company: CompanySettings): string {
  return shell('Payslips', 'portrait', '14mm', rows.map((r) => payslipPage(r, company)).join('') || '<p>No payroll entries.</p>');
}

// ── P9: one A4 landscape card per employee for the year ─────────────────────────────────────────────────────────────────────────
function p9Page(e: P9Data['employees'][number], data: P9Data): string {
  const s = e.staff;
  const other = [s.firstName, s.middleName].filter(Boolean).join(' ');
  const t = e.totals;
  return `<div class="page">
  <div class="head">
    <div><h1>TAX DEDUCTION CARD — P9</h1><div class="muted">Year ${esc(data.year)} · employee's pay and PAYE, month by month</div></div>
    <div style="text-align:right;font-size:11px">Kenya Revenue Authority — Income Tax<div class="muted">Prepared from the employer's payroll records</div></div>
  </div>
  <table style="margin-bottom:10px"><tbody>
    <tr><th style="width:17%">Employer's name</th><td style="width:33%">${esc(data.employer.name)}</td><th style="width:17%">Employer's PIN</th><td>${data.employer.kraPin ? `<b>${esc(data.employer.kraPin)}</b>` : '<span class="missing">NOT RECORDED — add it under Master Data → Company Info</span>'}</td></tr>
    <tr><th>Employee's main name</th><td>${dash(s.lastName || s.name)}</td><th>Employee's other names</th><td>${dash(other)}</td></tr>
    <tr><th>Employee's PIN</th><td>${s.kraPin ? `<b>${esc(s.kraPin)}</b>` : '<span class="missing">NOT RECORDED</span>'}</td><th>National ID No.</th><td>${s.nationalId ? esc(s.nationalId) : '<span class="missing">NOT RECORDED</span>'}${s.shifNumber ? ` &nbsp;·&nbsp; SHIF No. ${esc(s.shifNumber)}` : ''}</td></tr>
  </tbody></table>
  <table>
    <thead><tr><th>Month</th><th class="r">Gross pay</th><th class="r">NSSF</th><th class="r">SHIF</th><th class="r">Housing levy</th><th class="r">Taxable pay</th><th class="r">Tax charged</th><th class="r">Personal relief</th><th class="r">PAYE tax</th></tr></thead>
    <tbody>${e.months
      .map(
        (m) => `<tr><td>${MONTHS[m.month - 1]}</td><td class="r">${money(m.gross)}</td><td class="r">${money(m.nssf)}</td><td class="r">${money(m.shif)}</td><td class="r">${money(m.housingLevy)}</td><td class="r">${money(m.taxable)}</td><td class="r">${money(m.taxCharged)}</td><td class="r">${money(m.relief)}</td><td class="r">${money(m.paye)}</td></tr>`,
      )
      .join('')}</tbody>
    <tfoot><tr><td>TOTAL</td><td class="r">${money(t.gross)}</td><td class="r">${money(t.nssf)}</td><td class="r">${money(t.shif)}</td><td class="r">${money(t.housingLevy)}</td><td class="r">${money(t.taxable)}</td><td class="r">${money(t.taxCharged)}</td><td class="r">${money(t.relief)}</td><td class="r">${money(t.paye)}</td></tr></tfoot>
  </table>
  <p style="margin:8px 0 0"><b>Total PAYE tax for the year: KES ${money(t.paye)}</b></p>
  <p class="muted" style="margin:4px 0 0">All amounts in Kenya shillings. NSSF, SHIF and the housing levy are deducted from gross pay to give the taxable pay; PAYE is charged on that by the monthly bands and reduced by the personal relief, exactly as it was deducted in the payroll.</p>
  <div class="sign"><div>Employer's signature and stamp</div><div>Date</div></div>
</div>`;
}

export function buildP9Html(data: P9Data, staffId?: number): string {
  const employees = staffId ? data.employees.filter((e) => e.staff.id === staffId) : data.employees;
  return shell(`P9 ${data.year}`, 'landscape', '10mm', employees.map((e) => p9Page(e, data)).join('') || '<p>No pay was logged for employees in this year.</p>');
}
