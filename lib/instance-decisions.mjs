// Native question receipts, not execution grants. Never reconstruct live authorization from transcript text.
import { createHash, randomUUID } from 'node:crypto';
const STORES = Symbol.for('mina:instance-decisions');
const canonical = (v) => JSON.stringify(v, (_key, x) => x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x);

export function createDecisionStore(instanceId = randomUUID()) {
  const records = new Map(), inflight = new Map(), recovered = new Map();
  const copy = (x) => structuredClone(x);
  return {
    instanceId,
    get: (id) => records.has(id) ? copy(records.get(id)) : null,
    snapshot: () => ({ instanceId, records: copy([...records.values()]), recovered: copy([...recovered.values()]) }),
    // Old receipts are recovery information only. They cannot answer a question in a new instance.
    recover(snapshot) {
      let added = 0;
      const entries = [...(Array.isArray(snapshot?.records) ? snapshot.records : []), ...(Array.isArray(snapshot?.recovered) ? snapshot.recovered : [])];
      for (const r of entries) {
        if (!r || !r.operatorStatus || r.operatorStatus === 'not_performed' || !r.scope?.operator_action
          || typeof r.id !== 'string' || typeof r.instanceId !== 'string'
          || (r.instanceId === instanceId && records.has(r.id))) continue;
        const key = `${r.instanceId}:${r.id}`;
        if (!recovered.has(key)) { recovered.set(key, { ...copy(r), historical: true }); added++; }
      }
      return added;
    },
    operators: () => copy([...records.values(), ...recovered.values()].filter((r) => r.operatorStatus)),
    async ask(id, scope, ask, persist = () => {}) {
      if (!id || typeof id !== 'string' || id.length > 120) throw new Error('A request id must contain 1–120 characters.');
      const signature = createHash('sha256').update(canonical(scope)).digest('hex');
      const previous = records.get(id);
      if (previous && previous.signature !== signature) throw new Error('This request_id already identifies a different decision. Use a new id for a different scope.');
      if (previous?.status === 'answered') return { record: copy(previous), reused: true };
      if (inflight.has(id)) return { record: copy(await inflight.get(id)), reused: true };
      const record = previous ?? { id, instanceId, signature, scope: copy(scope), status: 'pending', answer: null,
        at: new Date().toISOString() };
      records.set(id, record);
      // Register the promise before invoking UI code, including synchronous callbacks.
      const work = Promise.resolve().then(ask).then((answer) => {
        if (answer != null && answer !== '') {
          record.answer = String(answer);
          record.status = 'answered';
          record.answeredAt = new Date().toISOString();
          const p = record.scope.operator_action;
          const i = p?.option_index;
          const selected = Number.isInteger(i) && answer === `${i + 1}. ${record.scope.options[i]?.label}${i === record.scope.recommended ? ' (recommended)' : ''}`;
          if (selected) record.operatorStatus = 'awaiting_execution';
        }
        persist(copy(record));
        return record;
      }).finally(() => inflight.delete(id));
      inflight.set(id, work);
      return { record: copy(await work), reused: false };
    },
    reportOperator(id, status, evidence) {
      const r = records.get(id);
      if (!r?.operatorStatus) throw new Error('No accepted operator action with this request id in this instance.');
      if (!['output_received', 'not_performed'].includes(status) || !String(evidence ?? '').trim()) throw new Error('Give output_received or not_performed and its supporting evidence.');
      r.operatorStatus = status;
      r.operatorReport = { by: 'agent', evidence: String(evidence), at: new Date().toISOString(), verified: false };
      return copy(r);
    },
  };
}

// A launcher-generated id survives SDK session replacement, unlike extension-local variables.
// Without the launcher, use local storage rather than sharing unrelated Pi/test instances.
export function instanceDecisions(id) {
  if (!id) return createDecisionStore();
  const stores = globalThis[STORES] ??= new Map();
  if (!stores.has(id)) stores.set(id, createDecisionStore(id));
  return stores.get(id);
}
