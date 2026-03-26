/**
 * Tauri API shim — provides match state management and voice command events.
 *
 * In this Electron prototype there is no Tauri backend; all match state is
 * managed client-side.  This module re-exports the same surface that the
 * hooks (`useMatchState`, `useVoiceCommands`) expect so they compile without
 * changes.
 */

import type { MatchStatus } from './types';

// ── Types ────────────────────────────────────────────────────────────

export interface MatchState {
  status: MatchStatus;
  score_a: number;
  score_b: number;
  elapsed_seconds: number;
  team_a_name: string;
  team_b_name: string;
  last_command: string | null;
}

// ── Simple typed event bus ───────────────────────────────────────────

type Listener<T> = (payload: T) => void;

class EventBus<T> {
  private listeners = new Set<Listener<T>>();

  on(cb: Listener<T>): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  emit(payload: T): void {
    for (const cb of this.listeners) cb(payload);
  }
}

// ── Singleton match state ────────────────────────────────────────────

const INITIAL_STATE: MatchState = {
  status: 'idle',
  score_a: 0,
  score_b: 0,
  elapsed_seconds: 0,
  team_a_name: 'Time A',
  team_b_name: 'Time B',
  last_command: null,
};

let state: MatchState = { ...INITIAL_STATE };
let timerInterval: ReturnType<typeof setInterval> | null = null;

const matchStateBus = new EventBus<MatchState>();
const timerTickBus = new EventBus<{ elapsed_seconds: number }>();
const voiceTextBus = new EventBus<{ text: string }>();
const commandUnknownBus = new EventBus<{ text: string }>();

function emit(): void {
  matchStateBus.emit({ ...state });
}

function startTimer(): void {
  if (timerInterval) return;
  timerInterval = setInterval(() => {
    state = { ...state, elapsed_seconds: state.elapsed_seconds + 1 };
    timerTickBus.emit({ elapsed_seconds: state.elapsed_seconds });
    emit();
  }, 1000);
}

function stopTimer(): void {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

// ── Public API (match control) ───────────────────────────────────────

export function getMatchState(): Promise<MatchState> {
  return Promise.resolve({ ...state });
}

export function onMatchStateChanged(cb: (s: MatchState) => void): Promise<() => void> {
  return Promise.resolve(matchStateBus.on(cb));
}

export function onTimerTick(cb: (p: { elapsed_seconds: number }) => void): Promise<() => void> {
  return Promise.resolve(timerTickBus.on(cb));
}

export function startMatch(): void {
  if (state.status === 'finished' || state.status === 'idle') {
    state = { ...INITIAL_STATE };
  }
  state = { ...state, status: 'playing', last_command: 'start' };
  startTimer();
  emit();
}

export function endMatch(): void {
  state = { ...state, status: 'finished', last_command: 'end' };
  stopTimer();
  emit();
}

export function goalA(): void {
  state = { ...state, score_a: state.score_a + 1, last_command: 'goalA' };
  emit();
}

export function goalB(): void {
  state = { ...state, score_b: state.score_b + 1, last_command: 'goalB' };
  emit();
}

export function restart(): void {
  state = { ...INITIAL_STATE, status: 'playing', last_command: 'restart' };
  startTimer();
  emit();
}

export function challenge(): void {
  state = { ...state, status: 'challenge', last_command: 'challenge' };
  stopTimer();
  emit();

  // Auto-resolve after 5 s
  setTimeout(() => {
    if (state.status === 'challenge') {
      resolveChallenge();
    }
  }, 5000);
}

export function resolveChallenge(): void {
  state = { ...state, status: 'playing', last_command: 'resolveChallenge' };
  startTimer();
  emit();
}

// ── Voice events (wired to transcriber by the app) ──────────────────

export function onVoiceText(cb: (p: { text: string }) => void): Promise<() => void> {
  return Promise.resolve(voiceTextBus.on(cb));
}

export function onCommandUnknown(cb: (p: { text: string }) => void): Promise<() => void> {
  return Promise.resolve(commandUnknownBus.on(cb));
}

/**
 * Feed a raw transcription into the voice event bus (called from the
 * transcriber layer after parsing commands).
 */
export function dispatchVoiceText(text: string): void {
  voiceTextBus.emit({ text });
}

export function dispatchCommandUnknown(text: string): void {
  commandUnknownBus.emit({ text });
}

// ── Platform check ───────────────────────────────────────────────────

export function isTauri(): boolean {
  // In this Electron prototype voice commands are always available.
  return true;
}
