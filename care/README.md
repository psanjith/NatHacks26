# Reach — care requests prototype

This is an additional communication view for the existing NatHacks26 arm demo.
The original root index.html, script.js, style.css and README.md are unchanged.

## Open

Open care/index.html in a browser. No build or dependency installation is needed.
For reliable synchronization between browser tabs, serve the project through your
existing local web server and use the same origin. Browser storage for file URLs
is browser-dependent. The complete flow also works in a single tab.

## Try the flow

1. Choose one of the four needs. Add an optional detail.
2. Review the exact message; choose “Add request to demo inbox”.
3. Switch to “Caregiver view”; choose “I've seen this”, “I'm on my way”, then
   “Mark as handled”. Switch back to “My requests” to inspect each response.
4. Try withdrawing an active request. Confirmation is required before withdrawal.
5. Use “Help with an object” for a user-confirmed request after an arm task.
   The user can choose “The arm could not reach it”, “The grasp did not work”,
   or “I need help using it”. This is not automatic robot telemetry.
6. “Open the original arm demo” opens the preserved existing A/B arm interface.

Only one request may be active at a time. The last 20 requests are kept in this
browser's local storage; the interface shows the six most recent closed requests.
Storage failures fall back to memory with an explicit notice. “Larger text” is
saved as a local preference. All controls support keyboard Tab and Enter.

## Scope and limitations

- This is a local prototype: no real caregiver notifications, accounts, network
  delivery, push notifications, or multi-device synchronization.
- Caregiver acknowledgement is an explicit click in the local demo, not a signal
  that an actual caregiver has received or responded to anything.
- Not an emergency alert system or a clinically validated ALS interface.
- No EEG, EMG, eye tracking, robotic arm control, or physical stop is implemented
  here. Existing team WebSocket messages and ArmDriver interfaces are unchanged.
- Do not infer accessibility for a particular person from the large buttons.
  The intended user's reliable input method still needs evaluation and integration.

## Integration boundary

The browser exposes `window.ReachCare.getNeeds()` and
`window.ReachCare.selectNeed(id)` for a future selection adapter. Selecting a need
only prepares a message; it does not submit the request. Available IDs:
`position`, `discomfort`, `device`, `company`, `arm`.

The current plan has four simultaneous SSVEP targets. A future backend integration
should use a separate four-choice care screen and a distinct arm-assistance
context, not add a fifth flashing target. Confirmation/cancellation must use a
reliable input available to that user; jaw clench cannot be assumed universally.
Do not change the shared WebSocket protocol without coordinating with the team.

Suggested next integration: a real backend owns requests and acknowledgements,
with separate patient/caregiver sessions, authenticated access, delivery status,
and reconnect behavior. Robot feedback may offer a draft care request but must
not claim user consent, actual delivery, or completion without corresponding events.

## Preserving the arm's purpose

Keep Reach as two related paths: fetch/position a supported object, or request
human assistance. The current plan's small, light objects and fixed workspace
remain the hardware envelope. A phone-placement task is not assumed compatible.
An arm sequence that places an object on a tray and waits for the user's next
intent is a proposed backend change, not part of this frontend delivery. The
plan's automatic return after 10 seconds should not be described as proof the
person could use the object. Evaluate usefulness for a specific user's abilities.

## Validation

JavaScript syntax checks passed. Five Node unit tests cover lifecycle transitions,
withdrawal/stale responses, duplicate and invalid transitions, intent validation,
and persistence/corrupt-state handling. Run `node --test care-model.test.cjs` from
the care directory.

Visual and end-to-end browser verification was attempted but not completed:
the in-app browser could not reach the local preview, and Windows browser control
stopped because it could not confidently identify the current URL. Responsive CSS
is included but has not been visually verified on desktop/mobile.
