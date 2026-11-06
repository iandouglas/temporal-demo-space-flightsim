import { api } from '../shared/api';
import type { GameEvent, Snapshot } from './game';

/** `name` is the email username (or initials). The full email is never sent back. */
export interface LeaderboardEntry { session_id: string; name: string; score: number; station: string; deploys: number; at: string }
export interface DayPodium { day: string; label: string; top: LeaderboardEntry[] }
export interface LeaderboardView { entries: LeaderboardEntry[]; day_label: string; champions: DayPodium[]; total_games: number }
export interface SessionState extends Snapshot {
  session_id: string; status: string; game_ms: number; seq: number; event_log: string[];
  history_events: number; activities_total: number; activities_pending: number; workflow_id?: string; name?: string;
}
/** What the FlightSessionWorkflow ran for this game (from its `summary` query). */
export interface ActivitySummary {
  workflow_id: string; history_events: number; total: number; pending: number; failed: number;
  total_retries: number; counts: Record<string, number>; retries: Record<string, number>;
}
export interface FinishResult { rank: number | null; score: number; name: string; top: LeaderboardEntry[] }

const SESSION_KEY = 'flight.session';
const LOCAL_LB_KEY = 'flight.localLeaderboard';

/** Offline stand-in for the server's naming rule (no blocklist offline, so fall back to a callsign). */
function localName(email: string): string {
  const u = email.split('@')[0].split('+')[0].replace(/[^A-Za-z0-9._-]/g, '').slice(0, 16);
  return u || `Pilot-${1000 + Math.floor(Math.random() * 9000)}`;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

/**
 * Backend client. Every call is optional: if the Holodeck API or Temporal is
 * unreachable, the game keeps running and scores go to a local leaderboard.
 */
export class FlightNet {
  online = true;
  sessionId: string | null = null;
  workflowId: string | null = null;
  lastState: SessionState | null = null;
  private seq = 0;
  private inFlight = false;
  private pendingEvents: GameEvent[] = [];
  onStatus: (online: boolean) => void = () => {};

  private setOnline(v: boolean) { if (v !== this.online) { this.online = v; this.onStatus(v); } }

  /** Leaderboard name for this flight (email username or callsign), set at launch. */
  name = '';

  /**
   * Start the session workflow with the visitor's email (required). The
   * workflow saves the lead right away and picks the leaderboard name.
   */
  async createSession(email: string, consentVersion: string): Promise<boolean> {
    this.seq = 0;
    this.pendingEvents = [];
    this.name = localName(email);
    try {
      const r = await withTimeout(api<{ session_id: string; workflow_id: string; name: string }>('/flight/sessions', { email, consent_text_version: consentVersion }), 2500);
      this.sessionId = r.session_id;
      this.workflowId = r.workflow_id;
      this.name = r.name;
      this.remember();
      this.setOnline(true);
      return true;
    } catch {
      this.sessionId = null;
      this.setOnline(false);
      return false;
    }
  }

  /** Fire-and-forget; only one request in flight, newest snapshot wins. */
  sendTelemetry(snap: Snapshot, events: GameEvent[]): void {
    this.pendingEvents.push(...events);
    if (!this.sessionId || this.inFlight) return;
    this.inFlight = true;
    // Cap the batch (the workflow validator rejects >120); the rest goes next second.
    const body = { ...snap, seq: ++this.seq, events: this.pendingEvents.splice(0, 100) };
    withTimeout(api<SessionState>(`/flight/sessions/${this.sessionId}/telemetry`, body), 4000)
      .then((st) => { this.lastState = st; this.setOnline(true); })
      .catch((e: Error) => {
        // 409 = the workflow rejected the batch (validation); not a network problem.
        if (!e.message.startsWith('409')) { this.pendingEvents.unshift(...body.events); this.setOnline(false); }
      })
      .finally(() => { this.inFlight = false; });
  }

  async flushFinal(snap: Snapshot, events: GameEvent[]): Promise<void> {
    if (!this.sessionId) return;
    for (let i = 0; i < 20 && this.inFlight; i++) await new Promise((r) => setTimeout(r, 100));
    this.pendingEvents.push(...events);
    try {
      this.lastState = await withTimeout(api<SessionState>(`/flight/sessions/${this.sessionId}/telemetry`, { ...snap, seq: ++this.seq, events: this.pendingEvents.splice(0, 120) }), 4000);
    } catch { /* the finish call still carries the score */ }
  }

  async summary(): Promise<ActivitySummary | null> {
    if (!this.sessionId) return null;
    try {
      return await withTimeout(api<ActivitySummary>(`/flight/sessions/${this.sessionId}/summary`), 2500);
    } catch { return null; }
  }

  async getSession(id: string): Promise<SessionState | null> {
    try {
      const st = await withTimeout(api<SessionState>(`/flight/sessions/${id}`), 2500);
      this.setOnline(true);
      return st;
    } catch { return null; }
  }

  adopt(st: SessionState): void {
    this.name = st.name ?? this.name;
    this.sessionId = st.session_id;
    this.workflowId = st.workflow_id ?? null;
    this.seq = st.seq;
    this.lastState = st;
    this.remember();
  }

  /** Post the final score (the workflow already knows the name). */
  async finish(snap: Snapshot): Promise<FinishResult> {
    if (this.sessionId) {
      try {
        const r = await withTimeout(api<FinishResult>(`/flight/sessions/${this.sessionId}/finish`, {}), 8000);
        this.forget();
        this.saveLocal({ session_id: this.sessionId ?? 'x', name: r.name, score: r.score, station: 'here', deploys: snap.deploys, at: new Date().toISOString() });
        return r;
      } catch { this.setOnline(false); }
    }
    this.forget();
    const id = crypto.randomUUID();
    const top = this.saveLocal({ session_id: id, name: this.name, score: snap.score, station: 'offline', deploys: snap.deploys, at: new Date().toISOString() });
    const rank = top.findIndex((e) => e.session_id === id);
    return { rank: rank >= 0 ? rank + 1 : null, score: snap.score, name: this.name, top };
  }

  async leaderboard(): Promise<LeaderboardView> {
    try {
      const r = await withTimeout(api<LeaderboardView>('/flight/leaderboard'), 2500);
      this.setOnline(true);
      return r;
    } catch {
      this.setOnline(false);
      return { entries: this.loadLocal(), day_label: 'Today (offline)', champions: [], total_games: 0 };
    }
  }

  storedSessionId(): string | null {
    try { return sessionStorage.getItem(SESSION_KEY); } catch { return null; }
  }
  private remember(): void { try { if (this.sessionId) sessionStorage.setItem(SESSION_KEY, this.sessionId); } catch { /* ignore */ } }
  forget(): void { try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ } }

  private loadLocal(): LeaderboardEntry[] {
    try { return JSON.parse(localStorage.getItem(LOCAL_LB_KEY) ?? '[]') as LeaderboardEntry[]; } catch { return []; }
  }
  private saveLocal(e: LeaderboardEntry): LeaderboardEntry[] {
    const top = [...this.loadLocal().filter((x) => x.session_id !== e.session_id && x.name), e]
      .sort((a, b) => b.score - a.score || a.at.localeCompare(b.at)).slice(0, 10);
    try { localStorage.setItem(LOCAL_LB_KEY, JSON.stringify(top)); } catch { /* ignore */ }
    return top;
  }
}
