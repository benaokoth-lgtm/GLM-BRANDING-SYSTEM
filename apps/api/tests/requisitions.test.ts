import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db';
import { ensureRequisitions, formatRequisitionRef, nextRequisitionNumber } from '../src/requisitions';

describe('stock requisitions', () => {
  after(() => prisma.$disconnect());

  it('give an old single-line requisition a reference and turn its material into a line', async () => {
    const mat = await prisma.material.create({ data: { name: 'Thread (req test)', price: 100 } });
    // an old-style requisition: one material and quantity, no reference
    const legacy = await prisma.stockRequisition.create({ data: { materialId: mat.id, qty: 12, requestedByName: 'old' } });
    await ensureRequisitions();
    const converted = await prisma.stockRequisition.findUniqueOrThrow({ where: { id: legacy.id }, include: { lines: true } });
    assert.match(converted.ref ?? '', /^REQ-\d{4}$/);
    assert.equal(converted.lines.length, 1);
    assert.equal(converted.lines[0]!.qty, 12);
    await ensureRequisitions(); // running it again changes nothing
    assert.equal(await prisma.stockRequisitionLine.count({ where: { requisitionId: legacy.id } }), 1);
  });

  it('number new multi-line requisitions one after another', async () => {
    const a = await prisma.material.create({ data: { name: 'Caps (req test)', price: 300 } });
    const b = await prisma.material.create({ data: { name: 'Film (req test)', price: 900 } });
    const n = await nextRequisitionNumber();
    const multi = await prisma.stockRequisition.create({
      data: { ref: formatRequisitionRef(n), requestedByName: 'x', lines: { create: [{ materialId: a.id, qty: 5 }, { materialId: b.id, qty: 20 }] } },
      include: { lines: true },
    });
    assert.equal(multi.ref, formatRequisitionRef(n));
    assert.equal(multi.lines.length, 2);
    assert.equal(await nextRequisitionNumber(), n + 1);
  });
});
