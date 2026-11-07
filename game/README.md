# Reach — Three Territories

A local, buildless prototype extending the original selection / confirmation / result demo. Open `index.html` in a modern browser. No installation, account, internet connection, or server is required. Refreshing the page clears the match.

## Where to start

1. `index.html`: Page structure, including the board, players, confirmation buttons, and operator feedback.
2. `game.js`: Core game rules and action states. Start with the `select → confirm → motionComplete → resolve` flow.
3. `script.js`: Connects page buttons to the game rules and refreshes the display through `updateInterface()`. Includes hooks for local simulation.
4. `style.css`: Layout, colors, mobile styles, and focus indicators.
5. `game.test.cjs`: Tests for complete matches, failed-placement retries, duplicate results, and interruption recovery. Run `node --test game.test.cjs`.

## Try a complete turn

- Player 1: choose A/B/C → Confirm simulated move → Simulate motion finished → Confirm token placed.
- Player 2: choose A/B/C → Confirm territory → place token manually (if using a physical board) → Confirm token placed.
- Repeat until both players have used six tokens. Territory majorities earn 3/4/5 points; ties earn nothing. Interim points are clearly marked provisional.
- After motion finishes, choose Not placed to test a retry. No token is lost. The retry gets a fresh action ID.
- Development controls → Simulate interruption pauses the workflow. Pending placement must be explicitly reconciled before resuming. New game is disabled during an outstanding placement or pause. A new game switches the starting player.
- The operator stages the correct Player 1 token at the fixed pickup point. Physical token recognition and pickup detection are not implemented.

## Integration status — please read before connecting hardware

This build has **no EEG, flickering stimulus, WebSocket, camera, or motor connection**. It does not send commands to the arm. It is not a hardware safety controller. Pause/reset controls only affect the local demo. The current model is in memory, and cannot recover a physical match after a page refresh.

Reuse the team's existing flickering-target component and calibrated target-to-zone mapping. Do not introduce CSS flashing as a substitute. The original team's backend message definitions were not present in this checkout, so this prototype does not invent or claim compatibility with that protocol.

`window.ReachGameDemo` offers LOCAL test hooks:

```js
ReachGameDemo.selectEEGTarget('B'); // P1 only; prepares a choice, does not execute
const action = ReachGameDemo.confirmSelection();
// Use the ID captured for THIS action, never the currently pending ID for delayed messages.
ReachGameDemo.motionComplete(action.id); // motion only; no score update
ReachGameDemo.placementResult(action.id, true); // explicit verified placement
ReachGameDemo.snapshot();
```

These are JavaScript test methods, **not an agreed wire protocol**. Before live integration:

1. Agree with the backend owner on zone IDs, user selection/confirmation events, action IDs, stopped states, and verified placement results.
2. Make the backend authoritative for moves and match state; adapt this UI to render backend snapshots. The current local rules are a reference for the intended behavior.
3. Keep manual Player 2 placements separate from Player 1 arm requests.
4. Disable selection stimuli and new commands during motion. Reuse the team's independently implemented stop controls.
5. On disconnect, pause locally. Reconnect must fetch and reconcile the backend state, including whether motion stopped and whether the pending token was placed. Never automatically repeat an uncertain move.
6. Confirm the real arm has stopped before any operator recovery action. Retain independent physical emergency stop and backend safeguards.

No persistent personal data, social accounts, chat, or leaderboard is included. Game balance, accessibility, and real-user usability remain to be evaluated.

## Verification

Eight automated rule/workflow tests passed, and both JavaScript files passed syntax checks. Browser visual and interaction QA was not completed: the available browser blocked local-file navigation, and the local HTTP readiness request did not succeed. Hardware integration has not been tested. Open the page yourself to review its appearance and try a full match before using it in a demonstration.
