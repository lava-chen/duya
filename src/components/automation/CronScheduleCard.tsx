import { useEffect, useRef, useState } from 'react';
import { CaretDown, Check } from '@phosphor-icons/react';
import {
  CUSTOM_FREQUENCY_LABELS,
  PRESET_LABELS,
  WEEKDAYS,
  previewNextRun,
  type CustomFrequency,
  type ScheduleDraft,
  type SchedulePreset,
} from './cron-schedule';

interface MenuOption<T extends string | number> {
  value: T;
  label: string;
}

function ValueMenu<T extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: MenuOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex min-h-9 items-center gap-2 rounded-lg px-3 py-1.5 text-sm outline-none transition-colors"
        style={{
          color: 'var(--command-menu-muted)',
          background: open ? 'var(--command-menu-selected)' : 'transparent',
          border: open ? '1px solid var(--text)' : '1px solid transparent',
        }}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{selected?.label}</span>
        <CaretDown size={14} />
      </button>
      {open && (
        <div
          role="listbox"
          className="command-menu-popover absolute right-0 top-full z-40 mt-2 min-w-44 overflow-hidden p-1"
          style={{
            background: 'var(--command-menu-bg)',
            border: '1px solid var(--command-menu-border)',
            borderRadius: 12,
            boxShadow: 'var(--command-menu-shadow)',
          }}
        >
          {options.map((option) => {
            const active = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={active}
                className="command-menu-row flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm"
                style={{ color: 'var(--text)', background: active ? 'var(--command-menu-selected)' : 'transparent' }}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <span>{option.label}</span>
                {active && <Check size={14} weight="bold" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ScheduleRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-16 items-center justify-between gap-5 px-5 py-3.5" style={{ borderTop: '1px solid var(--command-menu-border)' }}>
      <span className="text-sm font-medium" style={{ color: 'var(--text)' }}>{label}</span>
      <div className="min-w-0 text-right">{children}</div>
    </div>
  );
}

function TimeControl({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const hour = Number(value.slice(0, 2));
  const period = hour < 12 ? 'am' : 'pm';
  const changePeriod = (next: 'am' | 'pm') => {
    const [rawHour, minute] = value.split(':').map(Number);
    let nextHour = rawHour;
    if (next === 'am' && rawHour >= 12) nextHour -= 12;
    if (next === 'pm' && rawHour < 12) nextHour += 12;
    onChange(`${String(nextHour).padStart(2, '0')}:${String(minute || 0).padStart(2, '0')}`);
  };
  return (
    <div className="flex items-center justify-end gap-2">
      <ValueMenu
        ariaLabel="选择上午或下午"
        value={period}
        options={[{ value: 'am', label: '上午' }, { value: 'pm', label: '下午' }]}
        onChange={changePeriod}
      />
      <input
        type="time"
        aria-label="运行时间"
        value={value}
        className="rounded-lg border-0 bg-transparent px-2 py-1.5 text-sm outline-none"
        style={{ color: 'var(--command-menu-muted)' }}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

const presetOptions = (Object.keys(PRESET_LABELS) as SchedulePreset[]).map((value) => ({ value, label: PRESET_LABELS[value] }));
const customFrequencyOptions = (Object.keys(CUSTOM_FREQUENCY_LABELS) as CustomFrequency[]).map((value) => ({ value, label: CUSTOM_FREQUENCY_LABELS[value] }));

export function CronScheduleCard({
  value,
  onChange,
  nextRunAt,
}: {
  value: ScheduleDraft;
  onChange: (value: ScheduleDraft) => void;
  nextRunAt?: number | null;
}) {
  const patch = (next: Partial<ScheduleDraft>) => onChange({ ...value, ...next });
  const effectiveFrequency = value.preset === 'custom' ? value.customFrequency : value.preset;
  const showsTime = ['daily', 'weekdays', 'weekly', 'monthly'].includes(effectiveFrequency);
  const showsWeekday = effectiveFrequency === 'weekly';
  const showsMonthDay = effectiveFrequency === 'monthly';
  const showsMinute = effectiveFrequency === 'hourly';
  const isDirectCron = value.preset === 'custom' && value.customFrequency === 'cron';
  const preview = previewNextRun(value);
  const nextRun = preview ?? (nextRunAt ? new Date(nextRunAt) : null);

  return (
    <div className="space-y-4">
      <div
        className="overflow-visible rounded-2xl"
        style={{ background: 'var(--command-menu-bg)', border: '1px solid var(--command-menu-border)', boxShadow: 'var(--shadow-resting)' }}
      >
        <div className="flex min-h-16 items-center justify-between gap-5 px-5 py-3.5">
          <span className="text-sm font-medium" style={{ color: 'var(--text)' }}>重复</span>
          <ValueMenu ariaLabel="选择重复频率" value={value.preset} options={presetOptions} onChange={(preset) => patch({ preset })} />
        </div>

        {value.preset === 'custom' && (
          <ScheduleRow label="频率">
            <ValueMenu
              ariaLabel="选择自定义频率"
              value={value.customFrequency}
              options={customFrequencyOptions}
              onChange={(customFrequency) => patch({ customFrequency })}
            />
          </ScheduleRow>
        )}

        {showsMinute && (
          <ScheduleRow label="分钟">
            <div className="flex items-center justify-end gap-2" style={{ color: 'var(--command-menu-muted)' }}>
              <span>每小时第</span>
              <input
                type="number"
                min={0}
                max={59}
                aria-label="每小时运行分钟"
                value={value.minute}
                className="w-16 rounded-lg bg-transparent px-2 py-1.5 text-right text-sm outline-none"
                style={{ border: '1px solid var(--command-menu-border)', color: 'var(--text)' }}
                onChange={(event) => patch({ minute: Number(event.target.value) })}
              />
              <span>分钟</span>
            </div>
          </ScheduleRow>
        )}

        {showsWeekday && (
          <ScheduleRow label="星期">
            <ValueMenu ariaLabel="选择星期" value={value.weekday} options={[...WEEKDAYS]} onChange={(weekday) => patch({ weekday })} />
          </ScheduleRow>
        )}

        {showsMonthDay && (
          <ScheduleRow label="日期">
            <div className="flex items-center justify-end gap-2" style={{ color: 'var(--command-menu-muted)' }}>
              <span>每月</span>
              <input
                type="number"
                min={1}
                max={31}
                aria-label="每月运行日期"
                value={value.monthDay}
                className="w-16 rounded-lg bg-transparent px-2 py-1.5 text-right text-sm outline-none"
                style={{ border: '1px solid var(--command-menu-border)', color: 'var(--text)' }}
                onChange={(event) => patch({ monthDay: Number(event.target.value) })}
              />
              <span>日</span>
            </div>
          </ScheduleRow>
        )}

        {showsTime && (
          <ScheduleRow label="时间">
            <TimeControl value={value.time} onChange={(time) => patch({ time })} />
          </ScheduleRow>
        )}

        {value.preset === 'once' && (
          <ScheduleRow label="日期与时间">
            <input
              type="datetime-local"
              aria-label="单次运行时间"
              value={value.at}
              className="rounded-lg border-0 bg-transparent px-2 py-1.5 text-sm outline-none"
              style={{ color: 'var(--command-menu-muted)' }}
              onChange={(event) => patch({ at: event.target.value })}
            />
          </ScheduleRow>
        )}

        {isDirectCron && (
          <>
            <ScheduleRow label="表达式">
              <input
                value={value.cronExpr}
                aria-label="Cron 表达式"
                placeholder="0 9 * * *"
                className="w-44 rounded-lg bg-transparent px-3 py-1.5 text-right font-mono text-sm outline-none"
                style={{ border: '1px solid var(--command-menu-border)', color: 'var(--text)' }}
                onChange={(event) => patch({ cronExpr: event.target.value })}
              />
            </ScheduleRow>
            <ScheduleRow label="时区">
              <input
                value={value.timezone}
                aria-label="Cron 时区"
                placeholder="Asia/Shanghai"
                className="w-44 rounded-lg bg-transparent px-3 py-1.5 text-right text-sm outline-none"
                style={{ border: '1px solid var(--command-menu-border)', color: 'var(--text)' }}
                onChange={(event) => patch({ timezone: event.target.value })}
              />
            </ScheduleRow>
          </>
        )}
      </div>

      {value.preset !== 'once' && (
        <div
          className="overflow-visible rounded-2xl"
          style={{ background: 'var(--command-menu-bg)', border: '1px solid var(--command-menu-border)', boxShadow: 'var(--shadow-resting)' }}
        >
          <div className="flex min-h-16 items-center justify-between gap-5 px-5 py-3.5">
            <span className="text-sm font-medium" style={{ color: 'var(--text)' }}>结束重复</span>
            <ValueMenu
              ariaLabel="选择结束重复时间"
              value={value.endRepeat}
              options={[{ value: 'never', label: '永不' }, { value: 'on', label: '指定日期' }]}
              onChange={(endRepeat) => patch({ endRepeat })}
            />
          </div>
          {value.endRepeat === 'on' && (
            <ScheduleRow label="结束时间">
              <input
                type="datetime-local"
                aria-label="结束重复时间"
                value={value.endAt}
                className="rounded-lg border-0 bg-transparent px-2 py-1.5 text-sm outline-none"
                style={{ color: 'var(--command-menu-muted)' }}
                onChange={(event) => patch({ endAt: event.target.value })}
              />
            </ScheduleRow>
          )}
        </div>
      )}

      <div
        className="flex min-h-16 items-center justify-between gap-5 rounded-2xl px-5 py-3.5"
        style={{ background: 'var(--command-menu-bg)', border: '1px solid var(--command-menu-border)', boxShadow: 'var(--shadow-resting)' }}
      >
        <span className="text-sm font-medium" style={{ color: 'var(--text)' }}>下次运行</span>
        <span className="text-sm" style={{ color: 'var(--command-menu-muted)' }}>
          {nextRun ? nextRun.toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '保存后计算'}
        </span>
      </div>
    </div>
  );
}
