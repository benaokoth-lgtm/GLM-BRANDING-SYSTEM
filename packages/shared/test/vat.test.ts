import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultExpenseVatApplicable } from '../src/tax.ts';

test('materials, stock and ordinary running costs carry VAT by default', () => {
  for (const head of ['Printing Materials & Consumables', 'Transport', 'Utilities', 'Equipment Maintenance', 'Office Supplies', 'Courier/Delivery', 'Airtime/Data', 'Cleaning', 'Outsourced Services']) {
    assert.equal(defaultExpenseVatApplicable(head), true, head);
  }
});

test('wages, bank charges, refreshments, commission, miscellaneous and anything unrecognised do not', () => {
  for (const head of ['Casual Labour', 'Bank Charges', 'Refreshments', 'Sales Commission', 'Miscellaneous', 'Salaries', 'Insurance', 'Something New']) {
    assert.equal(defaultExpenseVatApplicable(head), false, head);
  }
});
