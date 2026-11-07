"""Quick Ganglion signal check: streams EEG and prints per-channel quality once a second.

Usage:
  python tools/eeg_check.py --port /dev/cu.usbmodemXXXX   # with the BLED112 dongle
  python tools/eeg_check.py --native                      # no dongle (Mac Bluetooth)

Close the OpenBCI GUI first: only one program can hold the Ganglion connection.
Ctrl+C to stop; raw data is saved to logs/ (git-ignored).

What to look for (channel map from PLAN.md: 1=O1, 2=Oz, 3=O2, 4=T7):
  eeg     typical signal size in uV after 1-45 Hz filtering (robust, ignores spikes).
          Good dry-electrode EEG: roughly 5-30. Hundreds = poor contact.
  hum     60 Hz mains pickup in uV before filtering. Big hum (>100) means high electrode
          impedance (poor contact) or a mains source nearby: unplug the laptop charger.
  alpha   8-12 Hz power vs neighbouring bands. Close your eyes for 10 s: O1/Oz/O2
          should rise clearly (often 2x or more). This is the best test of contact.
  emg     30-90 Hz RMS. Clench your jaw: ch4 (T7) should jump several times over.
  flag    RAILED = input at the limit (no contact), HUM, noisy, or ok.
"""
import argparse
import warnings
warnings.filterwarnings("ignore", message="pkg_resources is deprecated")
import os
import time

import numpy as np
from brainflow.board_shim import BoardIds, BoardShim, BrainFlowInputParams
from scipy.signal import butter, detrend, iirnotch, sosfiltfilt, filtfilt

NAMES = ["O1", "Oz", "O2", "T7"]
WINDOW_S = 4


def band_power(freqs, psd, lo, hi):
    m = (freqs >= lo) & (freqs < hi)
    return psd[m].mean() if m.any() else 0.0


def analyse(x, fs):
    """Return (noise_uv, hum_uv, rail_pct, alpha_ratio, emg_uv) for one channel window."""
    rail = 100.0 * np.mean(np.abs(x) > 15000)  # Ganglion input range is about +/-15.7 mV
    x = detrend(x)
    freqs = np.fft.rfftfreq(len(x), 1 / fs)
    amp = np.abs(np.fft.rfft(x * np.hanning(len(x)))) * 4 / len(x)  # approx sine amplitude
    hum = amp[(freqs > 59) & (freqs < 61)].max()

    b, a = iirnotch(60, 30, fs)
    x = filtfilt(b, a, x)
    eeg = sosfiltfilt(butter(4, [1, 45], "bandpass", fs=fs, output="sos"), x)
    emg = sosfiltfilt(butter(4, [30, 90], "bandpass", fs=fs, output="sos"), x)
    noise = 1.4826 * np.median(np.abs(eeg - np.median(eeg)))  # robust SD: ignores short spikes

    psd = np.abs(np.fft.rfft(eeg * np.hanning(len(eeg)))) ** 2
    alpha = band_power(freqs, psd, 8, 12) / max(
        (band_power(freqs, psd, 4, 7) + band_power(freqs, psd, 14, 20)) / 2, 1e-12)
    return noise, hum, rail, alpha, np.sqrt(np.mean(emg ** 2))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", help="dongle serial port, e.g. /dev/cu.usbmodem11")
    ap.add_argument("--native", action="store_true", help="use Mac Bluetooth, no dongle")
    ap.add_argument("--fw", choices=["2", "3"], help="Ganglion firmware version if auto fails")
    ap.add_argument("--tries", type=int, default=3, help="connection attempts")
    ap.add_argument("--seconds", type=float, default=0, help="stop after N seconds (0 = run until Ctrl+C)")
    args = ap.parse_args()

    params = BrainFlowInputParams()
    params.timeout = 15
    if args.fw:
        params.other_info = f"fw:{args.fw}"
    if args.native:
        board_id = BoardIds.GANGLION_NATIVE_BOARD.value
    else:
        if not args.port:
            ap.error("give --port (dongle) or --native")
        board_id = BoardIds.GANGLION_BOARD.value
        params.serial_port = args.port

    fs = BoardShim.get_sampling_rate(board_id)
    chans = BoardShim.get_eeg_channels(board_id)[:4]
    BoardShim.disable_board_logger()
    board = None
    for attempt in range(1, args.tries + 1):
        board = BoardShim(board_id, params)
        print(f"Connecting, attempt {attempt}/{args.tries} (can take ~10-20 s)...")
        try:
            board.prepare_session()
            board.start_stream(45000)
            break
        except Exception as e:  # BrainFlowError; BLE on macOS is flaky, so retry from scratch
            print(f"  failed: {e}")
            try:
                if board.is_prepared():
                    board.release_session()
            except Exception:
                pass
            if attempt == args.tries:
                print("\nCould not start streaming. Check: OpenBCI GUI fully quit, Ganglion LED blinking,"
                      " laptop within 1 m, Bluetooth toggled off/on. Then power-cycle the Ganglion.")
                return
            time.sleep(3)
    print(f"Streaming at {fs} Hz. Close eyes / clench jaw to test. Ctrl+C to stop.\n")

    chunks = []
    t_end = time.time() + args.seconds if args.seconds else None
    try:
        time.sleep(WINDOW_S)
        while t_end is None or time.time() < t_end:
            data = board.get_board_data()  # drains the buffer
            if data.shape[1]:
                chunks.append(data)
            recent = np.concatenate(chunks, axis=1)[:, -WINDOW_S * fs:] if chunks else None
            if recent is None or recent.shape[1] < fs * 2:
                print("  ...no data yet (check the Ganglion is on and in range)")
            else:
                rows = []
                for name, ch in zip(NAMES, chans):
                    noise, hum, rail, alpha, emg = analyse(recent[ch], fs)
                    flag = "RAILED" if rail > 1 else ("HUM" if hum > 100 else ("ok" if noise < 30 else "noisy"))
                    rows.append(f"{name}: eeg {noise:5.0f}uV hum {hum:6.0f}uV alpha {alpha:3.1f}x emg {emg:5.0f}uV {flag:6s}")
                print(" | ".join(rows))
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        board.stop_stream()
        board.release_session()
        if chunks:
            os.makedirs("logs", exist_ok=True)
            path = time.strftime("logs/eeg_check_%Y%m%d_%H%M%S.csv")
            np.savetxt(path, np.concatenate(chunks, axis=1).T, delimiter=",")
            print(f"\nSaved raw data to {path}")


if __name__ == "__main__":
    main()
