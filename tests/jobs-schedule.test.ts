import test from 'node:test';
import assert from 'node:assert/strict';
import { nextScheduledAt, parseCron } from '../src/jobs/schedule.ts';

const next = (expression:string,timezone:string,after:string) => nextScheduledAt({type:'cron',expression,timezone},Date.parse(after));

test('cron rejects non-decimal steps and combines stepped wildcard day fields with weekday restrictions',()=>{
  for(const step of ['1e1','0x2','+2','2.0',' 2'])assert.throws(()=>parseCron(`*/${step} * * * *`));
  assert.equal(next('0 0 */1 * MON','UTC','2026-11-17T00:00:00Z'),'2026-11-23T00:00:00.000Z');
  assert.equal(next('0 0 */2 * MON','UTC','2026-11-17T00:00:00Z'),'2026-11-23T00:00:00.000Z');
  assert.equal(next('0 0 1 * */2','UTC','2026-11-17T00:00:00Z'),'2026-12-01T00:00:00.000Z');
  assert.equal(next('0 0 1 * MON','UTC','2026-11-17T00:00:00Z'),'2026-11-23T00:00:00.000Z');
});

test('rare and impossible timezone schedules use bounded calendar work rather than blocking for millions of minutes',t=>{
  const original=Intl.DateTimeFormat.prototype.formatToParts;let calls=0;
  t.mock.method(Intl.DateTimeFormat.prototype,'formatToParts',function(this:Intl.DateTimeFormat,...args:Parameters<typeof original>){
    assert(++calls<1000,'A sparse cron schedule must not format every minute across five years');return original.apply(this,args);
  });
  assert.throws(()=>next('0 0 31 FEB *','Europe/Paris','2026-11-17T00:00:00Z'),/no occurrence/);
  assert.equal(next('0 0 29 FEB *','Europe/Paris','2028-02-29T00:00:00Z'),'2032-02-28T23:00:00.000Z');
});

test('timezone schedules skip nonexistent local times and retain both repeated daylight-saving occurrences',()=>{
  assert.equal(next('30 2 * * *','Europe/Paris','2027-03-28T00:00:00Z'),'2027-03-29T00:30:00.000Z');
  assert.equal(next('30 2 * * *','Europe/Paris','2026-10-25T00:00:00Z'),'2026-10-25T00:30:00.000Z');
  assert.equal(next('30 2 * * *','Europe/Paris','2026-10-25T00:45:00Z'),'2026-10-25T01:30:00.000Z');
  assert.equal(next('30 2 * * *','Europe/Paris','2026-10-25T01:30:00Z'),'2026-10-26T01:30:00.000Z');
  assert.equal(next('*/15 * * * *','Asia/Kathmandu','2026-11-17T00:07:37Z'),'2026-11-17T00:15:00.000Z');
  assert.equal(next('0 0 * * *','America/New_York','2026-11-17T04:59:59Z'),'2026-11-17T05:00:00.000Z');
});
