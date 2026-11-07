// Store the selected target and the current workflow state.
let selectedTarget = null;
let currentState = "idle";

// Map internal state names to user-facing messages.
const statusMessages = {
  idle: "Waiting for selection",
  selected: "Target selected. Waiting for confirmation.",
  running: "Robotic arm executing (simulated)",
  success: "Task completed (simulated)",
  failure: "Task failed. Reset the demo to try again (simulated)."
};

// Find page elements once so they can be reused.
const selectedTargetLabel = document.getElementById("selected-target-label");
const statusLabel = document.getElementById("status-label");
const targetA = document.getElementById("target-a");
const targetB = document.getElementById("target-b");

const selectAButton = document.getElementById("select-a-button");
const selectBButton = document.getElementById("select-b-button");
const confirmButton = document.getElementById("confirm-button");
const cancelButton = document.getElementById("cancel-button");
const successButton = document.getElementById("success-button");
const failureButton = document.getElementById("failure-button");
const resetButton = document.getElementById("reset-button");

// Update labels, target highlights, and available controls.
function updateInterface() {
  selectedTargetLabel.textContent =
    selectedTarget ? "Target " + selectedTarget : "None";

  statusLabel.textContent = statusMessages[currentState];

  targetA.classList.toggle("selected", selectedTarget === "A");
  targetB.classList.toggle("selected", selectedTarget === "B");

  const canSelect =
    currentState === "idle" || currentState === "selected";

  selectAButton.disabled = !canSelect;
  selectBButton.disabled = !canSelect;
  confirmButton.disabled = currentState !== "selected";
  cancelButton.disabled = currentState !== "selected";
  successButton.disabled = currentState !== "running";
  failureButton.disabled = currentState !== "running";
}

// Simulate a target selection received from the EEG module.
function selectTarget(targetId) {
  if (currentState !== "idle" && currentState !== "selected") {
    return;
  }

  selectedTarget = targetId;
  currentState = "selected";

  updateInterface();
  addLog("Simulated EEG selection: Target " + targetId + ".");
}

// Start simulated execution after the selection is confirmed.
function confirmSelection() {
  if (currentState !== "selected") {
    return;
  }

  currentState = "running";

  updateInterface();
  addLog(
    "Execution confirmed for Target " + selectedTarget + " (simulated)."
  );
}

// Simulate a completion message from the robotic arm module.
function simulateResult(wasSuccessful) {
  if (currentState !== "running") {
    return;
  }

  currentState = wasSuccessful ? "success" : "failure";

  updateInterface();

  const resultMessage = wasSuccessful
    ? "Task completed for Target "
    : "Task failed for Target ";

  addLog(resultMessage + selectedTarget + " (simulated).");
}

// Cancel a pending selection before execution begins.
function cancelSelection() {
  if (currentState !== "selected") {
    return;
  }

  const cancelledTarget = selectedTarget;

  selectedTarget = null;
  currentState = "idle";

  updateInterface();
  addLog("Selection cancelled for Target " + cancelledTarget + ".");
}

// Reset local demo data. This does not stop a physical robot.
function resetDemo() {
  selectedTarget = null;
  currentState = "idle";

  updateInterface();
  addLog("Demo reset. Waiting for target selection.");
}

// Add a timestamped event and keep the latest 20 entries.
function addLog(message) {
  const activityLog = document.getElementById("activity-log");
  const entry = document.createElement("li");
  const timestamp = document.createElement("time");
  const messageText = document.createElement("span");
  const now = new Date();

  timestamp.className = "log-time";
  timestamp.dateTime = now.toISOString();
  timestamp.textContent = now.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });

  messageText.className = "log-message";
  messageText.textContent = message;

  entry.append(timestamp, messageText);
  activityLog.prepend(entry);

  if (activityLog.children.length > 20) {
    activityLog.lastElementChild.remove();
  }
}

// Connect each button to its corresponding action.
selectAButton.addEventListener("click", function () {
  selectTarget("A");
});

selectBButton.addEventListener("click", function () {
  selectTarget("B");
});

confirmButton.addEventListener("click", confirmSelection);
cancelButton.addEventListener("click", cancelSelection);

successButton.addEventListener("click", function () {
  simulateResult(true);
});

failureButton.addEventListener("click", function () {
  simulateResult(false);
});

resetButton.addEventListener("click", resetDemo);

// Display the initial state and record the start of the demo.
updateInterface();
addLog("Demo ready. Waiting for target selection.");