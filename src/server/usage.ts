// Model usage metering: wraps fetch to read `usage` from every model
// response (streamed or not), estimates cost from a per-model price table,
// and summarises spend against a credit budget for the UI.
import type { Store } from './store.js';

/** USD per 1M tokens: [input, output]. Unknown models fall back to `default`. */
const PRICES: Record<string, [number, number]> = {
  'claude-fable-5-1': [10, 50],
  'claude-opus-5-5': [4, 20],
  'claude-opus-5': [5, 25],
  'claude-sonnet-5-5': [2, 10],
  'claude-sonnet-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
  'gpt-5': [1.25, 10],
  default: [2, 10],
};

export function estimateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const key = Object.keys(PRICES).find((k) => model.startsWith(k));
  const [input, output] = PRICES[key ?? 'default'];
  return (promptTokens * input + completionTokens * output) / 1_000_000;
}

export interface UsageBudget {
  budgetUsd: number;
  periodStart: string; // ISO date (local)
  periodEnd: string; // ISO date (local), exclusive
  label?: string;
}

export function usageBudgetFromEnv(env: NodeJS.ProcessEnv): UsageBudget {
  const today = new Date();
  const first = new Date(today.getFullYear(), today.getMonth(), 1);
  const next = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return {
    budgetUsd: Number(env.USAGE_BUDGET_USD ?? 0) || 0,
    periodStart: env.USAGE_PERIOD_START || iso(first),
    periodEnd: env.USAGE_PERIOD_END || iso(next),
    label: env.USAGE_BUDGET_LABEL || undefined,
  };
}

type Usage = { prompt_tokens?: number; completion_tokens?: number };

function pickUsage(obj: unknown): Usage | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const usage = (obj as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Usage;
  if (typeof u.prompt_tokens !== 'number' && typeof u.completion_tokens !== 'number')
    return undefined;
  return u;
}

/**
 * Returns a fetch that records token usage for OpenAI-compatible
 * chat-completions responses. Streams are tee'd; the caller's stream is
 * untouched. Recording failures never affect the request.
 */
export function meteredFetch(store: Store, source: string): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    try {
      let model = 'unknown';
      if (init?.body && typeof init.body === 'string') {
        const body = JSON.parse(init.body) as { model?: string };
        if (body.model) model = body.model;
      }
      const type = response.headers.get('content-type') ?? '';
      const record = (u: Usage | undefined, m: string) => {
        if (!u) return;
        const p = u.prompt_tokens ?? 0;
        const c = u.completion_tokens ?? 0;
        store.recordUsage({
          model: m,
          source,
          promptTokens: p,
          completionTokens: c,
          costUsd: estimateCost(m, p, c),
        });
      };
      if (type.includes('text/event-stream') && response.body) {
        const [forCaller, forMeter] = response.body.tee();
        void (async () => {
          const reader = forMeter.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let last: Usage | undefined;
          let seenModel = model;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() ?? '';
              for (const line of lines) {
                if (!line.startsWith('data:')) continue;
                const data = line.slice(5).trim();
                if (!data || data === '[DONE]') continue;
                try {
                  const chunk = JSON.parse(data) as { model?: string };
                  if (chunk.model) seenModel = chunk.model;
                  const u = pickUsage(chunk);
                  if (u) last = u;
                } catch {
                  // partial or non-JSON line
                }
              }
            }
          } catch {
            // stream aborted; record what we saw
          }
          record(last, seenModel);
        })();
        return new Response(forCaller, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
      if (type.includes('application/json')) {
        const clone = response.clone();
        void clone
          .json()
          .then((json: { model?: string }) =>
            record(pickUsage(json), json.model ?? model),
          )
          .catch(() => undefined);
      }
    } catch {
      // metering must never break the model call
    }
    return response;
  };
}

export function usageSummary(store: Store, budget: UsageBudget) {
  const start = new Date(`${budget.periodStart}T00:00:00`).getTime();
  const end = new Date(`${budget.periodEnd}T00:00:00`).getTime();
  const rows = store.usageRows(start, end);
  const dayKey = (t: number) => {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const todayKey = dayKey(Date.now());
  const byModel = new Map<string, { costUsd: number; requests: number; promptTokens: number; completionTokens: number }>();
  const byDay = new Map<string, number>();
  let spent = 0;
  let prompt = 0;
  let completion = 0;
  let today = 0;
  for (const r of rows) {
    spent += r.costUsd;
    prompt += r.promptTokens;
    completion += r.completionTokens;
    const k = dayKey(r.createdAt);
    byDay.set(k, (byDay.get(k) ?? 0) + r.costUsd);
    if (k === todayKey) today += r.costUsd;
    const m = byModel.get(r.model) ?? { costUsd: 0, requests: 0, promptTokens: 0, completionTokens: 0 };
    m.costUsd += r.costUsd;
    m.requests += 1;
    m.promptTokens += r.promptTokens;
    m.completionTokens += r.completionTokens;
    byModel.set(r.model, m);
  }
  const daysLeft = Math.max(0, Math.ceil((end - Date.now()) / 86_400_000));
  return {
    estimated: true,
    budgetUsd: budget.budgetUsd,
    label: budget.label ?? null,
    periodStart: budget.periodStart,
    periodEnd: budget.periodEnd,
    daysLeft,
    spentUsd: spent,
    remainingUsd: Math.max(0, budget.budgetUsd - spent),
    todayUsd: today,
    requests: rows.length,
    promptTokens: prompt,
    completionTokens: completion,
    byModel: [...byModel.entries()]
      .map(([model, v]) => ({ model, ...v }))
      .sort((a, b) => b.costUsd - a.costUsd),
    byDay: [...byDay.entries()]
      .map(([day, costUsd]) => ({ day, costUsd }))
      .sort((a, b) => a.day.localeCompare(b.day))
      .slice(-14),
  };
}
