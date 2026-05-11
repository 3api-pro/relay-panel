'use client';
/**
 * Tiny zero-dep UI primitives for the storefront.
 * No anti-pattern AI gradient (no indigo→purple, no fuchsia→rose).
 */
import { forwardRef } from 'react';

type ButtonVariant = 'primary' | 'ghost' | 'danger' | 'subtle';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const sizeMap: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-4 py-2 text-sm',
  lg: 'px-6 py-3 text-base',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', className = '', disabled, ...rest }, ref,
) {
  const sz = sizeMap[size];
  let cls = `inline-flex items-center justify-center rounded-md font-medium transition disabled:opacity-50 disabled:cursor-not-allowed ${sz}`;
  if (variant === 'primary') {
    cls += ' text-white hover:opacity-90 shadow-sm';
  } else if (variant === 'ghost') {
    cls += ' border border-slate-300 bg-white text-slate-700 hover:bg-slate-50';
  } else if (variant === 'danger') {
    cls += ' bg-red-600 text-white hover:bg-red-700';
  } else if (variant === 'subtle') {
    cls += ' bg-slate-100 text-slate-700 hover:bg-slate-200';
  }
  const style = variant === 'primary'
    ? { background: 'var(--brand-primary, #0e9486)' }
    : undefined;
  return <button ref={ref} className={`${cls} ${className}`} disabled={disabled} style={style} {...rest} />;
});

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, className = '', ...rest }, ref,
) {
  return (
    <label className="block">
      {label && <div className="text-sm font-medium text-slate-700 mb-1">{label}</div>}
      <input ref={ref}
        className={`w-full px-3 py-2 rounded-md border border-slate-300 focus:border-slate-500 focus:ring-1 focus:ring-slate-400 focus:outline-none text-sm ${error ? 'border-red-400' : ''} ${className}`}
        {...rest} />
      {hint && !error && <div className="text-xs text-slate-500 mt-1">{hint}</div>}
      {error && <div className="text-xs text-red-600 mt-1">{error}</div>}
    </label>
  );
});

export function Card({ children, className = '', title, action }: {
  children: React.ReactNode; className?: string; title?: string; action?: React.ReactNode;
}) {
  return (
    <section className={`bg-white rounded-lg border border-slate-200 ${className}`}>
      {(title || action) && (
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          {title && <h2 className="font-semibold text-slate-900">{title}</h2>}
          {action && <div>{action}</div>}
        </div>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white rounded-lg border border-slate-200 p-4">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-2xl font-semibold mt-1 text-slate-900">{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-1">{sub}</div>}
    </div>
  );
}

export function Alert({ kind = 'info', children }: {
  kind?: 'info' | 'success' | 'warn' | 'error';
  children: React.ReactNode;
}) {
  const m: Record<string, string> = {
    info: 'bg-slate-50 border-slate-200 text-slate-700',
    success: 'bg-emerald-50 border-emerald-200 text-emerald-800',
    warn: 'bg-amber-50 border-amber-200 text-amber-800',
    error: 'bg-red-50 border-red-200 text-red-800',
  };
  return (
    <div className={`px-4 py-3 rounded-md border text-sm ${m[kind]}`}>{children}</div>
  );
}

export function Badge({ children, tone = 'neutral' }: {
  children: React.ReactNode;
  tone?: 'neutral' | 'success' | 'warn' | 'danger' | 'brand';
}) {
  const m: Record<string, string> = {
    neutral: 'bg-slate-100 text-slate-700',
    success: 'bg-emerald-100 text-emerald-700',
    warn:    'bg-amber-100 text-amber-700',
    danger:  'bg-red-100 text-red-700',
    brand:   'text-white',
  };
  const style = tone === 'brand' ? { background: 'var(--brand-primary, #0e9486)' } : undefined;
  return (
    <span className={`inline-block text-xs px-2 py-0.5 rounded ${m[tone]}`} style={style}>
      {children}
    </span>
  );
}

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <div className={`inline-block animate-spin rounded-full border-2 border-slate-300 border-t-slate-700 h-4 w-4 ${className}`} />
  );
}

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

export function Modal({ open, onClose, title, children, footer }: ModalProps) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
         onClick={onClose}>
      <div className="bg-white rounded-lg shadow-lg w-full max-w-md"
           onClick={(e) => e.stopPropagation()}>
        {title && (
          <div className="px-5 py-4 border-b border-slate-100">
            <h3 className="font-semibold text-slate-900">{title}</h3>
          </div>
        )}
        <div className="p-5">{children}</div>
        {footer && (
          <div className="px-5 py-3 border-t border-slate-100 bg-slate-50 rounded-b-lg flex justify-end gap-2">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
