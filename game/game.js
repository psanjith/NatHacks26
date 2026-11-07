// Pure game rules and action workflow. No DOM, EEG, or motor control here.
(function (root) {
  'use strict';
  const VALUES = Object.freeze({ A: 3, B: 4, C: 5 });
  class Game {
    constructor(sessionId = globalThis.crypto.randomUUID()) {
      this.sessionId = sessionId;
      this.sequence = 0;
      this.match = 0;
      this.startingPlayer = 1;
      this.newGame();
    }
    newGame() {
      if (this.s && (this.s.pending || this.s.phase === 'paused')) return false;
      if (this.match) this.startingPlayer = 3 - this.startingPlayer;
      this.match += 1;
      this.s = {
        phase: 'idle', player: this.startingPlayer, selected: null, pending: null,
        remaining: { 1: 6, 2: 6 },
        territories: { A: { 1: 0, 2: 0 }, B: { 1: 0, 2: 0 }, C: { 1: 0, 2: 0 } }
      };
      return true;
    }
    snapshot() { return JSON.parse(JSON.stringify(this.s)); }
    scores() {
      const scores = { 1: 0, 2: 0 };
      for (const [zone, value] of Object.entries(VALUES)) {
        const counts = this.s.territories[zone];
        if (counts[1] > counts[2]) scores[1] += value;
        if (counts[2] > counts[1]) scores[2] += value;
      }
      return scores;
    }
    select(zone) {
      if (!Object.hasOwn(VALUES, zone) || !['idle', 'selected', 'failed'].includes(this.s.phase)) return false;
      this.s.selected = zone;
      this.s.phase = 'selected';
      return true;
    }
    cancel() {
      if (!['selected', 'failed'].includes(this.s.phase)) return false;
      this.s.selected = null;
      this.s.phase = 'idle';
      return true;
    }
    confirm() {
      if (!['selected', 'failed'].includes(this.s.phase)) return null;
      const action = {
        id: `${this.sessionId}:${this.match}:${++this.sequence}`,
        player: this.s.player, zone: this.s.selected
      };
      this.s.pending = action;
      this.s.phase = this.s.player === 1 ? 'running' : 'awaiting_result';
      return { ...action };
    }
    motionComplete(id) {
      if (this.s.phase !== 'running' || this.s.pending?.id !== id) return false;
      this.s.phase = 'awaiting_result';
      return true;
    }
    resolve(id, placed) {
      if (typeof placed !== 'boolean' || this.s.phase !== 'awaiting_result' || this.s.pending?.id !== id) return false;
      const action = this.s.pending;
      this.s.pending = null;
      if (!placed) {
        this.s.phase = 'failed';
        return true;
      }
      this.s.territories[action.zone][action.player] += 1;
      this.s.remaining[action.player] -= 1;
      this.s.selected = null;
      if (this.s.remaining[1] === 0 && this.s.remaining[2] === 0) {
        this.s.phase = 'finished';
      } else {
        this.s.player = 3 - action.player;
        this.s.phase = 'idle';
      }
      return true;
    }
    pause() {
      if (['paused', 'finished'].includes(this.s.phase)) return false;
      this.s.phase = 'paused';
      return true;
    }
    // An interruption never guesses whether the token was physically placed.
    reconcile(placed) {
      if (this.s.phase !== 'paused') return false;
      if (this.s.pending) {
        if (typeof placed !== 'boolean') return false;
        this.s.phase = 'awaiting_result';
        return this.resolve(this.s.pending.id, placed);
      }
      this.s.phase = this.s.selected ? 'selected' : 'idle';
      return true;
    }
  }
  const api = { Game, VALUES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ReachRules = api;
})(globalThis);
