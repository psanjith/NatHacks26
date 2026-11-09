# Reach: pitch positioning

Notes for building the pitch: what Reach is, what to claim, the cost and business story, the demo, and likely judge questions.

**Status: working draft, nothing final.** Each feature is tagged **Built** (in the code now), **Planned** (agreed, not built yet), **Idea** (under discussion) or **Dropped**. Update this file as things change.

"Built" means built and tested **in the sim** (`sim-table-camera` branch). The newest items (place anywhere, the dim/shaky switching) were tested in a headless browser with the mouse standing in for the eyes and a simulated headset; they haven't been tried with a real webcam, headset or the printed arm yet.

**Change of plan (2026-11-08):** Reach is now aimed at **people with ALS**, and imagined hand movements read from the motor cortex replace the jaw clench: **imagine clenching your right hand to pick, your left hand to cancel.** **None of this is built or tested yet.** The sim still runs on the clench and eye glances described below as "current code". Treat every brain-signal claim here as unproven until the go/no-go test in section 2 passes.

## 1. The pitch in one line

> "For people with ALS: look at what you want, imagine squeezing your right hand, and the arm gets it for you."

(Use this line only if the go/no-go test in section 2 passes.)

## 2. How it works (the current setup)

| Step | What happens | Status |
|---|---|---|
| 1. See the table | A table camera finds the objects from pixels alone | **Built** |
| 2. Choose with your eyes | A webcam eye tracker shows a **cursor** where you're looking; the object under it is **highlighted yellow** | **Built** |
| Calibration check | Webcam at 720p; 13 dots across the whole window; blink and glance-away frames thrown out; the fit is chosen per person. The person calibrates at the start of each session (about 1 minute; nothing is saved). It must reach 175 px typical error or better; until it does, the person redoes the dots that are off. Real results on the 13-dot layout: 113 and 85 px across the window, 102 and 138 px over the camera view (one run each, two people) | **Built** |
| 3. Confirm with an imagined movement | **Imagine clenching your right hand** to pick (the object turns green); **imagine your left hand** to cancel, before the arm moves. **Once the arm is moving, nothing stops it yet** (section 11) | **Planned**. Current code: held jaw clench to pick, second clench within 3 s to cancel |
| 4. The arm fetches it | Locates the object from the camera image, plans the move, picks it up | **Built** (sim) |
| 5. Put it where you want | After the pick, look at a spot on the table and confirm to place it there if it passes the checks (section 5) | **Built** (sim, with the clench as the confirm): placed 1 mm from the chosen spot in testing |

Today step 5 is fixed: the arm drops the object in a basket.

### Electrode layout (Planned: motor cortex)

| Ganglion | Spot | Job |
|---|---|---|
| ch1 | C3, left side of the head | **Right**-hand imagery (each hand is controlled by the opposite side of the brain) |
| ch2 | C4, right side of the head | **Left**-hand imagery |
| ch3 | Cz, top of the head | Reference point for C3 and C4, to subtract noise they share |
| ch4 | Empty; one outer eye corner if we get a 4th electrode | Could keep the eye-glance fallback (section 4) |
| REF / D_G | Earlobe / forehead | Reference / ground |

To find them: Cz is halfway from nose bridge to the bump at the back of the skull, and halfway between the ears. C3 and C4 are about 20% of the ear-to-ear distance out from Cz on each side.

What the headset looks for: imagining a hand movement **lowers** the 8–30 Hz rhythm (mu and beta) over the opposite side of the brain. It's a small drop, not a spike, so it's much harder to read than a clench.

The old face layout (eye corners, jaw, T7) is what the current code expects, through `--montage face`.

### Go/no-go test (do this before building or pitching it)

Record about 30 imagined right-hand, 30 imagined left-hand and 30 rest trials, with hands, jaw and eyes still (about 10 minutes). Test on trials held out from training. Proposed bar:

- **Left vs right:** at least 75% correct.
- **Rest:** rarely mistaken for a command, because a false trigger moves a robot arm.

**Known risks:**

- **Mains hum:** our SSVEP recordings had hum about 1,000 times the brain response, and at 200 Hz sampling its harmonics alias to 20 Hz, inside the band we now need.
- **Muscle contamination:** a clench or tensed face can look like a brain signal. If the wearer's hand or jaw moves, the result proves nothing.
- **Decoding speed:** it will likely take a few seconds per command, so the 3 s cancel window probably needs to grow to about 6 s.

If it fails, the fallback is the clench design, which is already built, and imagery goes back to "Room to grow".

## 3. What the headset does (why the BCI kit earns its place)

| Headset job | Why a webcam can't do it | Status |
|---|---|---|
| **Imagined right hand to pick, left hand to cancel** | It's a brain signal: no movement for a camera to see | **Planned**, unproven |
| **Jaw clench to pick, place or cancel** | A clench is invisible to a camera: the muscle tightens but nothing moves | **Built**, being replaced; it's the backup if imagery fails. Weakens with ALS, and needs a jaw electrode the new layout doesn't have |
| **Eye glances when the webcam can't track your eyes** | The headset reads eye movement directly from the skin, whatever the lighting or the face is covered by | **Built**, but needs eye electrodes the new layout doesn't have (section 4) |

**Be honest about what it reads.** With the new layout this is a real brain signal, so "brain-controlled" becomes fair **once it works on our own data**, and only for the confirm step: the eyes still choose. The current code reads **muscle (EMG)** and **eye-movement (EOG)** signals, so don't say it about the current demo.

**Expect "your SSVEP failed, why will this work?"** Don't answer with confidence we haven't earned. Answer with the go/no-go numbers:

> "We started with SSVEP. Over 185 trials and 3 sessions, our setup picked up mains hum about 1,000 times bigger than the response, and no decoder beat 32% on 7 targets (chance is 14%). So we tested imagined movement the same way, and here's what we measured." *(Fill in after the test.)*

(SSVEP numbers from the team's experiments, on the pivot slide.)

### What the research says about imagery in ALS

Know these before a judge raises them, and don't claim better:

- In a study of **25 ALS patients**, average motor-imagery accuracy was **about 60%**; better features and models reach the 70s on ALS data.
- ALS damages motor cortex neurons, and ERD (the rhythm drop we'd measure) is **reduced overall** in ALS.
- In one study of 12 locked-in patients, **3 could communicate with motor imagery; 9 could with a touch-based P300 BCI**.
- We're testing on healthy teammates. **A result on us doesn't show it works for someone with ALS.** Say so.

### Room to grow: brain signals (a prepared answer for Q&A)

**Use this when someone asks why we don't drop the EEG kit to save money.** A cheap muscle sensor can't read the motor cortex at all, so it can't do the core of this design. With EEG hardware on the person's head, the signals below are **software updates**, not a new device. We couldn't build them in a 48-hour hackathon.

**The strongest reason: ALS is progressive.** Muscles fail over time, including the jaw, especially in bulbar-onset ALS. The eyes usually last longer, but they can fail too in late-stage disease, and that's when an eye tracker stops working. A system built on muscles stops working for the person as the disease advances; one on EEG hardware has a path forward without replacing anything.

What the same hardware could add:

| Possible feature | What it would do | How hard |
|---|---|---|
| **Eyes-closed stop** | Close your eyes for 2 s and the arm halts, from the brain's alpha rhythm. Needs no muscles at all | Small: alpha is strong (10–50 µV) and we've seen it on our own headset |
| **Brain-signal selection (SSVEP), done properly** | Choose an object by looking at a flickering patch, with no eye tracker. Our attempt failed on hardware noise (mains hum, dry electrodes), not on the idea; working setups get 2–5× the response we measured | Medium: needs gel electrodes, better grounding and shielding |
| **Error detection** | The brain produces a distinct response when it sees a mistake (an "error-related potential"). The arm could notice the person's reaction to a wrong pick and undo it on its own | Hard: research-level, needs careful recording |
| **Fatigue and attention** | Notice when the person is tiring and slow down, or ask before acting | Medium: changes in brain rhythms over time |

> **Answer:** "A muscle sensor would be cheaper, but ALS takes the muscles over time, including the jaw. Our confirm signal comes from the motor cortex, which a muscle sensor can't read. And with EEG hardware already on the head, adding more brain signals is a software update, not a new device."

*(If imagery fails the go/no-go test, go back to: "We built what works reliably today, and the hardware is there for brain signals next.")*

**Keep it honest:** say "could" and "the hardware supports", never "Reach does". None of these is built, and our own SSVEP attempt didn't work, so don't promise accuracy numbers. Also note that imagery can degrade in ALS (section 3), so "brain signals remain when no muscle works" is a hope to research, not a guarantee.

## 4. The eye-tracking fallback

**Status: built, but at risk under the new plan.** It needs electrodes at the eye corners. With 3 channels on C3, C4 and Cz there are none left, so **the fallback and its demo moment are off unless we get a 4th electrode**. One eye-corner electrode might still tell left from right, but `tools/eog.py` hasn't been tested that way.

**When the webcam can't track your eyes, Reach switches to the headset.** The middle object is highlighted; **flick your eyes left or right** to move the highlight one object that way; **clench to pick** (imagined right hand under the new plan).

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
| Tracking too shaky for 1.5 s (cursor jumping far more than during calibration) | **Built** (sim) |
| Picture too dark for 1 s (below ~40% of the brightness during calibration, not a fixed number) | **Built** (sim) |
| Switch back only after everything looks good for 2 s, with a higher bar than for switching away (e.g. back above 55% brightness), so it doesn't flicker between modes | **Built** (sim) |
| Show why on screen, e.g. "Too dark for the webcam: using eye glances" | **Built** (sim) |
| If glances aren't set up (no eye electrodes or eye check), stay on the webcam and warn instead | **Built** (sim) |
| **G** key forces glance mode on or off | **Built** |

### Demo moment

Halfway through the demo, **cover the webcam with your hand.** The cursor disappears, the headset takes over, and the person still picks an object by eye glances and a clench. This shows judges the headset keeps the person in control when the camera can't see them.

## 5. Place anywhere (Built in the sim)

1. After the pick, the arm **parks holding the cube**, out of the camera's way. The camera tab shows **small green dots** wherever the cube can go, plus the basket.
2. **The person looks at a spot.** The gaze snaps to the nearest candidate spot (a grid around the arm, about 4 cm apart). **Known problem:** on a laptop those spots are only about 30 px apart on screen, far closer than the eye tracker's current ~160 px error, so choosing a precise spot by eye doesn't work well yet; it needs a bigger view and/or coarser spots. A **ghost cube** shows there: **green if it passes the checks, red with the reason if not** (e.g. "too close to 2").
   - **Reachable:** the arm can lower it there within 5 mm.
   - **Free:** at least 6 cm from every other cube the camera saw.
   - **On the table:** off the arm's base board and the table edge, clear of the basket.
   - **Visible:** the whole cube inside the camera's view.
3. **Confirm to put it there**, or cancel within the window (current code: clench, then clench again within 3 s; planned: imagined right hand, then left hand). Confirming on a red spot is refused, with the reason. The basket stays as one of the options; Esc puts it in the basket.
4. **With eye glances** (webcam can't see the eyes), the highlight steps through 4 suggested spots plus the basket, left to right.

This shows the person decides where things go, rather than the arm being limited to fixed spots. Like the pick, every check uses only what the camera saw.

**Tested in the sim:** the cube landed **1 mm** from the chosen spot; a red spot was refused with its reason; the glance version chose the basket and landed. With 4 cubes on the table, about 12 of 72 table spots pass (most fail for being next to another cube, on the arm's base, or by the basket).

## 6. What to call it

Say **assistive robotic arm** (or "hands-free robotic arm"). **Not "bionic arm".**

A bionic arm is a prosthetic worn by an amputee. Reach sits on a table or wheelchair and acts for someone who can't move their own arms. Calling it bionic puts us in the wrong market, next to the wrong competitors.

## 7. What's new: claim the gap, not "it doesn't exist"

Gaze-controlled robot arms already exist in research:

- a wheelchair-mounted 6-DOF arm controlled by eye gaze (2021)
- Stanford ARMLab's demo combining HoloLens gaze, an EMG armband and a Kinova JACO
- a 2024 review of the whole field (Fischer-Janzen et al.)

We found **no one selling one**, and certainly not affordably. The 2024 review names the field's main unsolved problem: the **"Midas touch"**, where the system mistakes ordinary looking for a command. **A separate confirm signal is our answer**: eyes choose, an imagined hand movement confirms.

> "Research has shown that gaze can control a robot arm. Nobody ships it, partly because of the Midas-touch problem: the system can't tell looking from choosing. We separate the two: your eyes choose and your motor cortex confirms, using signals that outlast hand function in ALS, for a fraction of the price."

Don't say "this doesn't exist". One search disproves it. **Still to check:** gaze plus motor imagery has very likely been tried in research too, and we haven't searched for it yet. Look before claiming anything new here. "Outlast hand function" also needs care: see section 3.

## 8. Cost

| Product | What it does | Price |
|---|---|---|
| **Kinova JACO** | General assistive arm, joystick control | **~$35,000**; others in this class sell for $40,000+; often not covered by US insurance |
| **Obi** | Feeding only, controlled by switches | **~$8,000–9,600** (Obi 3, current retail listings) |
| **Reach** | Any object on the table, hands-free, by gaze plus imagined movement (planned; clench today) | **~$1,250 in parts** with our current kit |

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
| "Is this mind control?" | Partly, and only say so once it works. Eyes choose; an imagined hand movement confirms. It only detects that one trained signal; it can't read thoughts. |
| "How accurate is it?" | Give our measured go/no-go numbers and say they come from healthy teammates. Published ALS results are around 60–75% (section 3), which is why the eyes do the choosing and there's a cancel step. |
| "Does it work for someone with ALS?" | We haven't tested with anyone with ALS. Imagery signals are weaker in ALS and some people can't use them, so it would need testing with patients, and per-person training. |
| "Why did your SSVEP fail, and why is this different?" | Show the data (section 3). Don't argue from theory. |
| "Can you stop it once it's moving?" | **Not yet in the sim:** you can cancel before it moves. Don't claim a mid-move stop until it's built. The printed arm's hardware stop button is planned, but it's for a caregiver: someone with ALS may not be able to press it, and imagery may be too slow to stop a move. |
| "What about people for whom imagery doesn't work?" | The software takes the confirm signal as an input, so a clench, a switch or a long gaze could replace it. The clench exists today; the others aren't built, so say "designed for", not "does". |
| "What if it's dark?" | The arm needs the table lit, like any camera system; a phone flashlight or a cheap LED does it. The fallback is for when the face isn't visible but the table is (section 4). |
| "iPhones have Face ID, which works in the dark." | The front camera's infrared light is only available to native iOS apps, not the browser our eye tracker runs in. A native app could use it later; the headset fallback works with any webcam. |
| "Why not just turn the screen brightness up?" | It helps in dim rooms, but not with backlight, glasses glare or a breathing mask. |
| "Why not a cheaper muscle sensor instead of an EEG kit?" | A muscle sensor can't read the motor cortex, and ALS takes the muscles over time. With EEG hardware on the head, more brain signals are a software update (see "Room to grow" in section 3). |
| "Isn't this a bionic arm?" | No: an assistive robotic arm for people who can't move their own arms (section 6). |

## 11. Ideas, open questions and dropped options

| Item | Status |
|---|---|
| **Build motor imagery:** recording and go/no-go test, detector, `--montage` for C3/C4/Cz, then replace the clench in the sim | **Planned**: nothing built yet |
| **Third electrode: Cz or an eye corner.** Cz helps decoding; an eye corner might keep the glance fallback. Current lean: Cz, and ask for a 4th electrode | **Open** |
| **Deck still pitches eyes + clench** | **Open**: update after the go/no-go test |
| **Stop the arm mid-move** with a clench or Esc. Today both only act before the arm moves: Esc stops after the current pick, and a clench during a move does nothing. The deck's safety slide says "Esc stops the arm at once", which isn't true yet | **Open**: build it or change the slide |
| **Close your eyes for 2 s to stop the arm** (eyes-closed alpha rhythm): a brain signal, and a possible stop that needs no muscles. Needs one more electrode at Oz | **Idea**: not building it now; it's in the "Room to grow" Q&A answer (section 3) as future work |
| **Skip the headset, use stick-on electrodes** (~$770 total) | **Dropped**: the headset is part of the product |
| **Replace the headset with a cheap muscle sensor** (~$150–200 total) | **Dropped**: same reason; loses the eye-glance fallback |
| **SSVEP (flicker) selection** | **Dropped** after the team's experiments (section 3) |
| **Three Territories game** is no longer in the deck (only "a game piece" on the problem slide) | **Open**: confirm with the team whether that's intentional |
| **PLAN.md still describes SSVEP** | **Open**: needs updating to the eyes + motor imagery design |
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
- [Motor imagery EEG in 25 ALS patients (Sensors 2017)](https://www.mdpi.com/1424-8220/17/7/1557)
- [Vibro-tactile P300 and motor imagery in 12 locked-in patients (Frontiers 2017)](https://www.frontiersin.org/articles/10.3389/fnins.2017.00251)
- [Eye tracking loses effectiveness as eye movement declines; intracortical BCI in completely locked-in ALS (Nature Communications 2022)](https://www.nature.com/articles/s41467-022-28859-8)
- [OpenBCI tutorial: motor imagery training repeats](https://openbci.com/community/use-your-imagination-power-to-control-robots-and-devices/)
