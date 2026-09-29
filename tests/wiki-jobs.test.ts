import assert from 'node:assert/strict';
import test from 'node:test';
import { runWikiJobs } from '../src/gateway.js';

test('a failed Discord scan does not block approved PR retries', async () => {
  let published = 0;
  const errors: string[] = [];
  await runWikiJobs(async () => { throw new Error('channel deleted'); }, async () => { published++; }, message => errors.push(message));
  assert.equal(published, 1);
  assert.equal(errors.length, 1);
  assert.ok(!errors[0].includes('channel deleted'));
});
