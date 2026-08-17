import { SCHEMA_VERSION, validateRegisterEnvelope } from '../domain/schema.js';

export class StandingsReducer {
  constructor({ pointsByPosition = { 1: 10, 2: 8, 3: 6, 4: 5, 5: 4, 6: 3, 7: 2, 8: 1 } } = {}) {
    this.pointsByPosition = { ...pointsByPosition };
  }

  reduce(observations) {
    const events = new Map();
    const snapshotRows = new Map();
    for (const observation of observations) {
      if (observation.kind === 'event_result') events.set(observation.eventKey, structuredClone(observation.entries));
      if (observation.kind === 'amendment') {
        const entries = events.get(observation.eventKey) ?? [];
        const index = entries.findIndex(entry => entry.subject === observation.subject);
        const next = { ...(index >= 0 ? entries[index] : { subject: observation.subject }), ...structuredClone(observation.newValue) };
        if (index >= 0) entries[index] = next;
        else entries.push(next);
        events.set(observation.eventKey, entries);
      }
      if (observation.kind === 'snapshot') {
        if (observation.completeness === 'complete') snapshotRows.clear();
        for (const row of observation.values) snapshotRows.set(row.subject, { ...(snapshotRows.get(row.subject) ?? {}), ...structuredClone(row) });
      }
    }
    const points = new Map();
    for (const entries of events.values()) {
      for (const entry of entries) {
        if (entry.disqualified || !Number.isInteger(entry.position)) continue;
        points.set(entry.subject, (points.get(entry.subject) ?? 0) + (this.pointsByPosition[entry.position] ?? 0));
      }
    }
    for (const [subject, row] of snapshotRows) if (Number.isFinite(row.points)) points.set(subject, row.points);
    const standings = [...points].map(([subject, value]) => ({ subject, points: value }))
      .sort((a, b) => b.points - a.points || a.subject.localeCompare(b.subject))
      .map((row, index) => ({ ...row, position: index + 1 }));
    return { events: Object.fromEntries(events), standings, roundsCompleted: events.size, partialSnapshotRows: Object.fromEntries(snapshotRows) };
  }
}

export class TournamentReducer {
  reduce(observations) {
    const matches = {};
    let champion = null;
    for (const observation of observations) {
      if (observation.kind !== 'event_result') continue;
      const winner = observation.entries.find(entry => entry.result === 'win')?.subject ?? observation.winner ?? null;
      matches[observation.eventKey] = { entries: structuredClone(observation.entries), round: observation.round ?? null, winner };
      if (observation.round === 'final' && observation.complete === true) champion = winner;
    }
    return { matches, champion, finalPending: Object.values(matches).some(match => match.round === 'final') && !champion };
  }
}

export class RegisterStore {
  #registers = new Map();
  #reducers = new Map();

  registerReducer(type, reducer) {
    if (!reducer?.reduce) throw new TypeError('Reducer must expose reduce(observations)');
    this.#reducers.set(type, reducer);
  }

  create({ key, type, lifecycle = 'active', injectionPolicy = 'relevant' }) {
    if (this.#registers.has(key)) throw new Error(`Register already exists: ${key}`);
    const register = { key, type, lifecycle, injectionPolicy, observations: [], projection: {}, schemaVersion: SCHEMA_VERSION };
    validateRegisterEnvelope(register, { throwOnError: true });
    this.#registers.set(key, register);
    this.#recompute(register);
    return this.get(key);
  }

  apply(observation) {
    const register = this.#registers.get(observation.registerKey);
    if (!register) throw new Error(`Unknown register: ${observation.registerKey}`);
    register.observations.push(structuredClone(observation));
    this.#recompute(register);
    return this.get(register.key);
  }

  applyEpisode(observations = []) {
    const touched = new Set();
    for (const observation of observations) {
      this.apply(observation);
      touched.add(observation.registerKey);
    }
    return [...touched].map(key => this.get(key));
  }

  setLifecycle(key, lifecycle) {
    const register = this.#require(key);
    register.lifecycle = lifecycle;
    validateRegisterEnvelope(register, { throwOnError: true });
    return this.get(key);
  }

  setInjectionPolicy(key, policy) {
    if (!['always', 'relevant', 'manual', 'archived'].includes(policy)) throw new TypeError('Invalid register injection policy');
    this.#require(key).injectionPolicy = policy;
    return this.get(key);
  }

  selectForInjection({ relevantKeys = [], manualKeys = [] } = {}) {
    const relevant = new Set(relevantKeys);
    const manual = new Set(manualKeys);
    return [...this.#registers.values()].filter(register => {
      if (register.lifecycle === 'archived' && register.injectionPolicy !== 'archived') return false;
      if (register.injectionPolicy === 'always') return true;
      if (register.injectionPolicy === 'manual') return manual.has(register.key);
      if (register.injectionPolicy === 'archived') return register.lifecycle === 'archived' && (manual.has(register.key) || relevant.has(register.key));
      return relevant.has(register.key);
    }).map(register => structuredClone(register));
  }

  get(key) {
    const value = this.#registers.get(key);
    return value ? structuredClone(value) : null;
  }

  #recompute(register) {
    const reducer = this.#reducers.get(register.type);
    register.projection = reducer ? reducer.reduce(register.observations) : { observations: structuredClone(register.observations) };
  }

  #require(key) {
    const register = this.#registers.get(key);
    if (!register) throw new Error(`Unknown register: ${key}`);
    return register;
  }
}
