import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyOutput, orderUnits, staffProductivity, type CheckFact, type TaskFact } from '../src/production.ts';

const task = (o: Partial<TaskFact> & { id: number; assigneeId: number }): TaskFact => ({
  assignedAt: '2031-03-10T08:00:00.000Z',
  startedAt: '2031-03-10T09:00:00.000Z',
  finishedAt: '2031-03-10T13:00:00.000Z',
  status: 'Finished',
  isRework: false,
  unitsPlanned: 100,
  unitsCompleted: 100,
  ...o,
});

test('a job is worth the sum of its line quantities', () => {
  assert.equal(orderUnits([{ qty: 10 }, { qty: 2.5 }, { qty: 0 }]), 12.5);
});

test('output, planned units and average turnaround count jobs finished in the period', () => {
  const tasks = [
    task({ id: 1, assigneeId: 7, unitsCompleted: 90 }), // 4h
    task({ id: 2, assigneeId: 7, startedAt: null, finishedAt: '2031-03-11T10:00:00.000Z' }), // from assignment: 26h
    task({ id: 3, assigneeId: 7, finishedAt: '2031-04-02T10:00:00.000Z' }), // outside March
    task({ id: 4, assigneeId: 8, unitsCompleted: 40, unitsPlanned: 50 }),
  ];
  const [a, b] = ['7', '8'].map((id) => staffProductivity(tasks, [], '2031-03-01', '2031-03-31').find((r) => r.assigneeId === Number(id))!);
  assert.equal(a!.jobsFinished, 2);
  assert.equal(a!.unitsCompleted, 190);
  assert.equal(a!.unitsPlanned, 200);
  assert.equal(a!.avgHours, 15); // (4 + 26) / 2
  assert.equal(b!.unitsCompleted, 40);
});

test('quality is measured on first-time work; a failure stays against the first attempt even after rework', () => {
  const tasks = [
    task({ id: 1, assigneeId: 7 }), // passes first time
    task({ id: 2, assigneeId: 7 }), // fails…
    task({ id: 3, assigneeId: 7, isRework: true, finishedAt: '2031-03-12T09:00:00.000Z' }), // …is reworked and passes
  ];
  const checks: CheckFact[] = [
    { taskId: 1, result: 'Passed', unitsRejected: 0 },
    { taskId: 2, result: 'Failed', unitsRejected: 12 },
    { taskId: 3, result: 'Passed', unitsRejected: 0 },
  ];
  const r = staffProductivity(tasks, checks, '2031-03-01', '2031-03-31')[0]!;
  assert.equal(r.checked, 2); // the rework is not counted as first-time work
  assert.equal(r.passedFirstTime, 1);
  assert.equal(r.firstPassPct, 50);
  assert.equal(r.failedChecks, 1);
  assert.equal(r.rejectedUnits, 12);
  assert.equal(r.jobsFinished, 3); // the rework still counts as output when finished
});

test('jobs in hand are counted as active, not as output', () => {
  const tasks = [task({ id: 1, assigneeId: 7, status: 'In Progress', finishedAt: null, unitsCompleted: null }), task({ id: 2, assigneeId: 7, status: 'Assigned', startedAt: null, finishedAt: null, unitsCompleted: null })];
  const r = staffProductivity(tasks, [], '2031-03-01', '2031-03-31')[0]!;
  assert.equal(r.active, 2);
  assert.equal(r.jobsFinished, 0);
  assert.equal(r.avgHours, null);
  assert.equal(r.firstPassPct, null);
});

test('daily output adds up units and jobs per day, in date order', () => {
  const tasks = [
    task({ id: 1, assigneeId: 7, unitsCompleted: 30, finishedAt: '2031-03-11T10:00:00.000Z' }),
    task({ id: 2, assigneeId: 8, unitsCompleted: 20, finishedAt: '2031-03-10T10:00:00.000Z' }),
    task({ id: 3, assigneeId: 8, unitsCompleted: 5, finishedAt: '2031-03-11T15:00:00.000Z' }),
  ];
  assert.deepEqual(dailyOutput(tasks, '2031-03-01', '2031-03-31'), [
    { date: '2031-03-10', units: 20, jobs: 1 },
    { date: '2031-03-11', units: 35, jobs: 2 },
  ]);
});
