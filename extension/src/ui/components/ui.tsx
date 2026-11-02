/** Small design-system primitives used by the popup and the options page. */
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { forwardRef } from 'react';

export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'icon';

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'gradient-accent text-white shadow-[0_1px_0_rgba(255,255,255,0.25)_inset,0_6px_16px_-6px_rgba(109,94,246,0.7)] hover:brightness-110 active:brightness-95',
  secondary: 'bg-panel-2 text-ink border border-line hover:bg-panel-hover hover:border-line-strong',
  ghost: 'text-ink-muted hover:text-ink hover:bg-panel-2',
  danger: 'text-danger bg-danger-soft hover:brightness-110',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-[12px] gap-1.5 rounded-lg',
  md: 'h-8 px-3 text-[12.5px] gap-1.5 rounded-[9px]',
  icon: 'h-7 w-7 rounded-lg justify-center',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        'inline-flex shrink-0 items-center font-medium whitespace-nowrap transition-[background,filter,border-color,color] duration-150 select-none',
        'disabled:pointer-events-none disabled:opacity-45',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
});

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

const TONES: Record<Tone, string> = {
  neutral: 'bg-panel-2 text-ink-muted',
  accent: 'bg-accent-soft text-accent-ink',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
};

export function Badge({ tone = 'neutral', children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={cx('inline-flex h-[18px] items-center gap-1 rounded-md px-1.5 text-[10.5px] font-semibold tracking-wide whitespace-nowrap', TONES[tone], className)}
    >
      {children}
    </span>
  );
}

export function ProgressBar({ value, tone = 'accent', className }: { value?: number; tone?: 'accent' | 'success' | 'danger' | 'muted'; className?: string }) {
  const indeterminate = value === undefined;
  const fill = {
    accent: 'gradient-accent',
    success: 'bg-success',
    danger: 'bg-danger',
    muted: 'bg-ink-faint',
  }[tone];
  return (
    <div
      className={cx('relative h-1.5 w-full overflow-hidden rounded-full bg-panel-2', className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(value * 100)}
    >
      <div
        className={cx('relative h-full overflow-hidden rounded-full transition-[width] duration-500 ease-out', fill, indeterminate && 'progress-indeterminate w-full opacity-60')}
        style={indeterminate ? undefined : { width: `${Math.max(2, Math.min(100, value * 100))}%` }}
      />
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return (
    <input
      ref={ref}
      className={cx(
        'h-8 w-full rounded-[9px] border border-line bg-panel px-2.5 text-[12.5px] text-ink placeholder:text-ink-faint',
        'transition-colors outline-none focus:border-accent focus:ring-3 focus:ring-accent-soft',
        className,
      )}
      {...rest}
    />
  );
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cx(
        'h-7 min-w-0 rounded-lg border border-line bg-panel-2 pr-7 pl-2.5 text-[12px] font-medium text-ink',
        'cursor-pointer transition-colors outline-none hover:border-line-strong focus:border-accent',
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full transition-colors duration-200 disabled:opacity-50',
        checked ? 'gradient-accent' : 'bg-line-strong',
      )}
    >
      <span
        className={cx(
          'absolute top-[3px] left-[3px] h-4 w-4 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.3)] transition-transform duration-200',
          checked && 'translate-x-4',
        )}
      />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode }>;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={cx('flex rounded-[10px] border border-line bg-panel-2 p-[3px]', className)} role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            'flex h-[26px] flex-1 items-center justify-center gap-1.5 rounded-[7px] px-2 text-[12px] font-medium transition-all duration-150',
            value === o.value ? 'bg-panel text-ink shadow-[0_1px_2px_rgba(0,0,0,0.12)] dark:bg-white/10' : 'text-ink-muted hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('rounded-[14px] border border-line bg-panel shadow-card', className)}>{children}</div>;
}

export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="animate-in flex flex-col items-center px-8 pt-14 pb-8 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-panel text-ink-faint shadow-card">{icon}</div>
      <div className="text-[13.5px] font-semibold text-ink">{title}</div>
      {children && <div className="mt-1.5 max-w-[280px] text-[12px] leading-relaxed text-ink-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Notice({ tone = 'info', icon, children, action }: { tone?: Tone; icon?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={cx('flex items-start gap-2 rounded-[10px] px-2.5 py-2 text-[11.5px] leading-snug', TONES[tone])}>
      {icon && <span className="mt-px shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  );
}
