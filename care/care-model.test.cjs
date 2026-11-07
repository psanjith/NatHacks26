const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('./care-model.js');
test('complete request lifecycle preserves the exact message and audit trail', () => {
  let r = m.createRequest('position', 'Adjust my pillow', 100, 'one');
  assert.equal(m.active(r), true);
  for (const [i, status] of ['seen', 'coming', 'done'].entries()) r = m.transition(r, status, 101 + i);
  assert.equal(m.active(r), false);
  assert.equal(r.detail, 'Adjust my pillow');
  assert.deepEqual(r.events.map(e => e.status), ['waiting', 'seen', 'coming', 'done']);
});
test('withdrawn and handled requests cannot be reopened by stale caregiver actions', () => {
  for (const state of ['waiting', 'seen', 'coming']) {
    let r = m.createRequest('device', '', 100, state);
    if (state !== 'waiting') r = m.transition(r, 'seen', 101);
    if (state === 'coming') r = m.transition(r, 'coming', 102);
    const original = r;
    r = m.transition(r, 'withdrawn', 103);
    assert.equal(original.status, state);
    assert.equal(m.active(r), false);
    for (const next of ['seen', 'coming', 'done', 'waiting']) assert.throws(() => m.transition(r, next, 104));
  }
});
test('responses cannot skip acknowledgement; duplicates are rejected', () => {
  let r = m.createRequest('company', '', 100, 'two');
  assert.throws(() => m.transition(r, 'done', 101));
  assert.throws(() => m.transition(r, 'coming', 101));
  r = m.transition(r, 'seen', 101);
  assert.throws(() => m.transition(r, 'seen', 102));
  r = m.transition(r, 'done', 102);
  assert.throws(() => m.transition(r, 'coming', 103));
});
test('reject unknown needs or details; arm help remains a reviewed message', () => {
  assert.throws(() => m.createRequest('unknown', '', 100, 'bad'));
  assert.throws(() => m.createRequest('position', 'not a preset', 100, 'bad'));
  const r = m.createRequest('arm', 'The grasp did not work', 100, 'arm');
  assert.equal(r.status, 'waiting');
  assert.equal(r.detail, 'The grasp did not work');
});
test('local state survives roundtrip and corrupt state is safely discarded', () => {
  const r = m.createRequest('discomfort', 'I feel too cold', 100, 'three');
  assert.deepEqual(m.parseStore(JSON.stringify({ version: 1, requests: [r] })).requests, [r]);
  for (const raw of [null, 'bad json', '{}', '{"version":2,"requests":[]}', '{"version":1,"requests":[null,{}]}']) assert.deepEqual(m.parseStore(raw), { version: 1, requests: [] });
  assert.deepEqual(m.parseStore(JSON.stringify({ version: 1, requests: [{ ...r, message: '<script>bad</script>' }] })).requests, []);
});
