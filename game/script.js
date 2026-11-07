'use strict';
// UI and local demo adapter. Real backend integration is intentionally separate.
const game = new ReachRules.Game();
const $ = (id) => document.getElementById(id);
const targets = {};
for (const [zone, value] of Object.entries(ReachRules.VALUES)) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'territory';
  button.id = `target-${zone.toLowerCase()}`;
  button.innerHTML = `<span class="territory-letter">ZONE ${zone}</span><span class="territory-value">${value} <small>points</small></span><span class="count-line p1"><span>● P1</span><strong id="count-${zone}-1">0</strong></span><span class="count-line p2"><span>■ P2</span><strong id="count-${zone}-2">0</strong></span><span class="territory-leader" id="leader-${zone}">Tied</span>`;
  button.addEventListener('click', () => selectTarget(zone));
  $('territories').append(button);
  targets[zone] = button;
}

function addLog(message) {
  const entry = document.createElement('li');
  const time = document.createElement('time');
  const now = new Date();
  time.dateTime = now.toISOString();
  time.textContent = now.toLocaleTimeString('en-GB');
  entry.append(time, document.createTextNode(message));
  $('activity-log').prepend(entry);
  if ($('activity-log').children.length > 20) $('activity-log').lastElementChild.remove();
}

function updateInterface() {
  const s = game.snapshot();
  const score = game.scores();
  const canSelect = ['idle', 'selected', 'failed'].includes(s.phase);
  const finished = s.phase === 'finished';
  const messages = {
    idle: `Player ${s.player}: choose A, B, or C.`,
    selected: `Zone ${s.selected} selected. Confirm when you are ready.`,
    running: 'Simulated arm movement in progress. Other moves are locked.',
    awaiting_result: s.player === 1
      ? 'Motion finished. Operator: verify where the token landed.'
      : `Player 2: place one token in Zone ${s.selected}, then confirm below.`,
    failed: 'Token not placed. Retry this placement or choose another territory. No token was spent.',
    paused: 'Demo paused. Verify the pending placement before continuing.',
    finished: score[1] === score[2] ? 'The game is a draw.' : `Player ${score[1] > score[2] ? 1 : 2} wins.`
  };
  $('status-label').textContent = messages[s.phase];
  $('workflow-title').textContent = finished ? 'Game complete' : `Player ${s.player}'s turn`;
  $('selected-target-label').textContent = s.selected || '—';
  $('move-label').textContent = finished ? '12 / 12 placed' : `Move ${13 - s.remaining[1] - s.remaining[2]} / 12`;
  $('score-heading').textContent = finished ? 'Final score' : 'If the game ended now';
  $('score-label').textContent = `P1 ${score[1]} — ${score[2]} P2`;
  $('score-note').textContent = finished ? 'All tokens placed. Choose New game to play again.' : 'Provisional points. The final score is settled after all 12 placements.';
  for (const player of [1, 2]) {
    $(`remaining-${player}`).textContent = s.remaining[player];
    $(`player-${player}`).classList.toggle('active', s.player === player && !finished);
    $(`tag-${player}`).hidden = s.player !== player || finished;
  }
  for (const [zone, button] of Object.entries(targets)) {
    const counts = s.territories[zone];
    button.disabled = !canSelect;
    button.classList.toggle('selected', s.selected === zone);
    button.setAttribute('aria-pressed', String(s.selected === zone));
    button.setAttribute('aria-label', `Zone ${zone}, ${ReachRules.VALUES[zone]} points. Player 1: ${counts[1]} tokens. Player 2: ${counts[2]} tokens.`);
    for (const player of [1, 2]) $(`count-${zone}-${player}`).textContent = counts[player];
    $(`leader-${zone}`).textContent = counts[1] === counts[2] ? 'Tied · no points' : `P${counts[1] > counts[2] ? 1 : 2} ${finished ? 'wins' : 'leads'}`;
  }
  $('confirm-button').disabled = !['selected', 'failed'].includes(s.phase);
  $('confirm-button').textContent = s.phase === 'failed' ? 'Retry placement' : s.player === 1 ? 'Confirm simulated move' : 'Confirm territory';
  $('cancel-button').disabled = !['selected', 'failed'].includes(s.phase);
  $('motion-button').disabled = s.phase !== 'running';
  $('success-button').disabled = s.phase !== 'awaiting_result';
  $('failure-button').disabled = s.phase !== 'awaiting_result';
  $('pause-button').disabled = ['paused', 'finished'].includes(s.phase);
  $('reset-button').disabled = Boolean(s.pending) || s.phase === 'paused';
  $('action-label').textContent = s.pending?.id || 'None';
  $('operator-help').textContent = s.phase === 'running'
    ? 'Simulate the end of motion, then verify placement. Motion completion alone does not change the board.'
    : s.phase === 'awaiting_result' ? `Verify one Player ${s.player} token in Zone ${s.selected}. Success advances the turn; failure allows a retry.`
    : 'This demo requires explicit confirmation for both players. No automatic success or scoring.';
  $('placement-help').textContent = s.player === 1
    ? 'Use the territory buttons to simulate a selection. Flickering targets and EEG are not connected.'
    : 'Player 2 uses the same territory choices, then places a token by hand. No robot movement is requested.';
  $('recovery').hidden = s.phase !== 'paused';
  $('recover-placed').hidden = !s.pending;
  $('recover-missed').hidden = !s.pending;
  $('resume-button').hidden = Boolean(s.pending);
  $('recovery-help').textContent = s.pending
    ? `Pending: Player ${s.pending.player}, Zone ${s.pending.zone}. Check the board and record whether this token was placed. In a live integration, the backend must also confirm the arm has stopped.`
    : 'There is no pending placement. The local demo can resume.';
}

function run(change, message, focusId) {
  const result = change();
  if (!result) return false;
  addLog(message);
  updateInterface();
  if (focusId && !$(focusId).disabled && !$(focusId).hidden) $(focusId).focus();
  return result;
}
function selectTarget(zone) { return run(() => game.select(zone), `Selected Zone ${zone}.`); }
function confirmSelection() {
  const action = run(() => game.confirm(), 'Placement confirmed. Awaiting execution and verified result.');
  if (action) $(action.player === 1 ? 'motion-button' : 'success-button').focus();
  return action;
}
function motionComplete(actionId) {
  return run(() => game.motionComplete(actionId), 'Motion finished; placement remains unverified.', 'success-button');
}
function placementResult(actionId, placed) {
  const accepted = run(() => game.resolve(actionId, placed), placed ? 'Placement verified. Board updated once.' : 'Not placed. Same player can retry.', placed ? 'target-a' : 'confirm-button');
  if (accepted && game.snapshot().phase === 'finished') $('reset-button').focus();
  return accepted;
}
$('confirm-button').addEventListener('click', confirmSelection);
$('cancel-button').addEventListener('click', () => run(() => game.cancel(), 'Selection cancelled.', 'target-a'));
$('motion-button').addEventListener('click', () => motionComplete(game.snapshot().pending?.id));
$('success-button').addEventListener('click', () => placementResult(game.snapshot().pending?.id, true));
$('failure-button').addEventListener('click', () => placementResult(game.snapshot().pending?.id, false));
$('pause-button').addEventListener('click', () => {
  if (run(() => game.pause(), 'Interruption simulated. No physical stop command was sent.')) {
    $(game.snapshot().pending ? 'recover-placed' : 'resume-button').focus();
  }
});
for (const [id, placed] of [['recover-placed', true], ['recover-missed', false], ['resume-button', undefined]]) {
  $(id).addEventListener('click', () => run(() => game.reconcile(placed), 'Demo resumed after explicit state verification.', placed === false ? 'confirm-button' : 'target-a'));
}
$('reset-button').addEventListener('click', () => $('reset-dialog').showModal());
$('reset-cancel').addEventListener('click', () => $('reset-dialog').close());
$('reset-confirm').addEventListener('click', () => {
  $('reset-dialog').close();
  run(() => game.newGame(), 'New game. Starting player switched.', 'target-a');
});

// Local demo hooks for teammates, NOT a production WebSocket protocol.
// A future backend must own authoritative state and correlate action IDs.
window.ReachGameDemo = Object.freeze({
  selectEEGTarget(zone) {
    return game.snapshot().player === 1 ? selectTarget(zone) : false;
  },
  confirmSelection, motionComplete, placementResult,
  snapshot: () => game.snapshot(),
  interrupt: () => run(() => game.pause(), 'Interruption simulated. State verification required.')
});
updateInterface();
addLog('Local demo ready. No EEG, flickering stimulus, or robotic arm connection.');
