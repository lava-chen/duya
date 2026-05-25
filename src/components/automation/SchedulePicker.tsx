import { useState, useRef, useEffect } from 'react';
import { Timer, CaretDown } from '@phosphor-icons/react';
import type { CronSchedule } from '@/types/automation';

interface ScheduleOption {
  label: string;
  value: CronSchedule;
}

const SCHEDULE_OPTIONS: ScheduleOption[] = [
  {
    label: 'Every hour',
    value: { kind: 'cron', cronExpr: '0 * * * *', cronTz: null },
  },
  {
    label: 'Every day at 9:00',
    value: { kind: 'cron', cronExpr: '0 9 * * *', cronTz: null },
  },
  {
    label: 'Every weekday at 9:00',
    value: { kind: 'cron', cronExpr: '0 9 * * 1-5', cronTz: null },
  },
  {
    label: 'Every week (Mon 9:00)',
    value: { kind: 'cron', cronExpr: '0 9 * * 1', cronTz: null },
  },
  {
    label: 'Every month (1st 9:00)',
    value: { kind: 'cron', cronExpr: '0 9 1 * *', cronTz: null },
  },
];

function scheduleToLabel(schedule: CronSchedule): string {
  const option = SCHEDULE_OPTIONS.find((o) => {
    if (schedule.kind !== o.value.kind) return false;
    if (schedule.kind === 'every') return schedule.everyMs === o.value.everyMs;
    if (schedule.kind === 'cron') return schedule.cronExpr === o.value.cronExpr;
    return false;
  });
  if (option) return option.label;
  if (schedule.kind === 'every') return `Every ${(schedule.everyMs || 0) / 60000} min`;
  if (schedule.kind === 'cron') return schedule.cronExpr || 'Custom';
  return 'One-time';
}

interface SchedulePickerProps {
  schedule: CronSchedule;
  onChange: (schedule: CronSchedule) => void;
}

export function SchedulePicker({ schedule, onChange }: SchedulePickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const displayLabel = scheduleToLabel(schedule);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className="flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs transition-all duration-150"
        style={{
          background: 'var(--surface)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
        }}
        onClick={() => setIsOpen(!isOpen)}
        onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; }}
      >
        <Timer size={12} style={{ color: 'var(--muted)' }} />
        <span className="max-w-[140px] truncate">{displayLabel}</span>
        <CaretDown size={10} style={{ color: 'var(--muted)' }} />
      </button>

      {isOpen && (
        <div
          className="absolute bottom-full left-0 mb-1 py-1 rounded-lg shadow-lg z-50 min-w-[200px]"
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
          }}
        >
          {SCHEDULE_OPTIONS.map((option, index) => (
            <button
              key={index}
              type="button"
              className="w-full text-left px-3 py-2 text-xs transition-colors hover:bg-[var(--surface-hover)]"
              style={{
                color: 'var(--text)',
                background: displayLabel === option.label ? 'var(--accent-soft)' : 'transparent',
              }}
              onClick={() => {
                onChange(option.value);
                setIsOpen(false);
              }}
            >
              {option.label}
            </button>
          ))}
          <div
            className="border-t mx-2 my-1"
            style={{ borderColor: 'var(--border)' }}
          />
          <button
            type="button"
            className="w-full text-left px-3 py-2 text-xs transition-colors hover:bg-[var(--surface-hover)]"
            style={{ color: 'var(--accent)' }}
            onClick={() => setIsOpen(false)}
          >
            Custom...
          </button>
        </div>
      )}
    </div>
  );
}