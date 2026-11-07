const test = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('./game.js');
function place(game, zone) {
  assert.equal(game.select(zone), true);
  const action = game.confirm();
  if (action.player === 1) assert.equal(game.motionComplete(action.id), true);
  assert.equal(game.resolve(action.id, true), true);
  return action;
}
test('A full match consumes exactly 12 tokens and settles territory majorities', () => {
  const game = new Game('match');
  for (let i = 0; i < 6; i++) { place(game, i < 3 ? 'A' : 'B'); place(game, 'C'); }
  assert.deepEqual(game.scores(), { 1: 7, 2: 5 });
  assert.deepEqual(game.snapshot().remaining, { 1: 0, 2: 0 });
  assert.equal(game.snapshot().phase, 'finished');
  assert.equal(game.select('A'), false);
});
test('Tied territories award neither player any points', () => {
  const game = new Game('tie');
  for (let i = 0; i < 6; i++) { place(game, 'A'); place(game, 'A'); }
  assert.deepEqual(game.scores(), { 1: 0, 2: 0 });
});
test('Motion completion alone never consumes a token or advances a turn', () => {
  const game = new Game('motion');
  game.select('B'); const action = game.confirm();
  assert.equal(game.resolve(action.id, true), false);
  assert.equal(game.select('C'), false);
  assert.equal(game.confirm(), null);
  assert.equal(game.newGame(), false);
  game.motionComplete(action.id);
  assert.equal(game.snapshot().player, 1);
  assert.equal(game.snapshot().remaining[1], 6);
  assert.equal(game.newGame(), false);
});
test('Failed placement and retry preserve the turn and reject stale or duplicate outcomes', () => {
  const game = new Game('retry');
  game.select('A'); const first = game.confirm();
  game.motionComplete(first.id); game.resolve(first.id, false);
  assert.equal(game.snapshot().remaining[1], 6);
  const retry = game.confirm();
  assert.notEqual(retry.id, first.id);
  game.motionComplete(retry.id);
  assert.equal(game.resolve(first.id, true), false);
  assert.equal(game.resolve(retry.id, 'true'), false);
  assert.equal(game.resolve(retry.id, true), true);
  assert.equal(game.resolve(retry.id, true), false);
  assert.equal(game.snapshot().territories.A[1], 1);
});
test('Interruption locks progress until the pending outcome is explicitly reconciled', () => {
  const game = new Game('pause');
  game.select('C'); const action = game.confirm(); game.pause();
  assert.equal(game.newGame(), false);
  assert.equal(game.select('B'), false);
  assert.equal(game.motionComplete(action.id), false);
  assert.equal(game.resolve(action.id, true), false);
  assert.equal(game.reconcile(), false);
  assert.equal(game.reconcile(true), true);
  assert.equal(game.snapshot().territories.C[1], 1);
  assert.equal(game.resolve(action.id, true), false);
});
test('Unplaced interruption recovery preserves tokens; idle pause can resume', () => {
  const game = new Game('miss');
  game.pause(); assert.equal(game.reconcile(), true);
  game.select('B'); game.confirm(); game.pause(); game.reconcile(false);
  assert.equal(game.snapshot().remaining[1], 6);
  assert.equal(game.snapshot().player, 1);
  assert.equal(game.snapshot().phase, 'failed');
  assert.ok(game.confirm());
});
test('Player 2 places manually; new games switch starter and isolate old results', () => {
  const game = new Game('manual');
  const old = place(game, 'A');
  game.select('B'); const second = game.confirm();
  assert.equal(game.snapshot().phase, 'awaiting_result');
  game.resolve(second.id, true);
  game.newGame();
  assert.equal(game.snapshot().player, 2);
  game.select('C'); const fresh = game.confirm();
  assert.notEqual(fresh.id, second.id);
  assert.equal(game.resolve(old.id, true), false);
  assert.equal(game.resolve(fresh.id, true), true);
});
test('Invalid targets and cancellation cannot mutate committed game state', () => {
  const game = new Game('valid');
  assert.equal(game.select('D'), false);
  assert.equal(game.select('__proto__'), false);
  assert.equal(game.confirm(), null);
  game.select('A'); game.cancel();
  assert.equal(game.snapshot().selected, null);
  assert.deepEqual(game.snapshot().remaining, { 1: 6, 2: 6 });
  const view = game.snapshot(); view.remaining[1] = -10;
  assert.equal(game.snapshot().remaining[1], 6);
});
