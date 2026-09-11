import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function pin(p: string) {
  return bcrypt.hash(p, 10);
}

async function main() {
  await prisma.filmUsage.deleteMany();
  await prisma.filmRoll.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.orderLineItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.expenseAmendment.deleteMany();
  await prisma.deletionRequest.deleteMany();
  await prisma.expense.deleteMany();
  await prisma.payrollEntry.deleteMany();
  await prisma.pettyCashTopUp.deleteMany();
  await prisma.stockRequisition.deleteMany();
  await prisma.corporateClient.deleteMany();
  await prisma.material.deleteMany();
  await prisma.service.deleteMany();
  await prisma.user.deleteMany();
  await prisma.setting.deleteMany();

  const [amina, brian, grace, financeManager, generalManager, admin] = await Promise.all([
    prisma.user.create({ data: { name: 'Amina Otieno', role: 'Staff', pinHash: await pin('1111') } }),
    prisma.user.create({ data: { name: 'Brian Kimani', role: 'Staff', pinHash: await pin('2222') } }),
    prisma.user.create({ data: { name: 'Grace Wanjiru', role: 'Supervisor', pinHash: await pin('3333') } }),
    prisma.user.create({ data: { name: 'David Kamau', role: 'Finance Manager', pinHash: await pin('4444') } }),
    prisma.user.create({ data: { name: 'Lucy Njeri', role: 'General Manager', pinHash: await pin('5555') } }),
    prisma.user.create({ data: { name: 'Ken Mwangi', role: 'Admin', pinHash: await pin('9999') } }),
  ]);

  const [embroidery, dtf, uv, largeFormat, digital, dtfSheet] = await Promise.all([
    prisma.service.create({ data: { name: 'Embroidery', unit: 'piece', price: 350 } }),
    prisma.service.create({ data: { name: 'DTF Printing', unit: 'piece', price: 250, tracksFilm: true, chargesPressingFee: true } }),
    prisma.service.create({ data: { name: 'UV Printing', unit: 'piece', price: 400 } }),
    prisma.service.create({ data: { name: 'Large Format Printing', unit: 'sqm', price: 600 } }),
    prisma.service.create({ data: { name: 'Digital Printing', unit: 'piece', price: 200 } }),
    prisma.service.create({ data: { name: 'DTF Sheet (per metre)', unit: 'metre', price: 800, tracksFilm: true } }),
  ]);

  const [polo, tshirt, cap, hoodie] = await Promise.all([
    prisma.material.create({ data: { name: 'Polo Shirt', price: 900 } }),
    prisma.material.create({ data: { name: 'T-Shirt', price: 600 } }),
    prisma.material.create({ data: { name: 'Cap', price: 450 } }),
    prisma.material.create({ data: { name: 'Hoodie', price: 1500 } }),
  ]);

  const [zenith, nairobiBottlers] = await Promise.all([
    prisma.corporateClient.create({ data: { name: 'Zenith Sacco', creditDays: 30 } }),
    prisma.corporateClient.create({ data: { name: 'Nairobi Bottlers Ltd', creditDays: 14 } }),
  ]);

  await prisma.setting.create({ data: { id: 1, maxDiscountPct: 15, nextWalkinNo: 1004, nextCorpNo: 2004 } });

  await prisma.order.create({
    data: {
      orderNo: 'W-1001', kind: 'walkin', customerName: 'Peter Mwangi', phone: '0722000001',
      staffId: amina.id, createdDate: '2026-09-02', status: 'Order', stage: 'Completed', paymentTiming: 'onAcceptance',
      orderDiscountPct: 0, orderDiscountAmt: 0,
      lineItems: { create: [
        { itemType: 'material', materialId: polo.id, qty: 20, unitPrice: 900, discountPct: 5, discountAmt: 0 },
        { itemType: 'service', serviceId: embroidery.id, qty: 20, unitPrice: 350, discountPct: 5, discountAmt: 0 },
      ] },
      payments: { create: [
        { date: '2026-09-02', amount: 20000, method: 'Cash', staffId: amina.id },
        { date: '2026-09-05', amount: 3750, method: 'M-Pesa', staffId: amina.id },
      ] },
    },
  });

  await prisma.order.create({
    data: {
      orderNo: 'W-1002', kind: 'walkin', customerName: 'Susan Achieng', phone: '0722000002',
      staffId: brian.id, createdDate: '2026-09-06', status: 'Order', stage: 'In Production', paymentTiming: 'onCompletion',
      orderDiscountPct: 0, orderDiscountAmt: 0,
      lineItems: { create: [{ itemType: 'service', serviceId: dtf.id, materialId: null, qty: 15, unitPrice: 250, discountPct: 0, discountAmt: 0 }] },
    },
  });

  await prisma.order.create({
    data: {
      orderNo: 'W-1003', kind: 'walkin', customerName: 'David Otieno', phone: '0722000003',
      staffId: amina.id, createdDate: '2026-09-08', status: 'Order', stage: 'Order Received', paymentTiming: 'onAcceptance',
      orderDiscountPct: 0, orderDiscountAmt: 0,
      lineItems: { create: [{ itemType: 'per-metre', serviceId: dtfSheet.id, materialId: null, qty: 5, unitPrice: 800, discountPct: 0, discountAmt: 0 }] },
      payments: { create: [{ date: '2026-09-08', amount: 2000, method: 'Cash', staffId: amina.id }] },
    },
  });

  await prisma.order.create({
    data: {
      orderNo: 'C-2001', kind: 'corporate', corporateClientId: zenith.id,
      staffId: brian.id, createdDate: '2026-08-28', status: 'Quote', stage: 'Order Received', dueDate: null,
      orderDiscountPct: 5, orderDiscountAmt: 0,
      lineItems: { create: [
        { itemType: 'material', materialId: polo.id, qty: 100, unitPrice: 900, discountPct: 10, discountAmt: 0 },
        { itemType: 'service', serviceId: embroidery.id, qty: 100, unitPrice: 350, discountPct: 10, discountAmt: 0 },
      ] },
    },
  });

  await prisma.order.create({
    data: {
      orderNo: 'C-2002', kind: 'corporate', corporateClientId: nairobiBottlers.id,
      staffId: amina.id, createdDate: '2026-08-20', status: 'Invoice', stage: 'In Production', dueDate: '2026-09-03',
      orderDiscountPct: 0, orderDiscountAmt: 0,
      lineItems: { create: [{ itemType: 'service', serviceId: largeFormat.id, materialId: null, qty: 40, unitPrice: 600, discountPct: 0, discountAmt: 5000 }] },
      payments: { create: [{ date: '2026-08-22', amount: 10000, method: 'Bank Transfer', staffId: amina.id }] },
    },
  });

  await prisma.order.create({
    data: {
      orderNo: 'C-2003', kind: 'corporate', corporateClientId: zenith.id,
      staffId: brian.id, createdDate: '2026-08-10', status: 'Invoice', stage: 'Completed', dueDate: '2026-09-09',
      orderDiscountPct: 0, orderDiscountAmt: 0,
      lineItems: { create: [
        { itemType: 'material', materialId: cap.id, qty: 50, unitPrice: 450, discountPct: 0, discountAmt: 0 },
        { itemType: 'service', serviceId: uv.id, qty: 50, unitPrice: 550, discountPct: 0, discountAmt: 0 },
      ] },
      payments: { create: [
        { date: '2026-08-12', amount: 25000, method: 'Bank Transfer', staffId: brian.id },
        { date: '2026-09-01', amount: 25000, method: 'Bank Transfer', staffId: brian.id },
      ] },
    },
  });

  // Modest two-month expense ledger so the P&L account isn't empty on first
  // view (a full deterministic history generator, as the design prototype
  // used for its demo, isn't warranted here — a real deployment fills this
  // from actual petty cash entries).
  const expenseBaselines: [string, number][] = [
    ['Salaries & wages', 180000],
    ['Printing Materials & Consumables', 60000],
    ['Casual Labour', 35000],
    ['Transport', 25000],
    ['Utilities', 18000],
    ['Equipment Maintenance', 15000],
    ['Office Supplies', 12000],
    ['Courier/Delivery', 10000],
    ['Refreshments', 8000],
    ['Miscellaneous', 7000],
    ['Airtime/Data', 6000],
    ['Cleaning', 6000],
    ['Bank Charges', 4000],
  ];
  await prisma.expense.createMany({
    data: ['2026-08-05', '2026-09-05'].flatMap((date) => expenseBaselines.map(([category, amount]) => ({ date, category, amount }))),
  });

  console.log('Seeded GLM Branding POS demo data.');
  console.log(
    'PIN logins — Amina Otieno (Staff): 1111 | Brian Kimani (Staff): 2222 | Grace Wanjiru (Supervisor): 3333 | ' +
      'David Kamau (Finance Manager): 4444 | Lucy Njeri (General Manager): 5555 | Ken Mwangi (Admin): 9999',
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
