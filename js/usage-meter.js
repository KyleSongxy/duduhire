const STORAGE_KEY = 'duduhire-usage-ledger-v1';
const MAX_EVENTS = 80;

function readLedger() {
  try {
    return JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

function writeLedger(events) {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(events.slice(-MAX_EVENTS)));
  } catch {
    // Usage visibility should never block the core experience.
  }
}

export function createContentKey(flow, content = '') {
  let hash = 2166136261;
  const source = `${flow}:${String(content).trim().toLowerCase()}`;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${flow}-${(hash >>> 0).toString(16)}`;
}

export function recordUsage({
  flow,
  stage,
  contentKey,
  inputCharacters = 0,
  mode = 'local-demo',
  tokens = 0,
  costCny = 0,
}) {
  const events = readLedger();
  const cached = events.some((event) => (
    event.flow === flow
    && event.stage === stage
    && event.contentKey === contentKey
  ));
  const event = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    flow,
    stage,
    contentKey,
    inputCharacters,
    mode,
    cached,
    modelCalls: mode === 'model' && !cached ? 1 : 0,
    tokens: mode === 'model' && !cached ? Number(tokens) || 0 : 0,
    costCny: mode === 'model' && !cached ? Number(costCny) || 0 : 0,
  };
  events.push(event);
  writeLedger(events);
  return event;
}

export function getUsageReceipt(flow, contentKey) {
  const events = readLedger().filter((event) => event.flow === flow && event.contentKey === contentKey);
  return {
    typingCalls: 0,
    localOperations: new Set(events.filter((event) => event.mode === 'local-demo').map((event) => event.stage)).size,
    modelCalls: events.reduce((total, event) => total + event.modelCalls, 0),
    tokens: events.reduce((total, event) => total + event.tokens, 0),
    costCny: events.reduce((total, event) => total + (event.costCny || 0), 0),
    reused: events.some((event) => event.cached),
  };
}
