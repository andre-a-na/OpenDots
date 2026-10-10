import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { api } from './api';

export interface UsageSummary {
  estimated: boolean;
  budgetUsd: number;
  label: string | null;
  periodStart: string;
  periodEnd: string;
  daysLeft: number;
  spentUsd: number;
  remainingUsd: number;
  todayUsd: number;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  byModel: {
    model: string;
    costUsd: number;
    requests: number;
    promptTokens: number;
    completionTokens: number;
  }[];
  byDay: { day: string; costUsd: number }[];
}

const usd = (v: number) =>
  v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`;
const tokens = (v: number) =>
  v >= 1_000_000
    ? `${(v / 1_000_000).toFixed(2)}M`
    : v >= 1000
      ? `${(v / 1000).toFixed(1)}k`
      : String(v);
const md = (iso: string) => {
  const [, m, d] = iso.split('-');
  return `${Number(m)}/${Number(d)}`;
};

/** Credit meter shown at the bottom of the sidebar. Polls /api/usage. */
export function UsageMeter({ refreshKey }: { refreshKey?: unknown }) {
  const [usage, setUsage] = useState<UsageSummary>();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let active = true;
    const load = () =>
      api<UsageSummary>('/usage')
        .then((u) => active && setUsage(u))
        .catch(() => undefined);
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [refreshKey]);
  if (!usage) return null;
  const hasBudget = usage.budgetUsd > 0;
  const ratio = hasBudget ? Math.min(1, usage.spentUsd / usage.budgetUsd) : 0;
  const tone = ratio > 0.9 ? 'danger' : ratio > 0.7 ? 'warn' : 'ok';
  return (
    <section className={`usage-meter ${tone}`} aria-label="API クレジット">
      <button
        type="button"
        className="usage-meter-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="usage-meter-label">クレジット</span>
        <span className="usage-meter-figures">
          <strong>{usd(usage.spentUsd)}</strong>
          {hasBudget && <em> / ${usage.budgetUsd}</em>}
        </span>
        {open ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
      </button>
      {hasBudget && (
        <div
          className="usage-meter-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={usage.budgetUsd}
          aria-valuenow={Math.round(usage.spentUsd * 100) / 100}
        >
          <i style={{ width: `${ratio * 100}%` }} />
        </div>
      )}
      <div className="usage-meter-sub">
        {hasBudget ? (
          <span>
            残り <strong>{usd(usage.remainingUsd)}</strong>
          </span>
        ) : (
          <span>予算未設定</span>
        )}
        <span>
          期限 {md(usage.periodEnd)}
          {usage.daysLeft > 0 ? `（あと${usage.daysLeft}日）` : ''}
        </span>
      </div>
      {open && (
        <div className="usage-meter-detail">
          <dl>
            <dt>今日</dt>
            <dd>{usd(usage.todayUsd)}</dd>
            <dt>期間</dt>
            <dd>
              {md(usage.periodStart)}〜{md(usage.periodEnd)}
            </dd>
            <dt>呼び出し</dt>
            <dd>{usage.requests} 回</dd>
            <dt>トークン</dt>
            <dd>
              入 {tokens(usage.promptTokens)} ／ 出{' '}
              {tokens(usage.completionTokens)}
            </dd>
          </dl>
          {usage.byModel.length > 0 && (
            <ul className="usage-meter-models">
              {usage.byModel.map((m) => (
                <li key={m.model}>
                  <span>{m.model}</span>
                  <span>{usd(m.costUsd)}</span>
                </li>
              ))}
            </ul>
          )}
          {usage.byDay.length > 0 && (
            <div className="usage-meter-days" aria-label="日別">
              {usage.byDay.map((d) => {
                const max = Math.max(...usage.byDay.map((x) => x.costUsd), 0.0001);
                return (
                  <span
                    key={d.day}
                    title={`${md(d.day)} ${usd(d.costUsd)}`}
                    style={{ height: `${Math.max(8, (d.costUsd / max) * 100)}%` }}
                  />
                );
              })}
            </div>
          )}
          <p className="usage-meter-note">
            {usage.label ?? 'クレジット'}。応答の usage から単価で推定。正確な値は
            Claude Console の請求ページで確認。
          </p>
        </div>
      )}
    </section>
  );
}
