# Reach: pitch positioning

Notes for building the pitch: what Reach is, what to claim, the cost and business story, the demo, and likely judge questions.

**Status: working draft, nothing final.** Each feature is tagged **Built** (in the code now), **Planned** (agreed, not built yet), **Idea** (under discussion) or **Dropped**. Update this file as things change.

## 1. The pitch in one line

> "Look at what you want, clench your jaw, and the arm gets it for you. When the camera loses your eyes, the headset takes over."

## 2. How it works (the current setup)

| Step | What happens | Status |
|---|---|---|
| 1. See the table | A table camera finds the objects from pixels alone | **Built** |
| 2. Choose with your eyes | A webcam eye tracker shows a **cursor** where you're looking; the object under it is **highlighted yellow** | **Built** |
| 3. Confirm with your jaw | **Hold a clench ~1 s** to pick (the object turns green); **clench again within 1.5 s** to cancel. A clench also stops the arm | **Built** |
| 4. The arm fetches it | Locates the object from the camera image, plans the move, picks it up | **Built** (sim) |
| 5. Put it where you want | After the pick, look at a spot on the table; clench to place it there if it passes the checks (section 5) | **Planned**: target is end of today |

Today step 5 is fixed: the arm drops the object in a basket.

### Electrode layout (`--montage face`)

| Ganglion | Spot | Job |
|---|---|---|
| ch1 | Left outer eye corner, on the bone about 1 cm out | Eye glances (fallback) |
| ch2 | Right outer eye corner | Eye glances (fallback) |
| ch3 | Jaw muscle: on the cheek in front of the ear, where it bulges when you clench | Clench |
| ch4 | T7, above the left ear (optional) | Second clench sensor; must agree with ch3 |
| REF / D_G | Earlobe / forehead | Reference / ground |

We have 3 channel electrodes, so ch4 is empty for now. The clench calibration then uses the jaw electrode alone.

## 3. What the headset does (why the BCI kit earns its place)

| Headset job | Why a webcam can't do it | Status |
|---|---|---|
| **Jaw clench to pick or stop** | A clench is invisible to a camera: the muscle tightens but nothing moves | **Built** |
| **Two sensors must agree** (Jaw + T7) | Talking, chewing or a loose electrode alone can't trigger a pick | **Built** (needs a 4th electrode for T7) |
| **Eye glances when the webcam can't track your eyes** | The headset reads eye movement directly from the skin, whatever the lighting or the face is covered by | **Built**: switches when the face is lost |

**Be honest about what it reads.** The headset reads **muscle (EMG)** and **eye-movement (EOG)** signals, not brain signals. Don't call Reach "mind-controlled". The honest version is a better story anyway:

> "We started with real brain signals (SSVEP). Over 185 trials and 3 sessions, our setup picked up mains hum about 1,000 times bigger than the response, and no decoder beat 32% on 7 targets (chance is 14%). So we switched to the signals the same headset reads clearly: a jaw clench and eye movements, both hundreds of µV."

(Numbers from the team's SSVEP experiments, on the pivot slide.)

## 4. The eye-tracking fallback

**When the webcam can't track your eyes, Reach switches to the headset.** The middle object is highlighted; **flick your eyes left or right** to move the highlight one object that way; **clench to pick**, as usual.

**Call it "when the webcam can't track your eyes", not "dark mode".** A fully dark room stops the table camera too. The real cases are ones where the table is visible but the eyes aren't:

- **Backlight:** a window behind the person leaves the face a dark silhouette.
- **Lighting on the table, not the face:** a lamp over the table, the face in shadow.
- **A ventilation (BiPAP) mask** over the nose and mouth, which many people with ALS use. It can stop the face tracker finding the face.
- **Glasses glare** hiding the eyes.
- **Lying in bed** or the head tilted, outside the angles calibration saw.
- **The webcam knocked or blocked.**

Eye tracking also fails in dim light long before object detection does: it has to find the iris (a few pixels) precisely, while a 4 cm object on a lit table is easy to see.

**Lighting:** we light the table (the phone's flashlight when a phone is the table camera, or a cheap LED), so the arm always sees the objects. We don't light the person's face: a light in someone's eyes all day is uncomfortable, especially for someone who can't turn away. The face camera (phone or iPad front camera) has no flashlight, so that's where the headset takes over.

### When it switches

| Trigger | Status |
|---|---|
| Face lost for 2.5 s | **Built** |
| Tracking too shaky for 1.5 s (cursor jumping far more than during calibration) | **Planned** |
| Picture too dark for 1 s (below ~40% of the brightness during calibration, not a fixed number) | **Planned** |
| Switch back only after everything looks good for 2 s, with a higher bar than for switching away (e.g. back above 55% brightness), so it doesn't flicker between modes | **Planned** |
| Show why on screen, e.g. "Too dark for the webcam: using eye glances" | **Planned** |
| If glances aren't set up (no eye electrodes or eye check), stay on the webcam and warn instead | **Planned** |
| **G** key forces glance mode on or off | **Built** |

### Demo moment

Halfway through the demo, **cover the webcam with your hand.** The cursor disappears, the headset takes over, and the person still picks an object by eye glances and a clench. This shows judges the headset keeps the person in control when the camera can't see them.

## 5. Place anywhere (Planned)

1. After the pick, **the person looks at a spot on the table**. The gaze point becomes a table position using the existing camera calibration (`pixelToPlane`).
2. A **ghost cube** appears there: **green if it passes the checks, red if not.**
   - **Reachable:** IK finds a solution within 5 mm.
   - **Free:** no other object or the basket within about 5 cm.
   - **On the table**, not on the pedestal or the board's edge.
   - **Visible** to the table camera.
3. **Clench to place it there**, or clench again to cancel. The basket stays as one of the options.

This shows the person decides where things go, rather than the arm being limited to fixed spots. It reuses the existing calibration, kinematics and clench flow.

## 6. What to call it

Say **assistive robotic arm** (or "hands-free robotic arm"). **Not "bionic arm".**

A bionic arm is a prosthetic worn by an amputee. Reach sits on a table or wheelchair and acts for someone who can't move their own arms. Calling it bionic puts us in the wrong market, next to the wrong competitors.

## 7. What's new: claim the gap, not "it doesn't exist"

Gaze-controlled robot arms already exist in research:

- a wheelchair-mounted 6-DOF arm controlled by eye gaze (2021)
- Stanford ARMLab's demo combining HoloLens gaze, an EMG armband and a Kinova JACO
- a 2024 review of the whole field (Fischer-Janzen et al.)

We found **no one selling one**, and certainly not affordably. The 2024 review names the field's main unsolved problem: the **"Midas touch"**, where the system mistakes ordinary looking for a command. **The jaw clench solves exactly that**: eyes choose, a held clench confirms.

> "Research has shown that gaze can control a robot arm. Nobody ships it, because of the Midas-touch problem: the system can't tell looking from choosing. We fix that with a jaw clench, and we keep working when the camera loses your eyes, for a fraction of the price."

Don't say "this doesn't exist". One search disproves it.

## 8. Cost

| Product | What it does | Price |
|---|---|---|
| **Kinova JACO** | General assistive arm, joystick control | **~$35,000**; others in this class sell for $40,000+; often not covered by US insurance |
| **Obi** | Feeding only, controlled by switches | **~$8,000–9,600** (Obi 3, current retail listings) |
| **Reach** | Any object on the table, hands-free, by gaze plus clench | **~$1,250 in parts** with our current kit |

### Reach parts cost (first estimate)

**Checked** = current price from the maker's store. **Estimate** = typical retail; check before quoting.

| Part | Qty | Cost (USD) | Source |
|---|---|---|---|
| OpenBCI Ganglion (4-channel board) | 1 | $624.99 | Checked: OpenBCI shop |
| OpenBCI Ultracortex Mark IV headset | 1 | from $499.99 | Checked: OpenBCI shop ("from" = cheapest option). The frame is open source and printable for ~$15–30 of PLA; the price is mostly the dry electrodes, springs, screws and assembly |
| Arduino Uno R3 | 1 | ~$30 | Estimate (US list price has been $29.95) |
| SG90 micro servos | 5 | ~$15 | Estimate, ~$2–4 each (5 per the latest CAD; PLAN.md says 7, add ~$5 if so) |
| PLA filament for the printed arm | ~1 kg | ~$20 | Estimate |
| 5 V, ≥5 A power supply for the servos | 1 | ~$15 | Estimate |
| Webcam or phone (eye tracking + table camera) | 1 | ~$30 | Estimate; a phone we already own also works |
| Breadboard, jumper wires | — | ~$10 | Estimate |
| **Total** | | **~$1,245** | |

**How to talk about it:**

- **Even at ~$1,250, Reach is about 1/28 of a JACO and about 1/7 of an Obi**, and it picks up any object rather than only feeding. Say "a fraction of the cost", not "the cheapest possible".
- **The headset is part of the product.** It's about 90% of the parts cost, so it has to earn its place: section 3 is the answer.
- **There's a path to cheaper hardware.** OpenBCI's designs are open source: the Ultracortex frame is a free print, and the $625 Ganglion is a low-volume retail price, not what the electronics cost. A product version can build on the same open design. Say this as a direction; don't quote a number.
- **These are parts costs, not a selling price.** A selling price also covers assembly, support and margin. Say "parts cost".
- The hackathon lent us the kit, so this is what someone would pay to build one, not what we spent.

## 9. Business model: software first, bundle second

- **Software that works with any arm.** One driver runs the sim, our printed arm or a commercial arm. That makes **existing JACO owners a market**: sell them hands-free control as a software add-on.
- **Bundle:** our software + printed arm + headset + camera, as the affordable option for people who can't get a $35,000 arm funded.
- **Be honest about the prototype.** Hobby servos lift light objects; the bundle grows into a stronger arm. The "What comes next" slide already covers this.

## 10. Likely judge questions

| Question | Answer |
|---|---|
| "Is this mind control?" | No. Eyes choose; a jaw clench confirms. The headset reads muscle and eye signals. We tried brain signals first and our data showed they weren't reliable with this setup (section 3). |
| "What about people who can't clench?" (bulbar ALS weakens the jaw early) | The software takes the confirm signal as an input, so a switch, a long gaze or a blink could replace the clench. *Not built yet; say "designed for", not "does".* |
| "What if it's dark?" | The arm needs the table lit, like any camera system; a phone flashlight or a cheap LED does it. The fallback is for when the face isn't visible but the table is (section 4). |
| "iPhones have Face ID, which works in the dark." | The front camera's infrared light is only available to native iOS apps, not the browser our eye tracker runs in. A native app could use it later; the headset fallback works with any webcam. |
| "Why not just turn the screen brightness up?" | It helps in dim rooms, but not with backlight, glasses glare or a breathing mask. |
| "Why not a cheaper muscle sensor instead of an EEG kit?" | One sensor gives the clench only. The headset also gives the two-sensor check and the eye-glance fallback when the camera fails, from one wearable. |
| "Isn't this a bionic arm?" | No: an assistive robotic arm for people who can't move their own arms (section 6). |

## 11. Ideas, open questions and dropped options

| Item | Status |
|---|---|
| **Close your eyes for 2 s to stop the arm** (eyes-closed alpha rhythm): a genuine brain signal, and a way to stop the arm without the jaw. Needs one more electrode at Oz | **Idea**: not wanted for now; revisit if we want a real brain-signal feature |
| **Skip the headset, use stick-on electrodes** (~$770 total) | **Dropped**: the headset is part of the product |
| **Replace the headset with a cheap muscle sensor** (~$150–200 total) | **Dropped**: same reason; loses the eye-glance fallback |
| **SSVEP (flicker) selection** | **Dropped** after the team's experiments (section 3) |
| **Three Territories game** is no longer in the deck (only "a game piece" on the problem slide) | **Open**: confirm with the team whether that's intentional |
| **PLAN.md still describes SSVEP** | **Open**: needs updating to the eyes + clench design |
| **Servo count:** 5 (latest CAD and deck) vs 7 (PLAN.md) | **Open** |

## Sources

- [OpenBCI shop: Ganglion and Ultracortex prices](https://shop.openbci.com/collections/frontpage/openbci)
- [OpenBCI shop: EEG collection](https://shop.openbci.com/collections/all/eeg)
- [Arduino Uno R3 price history (Elecena)](https://elecena.pl/product/2416473/rss)
- [Kinova JACO price ($35,000, not covered by US insurance)](https://futurism.com/robot-arm-wheelchair)
- [R-ARM paper: other wheelchair-mounted arms over $40,000](https://www.nibib.nih.gov/sites/default/files/R-ARM.pdf)
- [Obi 3 retail listing](https://peakprimalwellness.com/products/obi-3-robotic-feeding-device)
- [Obi retail listing (rehab-store)](https://www.rehab-store.com/p-obi-robotic-independent-feeding-device.html)
- [Fischer-Janzen et al. 2024: scoping review of gaze control for assistive arms](https://pmc.ncbi.nlm.nih.gov/articles/PMC10909843)
- [Eye-gaze control of a wheelchair-mounted 6-DOF assistive robot](https://ouci.dntb.gov.ua/works/4MQ0gMN4)
- [Stanford ARMLab: gaze + EMG control of a JACO](https://src.stanford.edu/demo/gaze-based-control-for-assistive-arms)
- [Northwestern 2023 eye-gaze assistive control study](https://www.mccormick.northwestern.edu/news/articles/2023/06/study-finds-eye-gaze-signals-provide-key-answers-in-assistive-device-control/index.html)
