"use strict";

// ==================================================
// 1. Local UI state
// This file does not own the game rules or arm motion.
// ==================================================

const $ = (id) => document.getElementById(id);

let socket = null;
let game = null;
let system = null;

let receivedGame = false;
let receivedState = false;

let hardwareStatus = "unknown";
let armPhase = "";
let backendSelection = "";

let selectedTerritory = null;
let pendingRequest = null;
let stopRequested = false;

// These are the existing core states in the plan that
// can be treated as non-moving during a tap player's turn.
//
// If the backend introduces a dedicated hand-turn state,
// agree on its name and add it here.
const HAND_INPUT_STATES = new Set([
  "IDLE",
  "SELECTING"
]);

// Suggested address only. Change it to match the actual server.
const defaultHost = location.hostname || "127.0.0.1";
const formattedHost = defaultHost.includes(":")
  ? `[${defaultHost}]`
  : defaultHost;

const wsProtocol = location.protocol === "https:"
  ? "wss"
  : "ws";

$("server-url").value =
  `${wsProtocol}://${formattedHost}:8000/ws`;

// ==================================================
// 2. Small helpers
// ==================================================

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    const replacements = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };

    return replacements[character];
  });
}

function isConnected() {
  return socket?.readyState === WebSocket.OPEN;
}

function isReady() {
  return (
    isConnected() &&
    receivedGame &&
    receivedState &&
    game !== null &&
    system !== null
  );
}

function currentPlayer() {
  return game?.players.find(
    (player) => player.id === game.current
  ) || null;
}

function gameSignature(value) {
  // Used only to notice a changed server snapshot.
  // This is NOT a replacement for backend revisions or request IDs.
  return JSON.stringify(value);
}

function showError(message) {
  $("error-message").textContent = message;
  $("error-message").hidden = !message;
}

function addLog(message) {
  const item = document.createElement("li");
  const timestamp = document.createElement("time");
  const now = new Date();

  timestamp.dateTime = now.toISOString();
  timestamp.textContent = now.toLocaleTimeString("en-GB");

  item.append(
    timestamp,
    document.createTextNode(message)
  );

  $("activity-log").prepend(item);

  if ($("activity-log").children.length > 30) {
    $("activity-log").lastElementChild.remove();
  }
}

// ==================================================
// 3. Validate the backend's game snapshot
// ==================================================

function validGameSnapshot(message) {
  if (
    typeof message.phase !== "string" ||
    !Array.isArray(message.players) ||
    !Array.isArray(message.territories) ||
    message.players.length < 2 ||
    message.players.length > 4 ||
    message.territories.length !== 3
  ) {
    return false;
  }

  const validPlayers = message.players.every((player) => {
    return (
      Number.isInteger(player.id) &&
      typeof player.name === "string" &&
      typeof player.input === "string" &&
      Number.isInteger(player.tokens_left) &&
      player.tokens_left >= 0
    );
  });

  if (!validPlayers) {
    return false;
  }

  const playerIds = message.players.map((player) => player.id);

  if (new Set(playerIds).size !== playerIds.length) {
    return false;
  }

  if (
    message.phase === "TURN" &&
    !playerIds.includes(message.current)
  ) {
    return false;
  }

  const territoryIds = message.territories.map(
    (territory) => territory.id
  );

  if (
    new Set(territoryIds).size !== territoryIds.length
  ) {
    return false;
  }

  return message.territories.every((territory) => {
    return (
      Number.isInteger(territory.id) &&
      Number.isFinite(territory.points) &&
      territory.points >= 0 &&
      Array.isArray(territory.counts) &&
      territory.counts.length === message.players.length &&
      territory.counts.every(
        (count) => Number.isInteger(count) && count >= 0
      )
    );
  });
}

// ==================================================
// 4. WebSocket connection
// ==================================================

function connect() {
  let address;

  try {
    address = new URL($("server-url").value.trim());

    if (!["ws:", "wss:"].includes(address.protocol)) {
      throw new Error("Use a ws:// or wss:// address.");
    }

    if (address.username || address.password) {
      throw new Error("Do not put credentials in this address.");
    }

    if (
      location.protocol === "https:" &&
      address.protocol !== "wss:"
    ) {
      throw new Error(
        "An HTTPS page needs a secure wss:// connection."
      );
    }
  } catch (error) {
    showError(error.message || "Invalid WebSocket address.");
    return;
  }

  // Retire the previous connection. Its late callbacks are ignored.
  if (socket) {
    const previousSocket = socket;
    socket = null;
    previousSocket.close();
  }

  game = null;
  system = null;

  receivedGame = false;
  receivedState = false;

  hardwareStatus = "unknown";
  armPhase = "";
  backendSelection = "";

  selectedTerritory = null;
  pendingRequest = null;
  stopRequested = false;

  $("undo-check").checked = false;
  showError("");

  let nextSocket;

  try {
    nextSocket = new WebSocket(address.href);
  } catch (error) {
    showError(`Connection could not start: ${error.message}`);
    drawGame();
    updateControls();
    return;
  }

  socket = nextSocket;

  drawGame();
  updateControls();
  addLog(`Connecting to ${address.host}${address.pathname}`);

  nextSocket.addEventListener("open", () => {
    if (socket !== nextSocket) return;

    addLog("Connected. Waiting for state and game snapshots.");
    updateControls();

    // The supplied protocol has no snapshot-request message.
    // The backend must send "state" and "game" on connection.
  });

  nextSocket.addEventListener("message", (event) => {
    if (socket !== nextSocket) return;

    try {
      const message = JSON.parse(event.data);
      handleMessage(message);
    } catch {
      showError("An unreadable backend message was received.");
      addLog("Ignored an invalid message.");
    }
  });

  nextSocket.addEventListener("close", () => {
    if (socket !== nextSocket) return;

    receivedGame = false;
    receivedState = false;
    selectedTerritory = null;

    addLog(
      "Disconnected. Pending operations will not be resent automatically."
    );

    updateControls();
  });

  nextSocket.addEventListener("error", () => {
    if (socket !== nextSocket) return;

    showError(
      "Connection failed. Check the backend address, server, and network."
    );

    updateControls();
  });
}

function disconnect() {
  if (!socket) return;

  const previousSocket = socket;
  socket = null;
  previousSocket.close();

  receivedGame = false;
  receivedState = false;
  selectedTerritory = null;

  addLog("Disconnected by user.");
  updateControls();
}

// ==================================================
// 5. Handle the team's existing message types
// ==================================================

function handleMessage(message) {
  if (!message || typeof message.type !== "string") {
    return;
  }

  switch (message.type) {
    case "game": {
      if (!validGameSnapshot(message)) {
        receivedGame = false;
        showError("The backend sent an unsupported game snapshot.");
        updateControls();
        return;
      }

      const previousSignature = game
        ? gameSignature(game)
        : null;

      const nextSignature = gameSignature(message);
      const changed = previousSignature !== nextSignature;

      game = message;
      receivedGame = true;

      if (changed) {
        selectedTerritory = null;
        backendSelection = "";
        $("undo-check").checked = false;

        if (pendingRequest) {
          addLog(
            "The backend updated the game. Check the confirmed board."
          );

          pendingRequest = null;
        }
      }

      drawGame();
      updateControls();
      break;
    }

    case "state": {
      if (typeof message.state !== "string") return;

      system = message;
      receivedState = true;

      if (system.state === "STOPPED") {
        stopRequested = false;
        selectedTerritory = null;
      }

      if (!canRecordHandMove()) {
        selectedTerritory = null;
      }

      updateControls();
      break;
    }

    case "selected": {
      // This is the backend's EEG/scan selection.
      // It does not commit a game move.
      backendSelection = String(
        message.label ?? `Target ${message.id}`
      );

      updateControls();
      break;
    }

    case "arm": {
      armPhase = typeof message.phase === "string"
        ? message.phase
        : "";

      // Do not rebuild the board for arm updates.
      updateControls();
      break;
    }

    case "hw": {
      hardwareStatus = String(message.uno || "unknown");
      updateControls();
      break;
    }

    case "error": {
      showError(String(message.msg || "Backend error."));
      addLog(`Backend error: ${message.msg || "Unknown error"}`);

      // No automatic retry: this protocol does not correlate errors
      // with request IDs. Reconcile with the operator/backend.
      updateControls();
      break;
    }

    // /game does not render camera frames, frequency scores,
    // joint angles, or EEG signals. Those belong to /user or /world.
    default:
      break;
  }
}

// ==================================================
// 6. Determine whether manual input is allowed
// ==================================================

function canRecordHandMove() {
  if (
    !isReady() ||
    pendingRequest ||
    stopRequested ||
    system.app_mode !== "game" ||
    game.phase !== "TURN"
  ) {
    return false;
  }

  const player = currentPlayer();

  if (
    !player ||
    player.input !== "tap" ||
    player.tokens_left <= 0
  ) {
    return false;
  }

  if (!HAND_INPUT_STATES.has(system.state)) {
    return false;
  }

  // When real hardware is enabled, wait for its status.
  if (
    system.arm_hw === true &&
    hardwareStatus !== "ok"
  ) {
    return false;
  }

  return true;
}

function canUndo() {
  const placedTokens = game
    ? game.territories.reduce((total, territory) => {
        return total + territory.counts.reduce(
          (sum, count) => sum + count,
          0
        );
      }, 0)
    : 0;

  return (
    canRecordHandMove() &&
    system.state === "IDLE" &&
    placedTokens > 0 &&
    $("undo-check").checked
  );
}

// ==================================================
// 7. Send commands, without changing the game locally
// ==================================================

function sendMessage(message) {
  if (!isConnected()) {
    showError("Not connected to the backend.");
    return false;
  }

  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    showError("The message could not be sent. Check the connection.");
    return false;
  }
}

function selectTerritory(territoryId) {
  if (!canRecordHandMove()) return;

  const exists = game.territories.some(
    (territory) => territory.id === territoryId
  );

  if (!exists) return;

  selectedTerritory = territoryId;
  updateControls();
}

function recordHandMove() {
  if (
    !canRecordHandMove() ||
    selectedTerritory === null
  ) {
    return;
  }

  const player = currentPlayer();

  const request = {
    type: "move",
    player: player.id,
    territory: selectedTerritory
  };

  // Lock immediately to prevent double-click submissions.
  pendingRequest = {
    kind: "move",
    player: player.id,
    territory: selectedTerritory
  };

  updateControls();

  if (!sendMessage(request)) {
    pendingRequest = null;
    updateControls();
    return;
  }

  addLog(
    `Submitted ${player.name}'s hand placement. Waiting for backend.`
  );

  // No local token decrement, scoring, or turn change here.
}

function requestUndo() {
  if (!canUndo()) return;

  const confirmed = window.confirm(
    "Request undo? This changes the game record only. " +
    "The physical token must already have been restored."
  );

  if (!confirmed) return;

  pendingRequest = { kind: "undo" };
  updateControls();

  if (!sendMessage({ type: "undo" })) {
    pendingRequest = null;
    updateControls();
    return;
  }

  addLog("Undo requested. Waiting for the backend.");
}

function requestStop() {
  if (!isConnected() || stopRequested) return;

  stopRequested = true;
  selectedTerritory = null;
  updateControls();

  const sent = sendMessage({
    type: "cmd",
    cmd: "stop"
  });

  if (!sent) {
    stopRequested = false;
    updateControls();
    return;
  }

  addLog(
    "Stop requested. Waiting for the backend to report STOPPED."
  );

  // Do not display "stopped" until the backend confirms it.
}

// ==================================================
// 8. Draw the board from backend state
// ==================================================

function tokenMarkup(count, capacity, playerIndex) {
  // Limit decorative slots to avoid excessively large layouts.
  // The numeric count is always displayed separately.
  const slots = Math.min(Math.max(capacity, count), 12);

  return Array.from({ length: slots }, (_, index) => {
    const filled = index < count ? "filled" : "";

    return (
      `<span class="token p${playerIndex + 1} ${filled}"></span>`
    );
  }).join("");
}

function playerCapacity(playerIndex) {
  const placed = game.territories.reduce(
    (total, territory) => total + territory.counts[playerIndex],
    0
  );

  return game.players[playerIndex].tokens_left + placed;
}

function territoryLeader(territory) {
  const maximum = Math.max(...territory.counts);

  const winners = territory.counts
    .map((count, index) => count === maximum ? index : -1)
    .filter((index) => index >= 0);

  if (maximum === 0 || winners.length !== 1) {
    return "Tied · no points";
  }

  const player = game.players[winners[0]];
  const verb = game.phase === "GAME_OVER" ? "wins" : "leads";

  return `${player.name} ${verb}`;
}

function backendScore(player, index) {
  const score = game.score;

  // The plan shows score:null but does not specify the final shape.
  // Support an array aligned with players, or an object keyed by ID.
  const value = Array.isArray(score)
    ? score[index]
    : score && typeof score === "object"
      ? score[String(player.id)]
      : null;

  return typeof value === "number" && Number.isFinite(value)
    ? value
    : null;
}

function drawGame() {
  if (!game) {
    $("players").innerHTML = "";

    $("territories").innerHTML = `
      <div class="empty-board">
        <div class="empty-symbols" aria-hidden="true">● ■ ●</div>
        <p>Waiting for the shared board</p>
      </div>
    `;

    $("score-list").innerHTML = "";
    $("move-label").textContent = "Waiting for game";

    return;
  }

  $("players").innerHTML = game.players.map((player, index) => {
    const active =
      game.phase === "TURN" &&
      game.current === player.id;

    const colourLabel = player.colour
      ? ` · ${player.colour}`
      : "";

    return `
      <article class="player-card ${active ? "active" : ""}">
        <div class="player-heading">
          <div>
            <h2>${escapeHTML(player.name)}</h2>
            <p>
              ${escapeHTML(player.input)}
              ${escapeHTML(colourLabel)}
            </p>
          </div>

          ${active ? '<span class="turn-tag">YOUR TURN</span>' : ""}
        </div>

        <div class="reserve" aria-hidden="true">
          ${tokenMarkup(
            player.tokens_left,
            playerCapacity(index),
            index
          )}
        </div>

        <p class="remaining">
          <strong>${player.tokens_left}</strong> tokens remaining
        </p>
      </article>
    `;
  }).join("");

  $("territories").innerHTML = game.territories.map(
    (territory, territoryIndex) => {
      const zoneLabel = String.fromCharCode(65 + territoryIndex);

      const countsLabel = game.players.map((player, index) => {
        return `${player.name}: ${territory.counts[index]}`;
      }).join(", ");

      const tokenSections = game.players.map((player, index) => {
        return `
          <span class="token-section">
            <span class="token-label">
              <span>${escapeHTML(player.name)}</span>
              <strong>${territory.counts[index]}</strong>
            </span>

            <span class="token-grid" aria-hidden="true">
              ${tokenMarkup(
                territory.counts[index],
                playerCapacity(index),
                index
              )}
            </span>
          </span>
        `;
      }).join("");

      return `
        <button
          type="button"
          class="territory"
          data-territory="${territory.id}"
          aria-pressed="false"
          aria-label="${escapeHTML(
            `${territory.points}-point territory. ${countsLabel}`
          )}"
          disabled
        >
          <span class="territory-top">
            <span class="zone-name">ZONE ${zoneLabel}</span>

            <span class="point-value">
              ${territory.points} <small>pts</small>
            </span>
          </span>

          ${tokenSections}

          <span class="territory-leader">
            ${escapeHTML(territoryLeader(territory))}
          </span>
        </button>
      `;
    }
  ).join("");

  const placed = game.territories.reduce((total, territory) => {
    return total + territory.counts.reduce(
      (sum, count) => sum + count,
      0
    );
  }, 0);

  const remaining = game.players.reduce(
    (total, player) => total + player.tokens_left,
    0
  );

  $("move-label").textContent =
    `${placed} / ${placed + remaining} tokens placed`;

  const finished = game.phase === "GAME_OVER";

  $("score-heading").textContent = finished
    ? "Final score"
    : "Territory control";

  if (finished) {
    $("score-list").innerHTML = game.players.map((player, index) => {
      const score = backendScore(player, index);

      return `
        <div class="score-row">
          <span>${escapeHTML(player.name)}</span>
          <strong>${score === null ? "—" : score}</strong>
        </div>
      `;
    }).join("");

    $("score-note").textContent =
      "Scores come from the backend. A dash means no supported score was received.";
  } else {
    $("score-list").innerHTML = "";

    $("score-note").textContent =
      "Each territory shows who currently leads. Final points come from the backend.";
  }
}

// ==================================================
// 9. Update controls and system status
// ==================================================

function updateControls() {
  const connected = isConnected();
  const connecting = socket?.readyState === WebSocket.CONNECTING;
  const ready = isReady();

  const player = currentPlayer();
  const handMoveAllowed = canRecordHandMove();

  $("connection-label").textContent = connecting
    ? "Connecting"
    : connected
      ? ready ? "Connected" : "Waiting for snapshots"
      : "Disconnected";

  $("connection-dot").classList.toggle(
    "connected",
    ready
  );

  $("connect-button").disabled = connected || connecting;
  $("disconnect-button").disabled = !connected && !connecting;

  $("server-url").disabled = connected || connecting;

  $("stale-notice").hidden = connected || !game;

  $("stop-button").disabled =
    !connected ||
    stopRequested ||
    system?.state === "STOPPED";

  $("stop-button").textContent = stopRequested
    ? "Stop requested…"
    : "Request stop";

  const stateName = system?.state || "UNKNOWN";

  const statusLabels = {
    IDLE: "System idle",
    SELECTING: "Waiting for selection",
    CONFIRM: "Selection confirmation in progress",
    PLACING: "Arm moving — hands clear",
    VERIFY: "Operator: check placement in /world",
    GRASPING: "Arm moving — hands clear",
    DELIVERING: "Arm moving — hands clear",
    DELIVERED: "Object at the hand-off position",
    RETURNING: "Arm moving — hands clear",
    STOPPED: "Stopped — operator recovery required"
  };

  let status = !connected
    ? "Disconnected — actions are disabled"
    : !ready
      ? "Waiting for backend state and game snapshots"
      : statusLabels[stateName] || `Backend state: ${stateName}`;

  if (stopRequested) {
    status = "Stop requested — waiting for backend confirmation";
  }

  $("system-status").textContent = status;

  const movingStates = [
    "PLACING",
    "GRASPING",
    "DELIVERING",
    "RETURNING"
  ];

  document.querySelector(".system-bar").classList.toggle(
    "warning",
    stopRequested ||
    movingStates.includes(stateName) ||
    stateName === "STOPPED"
  );

  const details = [];

  if (system) {
    details.push(`Mode: ${system.app_mode || "unknown"}`);
    details.push(`World: ${system.world || "unknown"}`);

    details.push(
      `Arm hardware: ${
        system.arm_hw === true
          ? hardwareStatus
          : system.arm_hw === false
            ? "off"
            : "unknown"
      }`
    );
  }

  if (armPhase && connected) {
    details.push(`Arm phase: ${armPhase}`);
  }

  $("system-detail").textContent = details.length
    ? details.join(" · ")
    : "The backend controls turns, movement, and scoring.";

  $("turn-heading").textContent = !game
    ? "Waiting for game"
    : game.phase === "GAME_OVER"
      ? "Game complete"
      : player
        ? `${player.name}'s turn`
        : `Game phase: ${game.phase}`;

  let turnHelp = "Connect to receive the current game.";

  if (ready && system.app_mode !== "game") {
    turnHelp = "The system is in everyday mode. Game input is disabled.";
  } else if (ready && game.phase !== "TURN") {
    turnHelp = "Wait for the operator or the next game phase.";
  } else if (ready && player?.input !== "tap") {
    turnHelp =
      "This player selects through /user. This app shows the shared game state.";
  } else if (handMoveAllowed) {
    turnHelp =
      "Place your token by hand, select its territory, then confirm below.";
  } else if (ready) {
    turnHelp =
      "Manual input is locked. Wait for the backend to allow this turn.";
  }

  $("turn-help").textContent = turnHelp;

  $("board-help").textContent = handMoveAllowed
    ? "Select the territory where you placed your token."
    : "The board reflects the latest game snapshot from the backend.";

  const territory = game?.territories.find(
    (item) => item.id === selectedTerritory
  );

  $("selection-label").textContent = territory
    ? `${territory.points} points`
    : backendSelection || "—";

  document.querySelectorAll("[data-territory]").forEach((button) => {
    const selected =
      Number(button.dataset.territory) === selectedTerritory;

    button.disabled = !handMoveAllowed;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });

  $("record-button").disabled =
    !handMoveAllowed || selectedTerritory === null;

  $("cancel-button").disabled =
    selectedTerritory === null || Boolean(pendingRequest);

  $("undo-button").disabled = !canUndo();

  $("request-status").textContent = pendingRequest
    ? "Request sent. Waiting for a changed backend game snapshot. Do not repeat the physical move. If nothing changes, check /world and reconnect after reconciliation."
    : "";
}

// ==================================================
// 10. UI events
// ==================================================

$("connect-button").addEventListener("click", connect);
$("disconnect-button").addEventListener("click", disconnect);

$("territories").addEventListener("click", (event) => {
  const button = event.target.closest("[data-territory]");

  if (!button || button.disabled) return;

  selectTerritory(Number(button.dataset.territory));
});

$("record-button").addEventListener("click", recordHandMove);

$("cancel-button").addEventListener("click", () => {
  if (pendingRequest) return;

  selectedTerritory = null;
  updateControls();
});

$("stop-button").addEventListener("click", requestStop);

$("undo-check").addEventListener("change", updateControls);
$("undo-button").addEventListener("click", requestUndo);

// ==================================================
// 11. Initial view
// ==================================================

drawGame();
updateControls();

addLog("Game app ready. Connect to the Reach backend.");