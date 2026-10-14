// Builds the job-description pages (HTML) for the roles below, in the same layout as GLM-JD-Sales-Employee.html.
// Usage:  node docs/tools/build-job-descriptions.cjs   then print each HTML to PDF (Chrome: --headless=new --print-to-pdf).
// To add a role: add one object to ROLES (see the fields used by `render`), run the script, print the PDF.
const fs = require('fs');
const path = require('path');
const DOCS = path.join(__dirname, '..');
const style = fs.readFileSync(path.join(DOCS, 'GLM-JD-Sales-Employee.html'), 'utf8').match(/<style>[\s\S]*?<\/style>/)[0];

const fill = (note) => `<span class="fill"></span> <span class="note">&nbsp;(${note})</span>`;
const li = (items) => `<ul>\n${items.map((i) => `  <li>${i}</li>`).join('\n')}\n</ul>`;

function render(r) {
  const n = (() => { let i = 0; return () => ++i; })();
  const sec = (title, body) => `\n<h2><span class="n">${n()}</span>${title}</h2>\n${body}\n`;
  const groups = r.resp.map((g) => `<h3>${g.h}</h3>\n${li(g.items)}`).join('\n\n');
  const col = (cls, h, items) => `  <div class="col ${cls}"><h4>${h}</h4><ul>\n${items.map((i) => `    <li>${i}</li>`).join('\n')}\n  </ul></div>`;
  const kpis = `<table>\n  <tr><th style="width:190px">Measure</th><th>What is looked at</th></tr>\n${r.kpis.map(([a, b]) => `  <tr><td><b>${a}</b></td><td>${b}</td></tr>`).join('\n')}\n</table>`;
  const systems = `<table>\n  <tr><th style="width:230px">Where</th><th>For</th></tr>\n${r.systems.map(([a, b]) => `  <tr><td>${a}</td><td>${b}</td></tr>`).join('\n')}\n</table>`;
  const facts = r.facts.map(([a, b]) => `  <tr><td>${a}</td><td>${b}</td></tr>`).join('\n');
  const conduct = [
    "<b>Your PIN is yours.</b> Never share it, never sign in as someone else, and sign out when you leave the screen.",
    "<b>Every record is traceable.</b> The system records who captured, changed or approved each order, payment, expense and claim; accuracy and honesty in what you enter are part of the job.",
    ...r.conduct,
    "<b>Customer and staff information is confidential</b> and used only for the work it was given for.",
    "<b>Raise problems early</b> — a wrong figure, a disputed payment, a control that is not being followed — with your manager.",
  ];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Job Description — ${r.title}</title>
${style.replace(/Job description — Sales Employee/, 'Job description — ' + r.title)}
</head>
<body>
<div class="page">

<div class="head">
  <div class="kicker">GLM Branding · Job description</div>
  <h1>${r.title}</h1>
  <p>${r.tagline}</p>
</div>

<table class="facts">
${facts}
</table>
${sec('Purpose of the role', `<p>${r.purpose}</p>`)}${sec('Key responsibilities', groups)}${sec('Authority and limits', `<p>What you can do in the system is set by your role and is checked on the server at every request.</p>\n<div class="cols">\n${col('ok', 'You can', r.can)}\n${col('ap', r.approve.h || 'You need approval for', r.approve.items)}\n${col('no', 'You cannot', r.cannot)}\n</div>`)}${sec('Performance measures', kpis)}${sec('Remuneration', r.pay)}${sec('Standards and conduct', li(conduct))}${sec('Systems and tools you will use', systems)}${sec('Typical requirements', li(r.reqs))}${sec('Acknowledgement', `<div class="sig">
  <p>I have read and understood this job description, including the responsibilities, limits, performance measures and the way I am paid.</p>
  <div class="line"><span>Name</span><span class="l"></span></div>
  <div class="line"><span>Signature</span><span class="l"></span></div>
  <div class="line"><span>Date</span><span class="l"></span></div>
  <div class="line"><span>Manager</span><span class="l"></span></div>
</div>
<p class="note">This job description summarises the role as it works in the GLM POS &amp; Accounting system. It does not replace your contract of employment, and management may review it.</p>`)}
</div>
</body>
</html>
`;
}

const payFixed = (extra = '') => `<ul>
  <li>A <b>fixed monthly salary</b> as set out in your contract of employment, run through payroll each month with PAYE, NSSF, SHIF and the housing levy deducted; your payslip shows each line.${extra}</li>
  <li>Your salary is recorded on your staff record by Finance (<span class="path">Compliance → Employees</span>).</li>
</ul>`;

const ROLES = [
  // ───────────────────────────── FRONT OFFICE
  {
    file: 'GLM-JD-Front-Office.html',
    title: 'Front Office Officer',
    tagline: 'The first face of the shop: receives customers, captures orders for the sales persons, takes and records every payment, and hands finished work over.',
    facts: [
      ['Job title', 'Front Office Officer <span class="note">(role <i>Front Office</i> in the GLM POS &amp; Accounting system)</span>'],
      ['Department', 'Sales / Front Office'],
      ['Reports to', fill('management to confirm — e.g. Supervisor or General Manager')],
      ['Works with', 'Sales employees and freelance sales persons (whose orders you capture), the Supervisor and Production, Quality Control, Finance'],
      ['Pay basis', 'Fixed monthly salary through payroll. Front Office does not earn sales commission unless your contract says otherwise.'],
      ['Hours, leave, probation', fill('as set out in your contract of employment')],
    ],
    purpose: 'The Front Office Officer is the customer\'s first and last contact. You welcome and direct customers, capture orders for the sales persons and for freelance sales persons, take every payment and record it correctly, issue receipts, keep customers informed, and hand finished orders over once they have passed quality control. You are the control point for money coming in at the counter: what is paid must be recorded, exactly and the same day.',
    resp: [
      { h: 'Welcoming customers and enquiries', items: [
        'Greet and direct customers; answer enquiries on products, prices, timelines and what the customer must bring.',
        'Refer technical or custom requests to the sales person or the Supervisor.',
      ] },
      { h: 'Capturing orders for sales persons', items: [
        'Capture <span class="path">General</span>, <span class="path">Film</span>, <span class="path">Artwork</span> and <span class="path">Embroidery</span> orders in the sales person\'s name — choose the sales person under <b>Who brought this order?</b> — or for a freelance sales person.',
        'Credit a new client to a sales person only when that person confirms they brought the client; a client belongs to one person only.',
        'Price strictly from the price list: services and materials as separate lines, artwork size, heat-press fee, stitch counts, and the supplier\'s quote on contracted-out work. Customer name and phone are recorded for repeat and credited clients.',
      ] },
      { h: 'Taking payment', items: [
        'Take payment by cash, M-Pesa (STK push), bank transfer or card, singly or split, and record each one on the order with its reference.',
        'Record <b>deposits</b> and <b>balances</b> as they arrive. Every shilling received at the counter is entered in the system the same day; nothing is held or accepted outside it.',
        'If an M-Pesa confirmation does not arrive, confirm by hand only with the 10-character code from the customer\'s SMS; a code already used on another payment is refused.',
        'Print the receipt on the 80 mm thermal printer (two copies) and send receipts and invoices by email or WhatsApp where asked.',
        'Work the <span class="path">Payments</span> list of pending balances and remind customers and sales persons of what is owing.',
      ] },
      { h: 'End of day and reconciliation', items: [
        'At close, balance what you received (cash, M-Pesa, bank, card) against the payments recorded in the system, and report any difference at once.',
        'Upload the M-Pesa statement and match payments in <span class="path">Accounting → M-Pesa Matching</span>; refer exceptions you cannot match to Finance.',
      ] },
      { h: 'Handing over and keeping customers informed', items: [
        'Tell customers where their order is (Order Received → In Production → Quality Check → Ready → Completed) and when to collect.',
        'Hand over only orders that have <b>passed quality control</b> (stage <i>Ready for Pickup/Delivery</i>). If a balance is owing, collect it first; hand over on credit only as management allows.',
        'Pass corporate-client requirements to Finance, who prepare quotations and invoices.',
      ] },
    ],
    can: [
      'Capture orders in a sales person\'s name, and for freelancers',
      'See every order',
      'Take and record payments by any method',
      'Confirm an M-Pesa payment by hand, with the SMS code',
      'Print, email or WhatsApp receipts and invoices',
      'Hand over finished orders',
      'Record DTF film sales and artwork jobs',
      'Match M-Pesa payments in Accounting',
    ],
    approve: { items: [
      'Discounts above the standard ceiling (supervisor)',
      'Artwork or embroidery priced below the recommended price (manager)',
      'Refunds, credit notes and corrections to a recorded sale (Finance)',
      'Handing over an order on credit (as management allows)',
      'M-Pesa items you cannot match or that are disputed (Finance)',
    ] },
    cannot: [
      'See supplier costs, mark-ups or other people\'s commission',
      'Open Finance, Compliance or the rest of Accounting',
      'Change prices, bands, settings or staff',
      'Edit or delete a recorded payment',
      'Approve your own approvals',
    ],
    kpis: [
      ['Payment accuracy', 'Every payment recorded the same day, with the right method and reference; no unrecorded or duplicated payments.'],
      ['End-of-day balance', 'Cash, M-Pesa, bank and card received agree with the system; differences reported straight away.'],
      ['Order capture accuracy', 'Orders captured correctly the first time, credited to the right sales person, with few amendments or credit notes.'],
      ['M-Pesa matching', 'Statement uploaded and matched promptly; exceptions cleared with Finance.'],
      ['Balances followed up', 'Pending balances on orders chased and cleared; amounts outstanding at month-end.'],
      ['Hand-over discipline', 'No order handed over before quality control passes, or without the balance being settled or credit approved.'],
      ['Customer service', 'Customers kept informed; queries answered and passed on promptly.'],
    ],
    pay: payFixed(),
    conduct: [
      '<b>Money is recorded as it is received.</b> No side payments, no holding customer money outside the system, no unrecorded discounts.',
      '<b>Credit the sale to the right person.</b> Never move an order to another sales person, or to a freelancer, to give or deny credit.',
    ],
    systems: [
      ['<span class="path">General / Film / Artwork / Embroidery Order</span>', 'Capturing orders for sales persons and freelancers'],
      ['<span class="path">All Orders</span>', 'Every order, its status and balance; receipts and hand-over'],
      ['<span class="path">Payments</span>', 'Pending and settled payments'],
      ['<span class="path">Accounting → M-Pesa Matching</span>', 'Matching the M-Pesa statement to orders'],
      ['80 mm thermal printer, phone and WhatsApp', 'Receipts (two copies) and customer communication'],
    ],
    reqs: [
      'Excellent customer care, a calm manner and clear communication.',
      'Numeracy and care with money: cash handling, change, M-Pesa and balancing at close.',
      'Accuracy and honesty in recording; comfortable with a computer or tablet and a till-style screen — training is given.',
      'Organised and able to handle several customers and calls at once.',
      'Experience in reception, cashiering or retail is an advantage.',
    ],
  },

  // ───────────────────────────── GENERAL MANAGER
  {
    file: 'GLM-JD-General-Manager.html',
    title: 'General Manager',
    tagline: 'Runs the business end to end — sales, production, stock, finance and people — and is accountable for profit, cash and compliance.',
    facts: [
      ['Job title', 'General Manager <span class="note">(role <i>General Manager</i> in the GLM POS &amp; Accounting system)</span>'],
      ['Department', 'Management'],
      ['Reports to', fill('owner / board — management to confirm')],
      ['Direct reports', fill('e.g. Finance Manager, Supervisor, Front Office, Sales employees — management to confirm')],
      ['Pay basis', 'As set out in your contract of employment, through payroll with statutory deductions.'],
      ['Hours, leave, probation', fill('as set out in your contract of employment')],
    ],
    purpose: 'The General Manager is accountable for the whole business: that it sells at the right prices, makes what it sells on time and to standard, buys well, collects its money, pays what it owes when it is due, and makes a profit. You set direction with the owner, lead the Finance Manager, Supervisor, Front Office and sales team, take the decisions that need seniority, and use the system\'s reports to see where the business stands and where to act.',
    resp: [
      { h: 'Profit and performance', items: [
        'Review the <span class="path">Profit &amp; Loss</span> (accrual and cash) and <span class="path">Reports → Sales by Business Head</span> every month: sales, cost and margin for DTF, UV, embroidery, large format and laser. Decide where to push, reprice or stop.',
        'Review <span class="path">DTF → Dashboard</span> (roll profit, wastage, what discounts cost) and <span class="path">Reports → Embroidery Profitability</span>.',
        'Set targets with the owner and track them; keep the monthly sales floor and the sales team\'s results in front of the sales staff.',
      ] },
      { h: 'Sales and people', items: [
        'Review staff results in <span class="path">Commission → Team &amp; payouts</span> and the <span class="path">Monthly report</span>; coach anyone marked <b>needs improvement</b> and agree a plan with them.',
        'Approve each month\'s commission so pay-band staff go into payroll <b>before payday (the 5th)</b>; recommend any change to the bands, target or minimum wage to the Admin, who alone sets them.',
        'Lead, coach and appraise your direct reports; recommend hiring, role changes and training.',
      ] },
      { h: 'Operations: production, quality and delivery', items: [
        'Oversee the production queue and who is assigned what (<span class="path">Production</span>), including outsourced jobs and suppliers; keep promised delivery dates.',
        'Review <span class="path">Quality Control</span> results: pass rate, failures and rework; act on recurring defects.',
        'Manage supplier relationships and costs; review the quotes and mark-ups on contracted-out work.',
      ] },
      { h: 'Stock and purchasing', items: [
        'Act on reorder alerts; approve or reject purchase requisitions (never your own); review purchase reconciliation variances and stock-take differences.',
        'Keep the import and purchasing decisions (e.g. China imports) inside what the landed cost and margin allow.',
      ] },
      { h: 'Money and compliance oversight', items: [
        'Review receivables ageing and payables, cash flow and the petty-cash position; decide on credit terms for corporate clients.',
        'Make sure statutory payments are made on time: PAYE, SHIF and the housing levy by the 9th, NSSF by the 15th, VAT and withholding tax by the 20th, and income-tax instalments — the monthly <span class="path">Compliance → Payments due</span> total is the cheque to write.',
        'Review the VAT position, the corporation-tax or turnover-tax schedule and the payroll with the Finance Manager.',
      ] },
      { h: 'Approvals and control', items: [
        'Decide DTF artwork and embroidery price approvals and discount exceptions, never for work you captured yourself.',
        'Approve (as the second person) expense, payroll and petty-cash amendments and deletions raised by others; never approve your own.',
        'Keep the controls working: segregation of duties, supporting documents, and follow-up of exceptions. Ask the Admin for the audit log and for backups to be confirmed.',
      ] },
    ],
    can: [
      'See every order and every report',
      'See supplier costs and mark-ups',
      'Open Finance, Compliance, Accounting and Reports',
      'Assign and manage production; open Quality Control',
      'Approve stock requisitions',
      'Manage DTF rolls, costs and price approvals',
      'Approve commission months and payouts',
      'Capture expenses, payroll, quotations and invoices',
    ],
    approve: { h: 'You need a second person for', items: [
      'Amending or deleting an expense, payroll entry or petty-cash top-up you raised',
      'Receiving a purchase you captured',
      'A price approval or requisition you raised yourself',
      'Anything involving your own pay',
    ] },
    cannot: [
      'Open Master Data: staff, roles, price lists, discount rules, company details, integrations, backups, security',
      'Change commission bands, target, minimum wage or payday (Admin only)',
      'Approve your own requests',
      'Delete a recorded sale',
    ],
    kpis: [
      ['Profitability', 'Net profit and margin, in total and by line of business (P&amp;L, Sales by Business Head).'],
      ['Sales', 'Total net sales against target; the share of the sales team at or above the monthly floor.'],
      ['Cash and collections', 'Cash position; receivables ageing; amounts overdue; petty cash never short.'],
      ['Delivery and quality', 'Orders delivered on time; quality-control pass rate; rework and rejected units.'],
      ['Stock', 'Stock-outs avoided; purchase and stock-take variances; reorder alerts acted on.'],
      ['Compliance', 'Every statutory payment and return made by its date; no penalties.'],
      ['Control', 'Approvals turned around promptly; no self-approval; books check clean at month-end.'],
      ['People', 'Team performance, retention and development.'],
    ],
    pay: `<ul>
  <li>Your pay is set out in your contract of employment and run through payroll each month, with PAYE, NSSF, SHIF and the housing levy deducted.</li>
  <li>Any bonus, allowance or incentive arrangement is as agreed in writing with the owner.</li>
</ul>`,
    conduct: [
      '<b>You set the example.</b> Follow the same controls as everyone else: no approving your own requests, no off-system money, no exceptions to the pricing rules without a recorded approval.',
      '<b>Decisions leave a trace.</b> Approvals, price exceptions and commission decisions are recorded in the system with your name; make them on the facts.',
    ],
    systems: [
      ['<span class="path">Accounting</span> — Profit &amp; Loss, Balance Sheet, Cash Flow, Receivables, Payables', 'Seeing where the business stands'],
      ['<span class="path">Reports</span>', 'Sales, Sales by Business Head, by Category, Embroidery Profitability'],
      ['<span class="path">DTF</span>', 'Roll profit, wastage, discounts, price approvals'],
      ['<span class="path">Commission</span>', 'Team results, monthly report, approving months and payouts'],
      ['<span class="path">Production</span> and <span class="path">Quality Control</span>', 'Workload, outsourced jobs, pass rates'],
      ['<span class="path">Stock</span>', 'Requisitions, approvals, purchases, reconciliation, stock take'],
      ['<span class="path">Finance</span> and <span class="path">Compliance</span>', 'Expenses, petty cash, payroll, VAT, Payments due, income tax'],
    ],
    reqs: [
      'A degree or diploma in business, commerce or a related field, or equivalent experience.',
      'Experience managing a business or department, ideally in printing, manufacturing, branding or retail.',
      'Able to read and act on a profit and loss, a cash flow and a receivables ageing.',
      'Working knowledge of Kenyan statutory requirements: VAT, PAYE, NSSF, SHIF, the housing levy and income tax.',
      'Leadership, sound judgement, integrity and good communication with staff, customers and suppliers.',
    ],
  },

  // ───────────────────────────── FINANCE MANAGER
  {
    file: 'GLM-JD-Finance-Manager.html',
    title: 'Finance Manager',
    tagline: 'Keeps the money and the books: collections, payments, expenses, payroll, statutory returns and the monthly close.',
    facts: [
      ['Job title', 'Finance Manager <span class="note">(role <i>Finance Manager</i> in the GLM POS &amp; Accounting system)</span>'],
      ['Department', 'Finance'],
      ['Reports to', fill('General Manager — management to confirm')],
      ['Works with', 'General Manager, Front Office (daily payments), Supervisor (stock), Admin (settings and backups), the external accountant and KRA, NSSF and SHA contacts'],
      ['Pay basis', 'As set out in your contract of employment, through payroll with statutory deductions.'],
      ['Hours, leave, probation', fill('as set out in your contract of employment')],
    ],
    purpose: 'The Finance Manager is responsible for the accuracy of the books and for the business\'s money: that every sale and payment is recorded, customers pay on time, suppliers and staff are paid correctly, statutory payments and returns are made by their due dates, and the books are closed and reported each month. The system posts the books from the day\'s work; your job is to make sure the inputs are right, the controls are followed, and the monthly figures can be relied on.',
    resp: [
      { h: 'Collections and credit control', items: [
        'Prepare <b>quotations</b> and <b>invoices</b> for corporate clients (<span class="path">Finance → Quotation / Invoice</span>) and keep the <span class="path">Corporate Clients</span> register — credit days, contacts — up to date.',
        'Work the <span class="path">Receivables</span> ageing: chase overdue invoices, agree payment plans, and escalate to the General Manager.',
        'Issue <b>credit notes</b> and <b>debit notes</b> (itemised, restocked where goods return) with the right approval; never alter a recorded sale.',
        'Reconcile payments: M-Pesa matching, NCBA notifications, bank and card receipts against the orders; clear exceptions daily.',
      ] },
      { h: 'Expenses, suppliers and petty cash', items: [
        'Capture <b>expenses</b> under the right head, with the business head, VAT treatment and withholding tax; record supplier bills on credit with the supplier, invoice number and due date, and pay them by the due date (<span class="path">Owed / Due</span>).',
        'Manage the <b>petty-cash float</b>: top-ups, and that the float covers wages and purchases on the dates they fall.',
        'Raise <b>amendments</b> and <b>deletion requests</b> with a reason for wrong entries; they are decided by a different manager. Keep the supporting invoices and receipts.',
        'Review the <span class="path">Payables</span> ageing and supplier terms with the General Manager.',
      ] },
      { h: 'Purchases and stock accounting', items: [
        'Approve or reject purchase requisitions (never your own); check each purchase against the supplier\'s invoice and the quantity received.',
        'Review <span class="path">Purchases Reconciliation</span> variances (price and quantity) and stock-take differences; investigate and report.',
        'Cost imports with the landed-cost calculator before prices are set.',
      ] },
      { h: 'Payroll and staff pay', items: [
        'Keep each employee\'s National ID, KRA PIN, SHIF number and gross salary on record (<span class="path">Compliance → Employees</span>).',
        'Enter the monthly <b>payroll</b> for fixed-salary employees and casuals, print the register and payslips, and issue the <b>P9</b> at year end.',
        'Approve each month in <span class="path">Commission → Team &amp; payouts</span> so pay-band staff go into payroll — with the minimum wage applied — <b>before payday (the 5th)</b>; pay commission and freelance payouts, with withholding tax deducted.',
      ] },
      { h: 'Statutory compliance', items: [
        'Prepare the <b>VAT</b> position (output less input) each month and pay by the 20th.',
        'Use <span class="path">Compliance → Payments due</span> to write the monthly cheque: PAYE, SHIF and the housing levy by the 9th, NSSF by the 15th, VAT and withholding tax by the 20th, and income-tax instalments; record each remittance as a journal.',
        'Maintain the <b>corporation-tax</b> (or turnover-tax) schedule: enter the adjustments, estimate and capital allowances, and record each payment to KRA with its reference. Confirm treatment with the external accountant.',
      ] },
      { h: 'Accounting and month-end close', items: [
        'Keep the chart of accounts, <b>journals</b> (opening balances, adjustments, remittances), the <b>asset register</b> and depreciation correct.',
        'At month-end: all orders paid or invoiced, all expenses recorded, payroll entered, stock counted, M-Pesa matched, then run <span class="path">Books Check</span> until clean.',
        'Produce the monthly pack for the General Manager: Profit &amp; Loss, Balance Sheet, Cash Flow, Receivables, Payables, VAT position, payroll and commission cost, and margin by line of business.',
      ] },
      { h: 'Control', items: [
        'Apply segregation of duties: you do not approve your own requests or receive purchases you captured.',
        'Report anomalies and any shortfall or difference at once; keep the audit trail clean.',
      ] },
    ],
    can: [
      'Open Finance, Compliance, Accounting and Reports',
      'See every order and all supplier costs',
      'Capture expenses, payroll, quotations and invoices',
      'Issue credit and debit notes; post journals',
      'Approve stock requisitions; receive purchases',
      'Manage DTF rolls and price approvals',
      'Approve commission months and pay them',
      'Manage petty cash, assets and corporate clients',
    ],
    approve: { h: 'You need a second person for', items: [
      'Amending or deleting an expense, payroll entry or petty-cash top-up you raised',
      'Receiving a purchase you captured',
      'A requisition or price approval you raised yourself',
      'Anything involving your own pay',
    ] },
    cannot: [
      'Open Master Data: staff, roles, price lists, integrations, backups, security',
      'Change commission bands, target, minimum wage or payday (Admin only)',
      'Approve your own requests',
      'Delete or change a recorded sale',
    ],
    kpis: [
      ['Books accuracy', '<b>Books Check</b> clean at every month-end; no unexplained differences.'],
      ['Close on time', 'Month closed, commission approved and payroll ready <b>before payday (the 5th)</b>.'],
      ['Statutory compliance', 'PAYE, SHIF, housing levy, NSSF, VAT, withholding tax and income-tax instalments paid by their dates; no penalties.'],
      ['Collections', 'Receivables overdue and days outstanding; credit notes and disputes resolved.'],
      ['Payables', 'Supplier bills paid by their due dates; no surprises in Owed.'],
      ['Cash control', 'Petty cash never short; reconciliations (M-Pesa, bank, purchases) cleared promptly.'],
      ['Payroll accuracy', 'Right pay and deductions each month; payslips and P9 delivered on time.'],
      ['Reporting', 'Monthly pack to the General Manager on time, accurate and clear.'],
    ],
    pay: `<ul>
  <li>Your pay is set out in your contract of employment and run through payroll each month, with PAYE, NSSF, SHIF and the housing levy deducted. As you handle payroll, your own pay should be processed and approved by someone else.</li>
  <li>Any bonus, allowance or incentive arrangement is as agreed in writing with the General Manager or owner.</li>
</ul>`,
    conduct: [
      '<b>Accuracy and timeliness.</b> Statutory dates and the 5th-of-the-month payday are not negotiable; plan the close around them.',
      '<b>Segregation of duties.</b> Never approve your own entries, receive your own purchases or process your own pay.',
      '<b>Keep the paper trail.</b> Every expense, bill and remittance has its supporting document and its reference in the system.',
    ],
    systems: [
      ['<span class="path">Finance</span> — Quotation, Invoice, Payments, Expenses, Petty Cash, Asset Register, Corporate Clients', 'Money in and out, credit control, assets'],
      ['<span class="path">Compliance</span> — VAT, Payments due, Corporation tax, NSSF, SHIF, Payroll, Employees, P9', 'Statutory work and payroll'],
      ['<span class="path">Accounting</span>', 'Statements, receivables and payables, notes, M-Pesa matching, depreciation, journals, ledger, trial balance, Books Check'],
      ['<span class="path">Stock</span>', 'Requisition approval, purchases, reconciliation, stock take, import costing'],
      ['<span class="path">Commission</span>', 'Approving months and paying commission'],
      ['<span class="path">Reports</span>', 'Sales, Sales by Business Head, Embroidery Profitability'],
    ],
    reqs: [
      'A professional accounting qualification (for example CPA(K) or ACCA) or a degree in accounting or finance.',
      'Experience keeping books and closing months, with reconciliations, receivables and payables.',
      'Good working knowledge of Kenyan tax and statutory deductions: VAT, PAYE, NSSF, SHIF, the housing levy, withholding tax and corporation or turnover tax.',
      'Proficient with accounting software and spreadsheets; careful, deadline-driven and discreet with confidential information.',
      'Integrity and sound judgement; able to explain figures to non-finance colleagues.',
    ],
  },
];

for (const r of ROLES) {
  fs.writeFileSync(path.join(DOCS, r.file), render(r));
  console.log('written', r.file);
}
