"use client";

import { clsx } from "clsx";
import { X } from "lucide-react";
import { useEffect, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import type { MonitorStatus } from "@/lib/api";

export function Button({
  variant = "primary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" | "outline" }) {
  return (
    <button
      className={clsx(
        "inline-flex items-center justify-center gap-2 rounded-lg px-3.5 h-9 text-sm font-medium transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50 disabled:pointer-events-none",
        variant === "primary" && "bg-accent text-on-accent hover:brightness-110",
        variant === "outline" && "border border-border bg-surface hover:bg-surface-2",
        variant === "ghost" && "hover:bg-surface-2 text-muted hover:text-foreground",
        variant === "danger" && "text-down hover:bg-down-soft",
        className,
      )}
      {...props}
    />
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={clsx(
        "h-10 w-full rounded-lg border border-border bg-surface-2 px-3 text-sm placeholder:text-muted/70",
        "focus:outline-none focus:ring-2 focus:ring-accent/60",
        className,
      )}
      {...props}
    />
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  );
}

const STATUS_STYLES: Record<MonitorStatus, { label: string; cls: string }> = {
  UP: { label: "UP", cls: "bg-up-soft text-up" },
  DOWN: { label: "DOWN", cls: "bg-down-soft text-down" },
  PAUSED: { label: "PAUSED", cls: "bg-paused-soft text-paused" },
  PENDING: { label: "PENDING", cls: "bg-pending-soft text-pending" },
};

/** A monitor in a maintenance window shows that instead of its (frozen) status. */
export function StatusBadge({ status, maintenance }: { status: MonitorStatus; maintenance?: boolean }) {
  if (maintenance) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-maintenance-soft px-2.5 py-1 text-xs font-semibold tracking-wide text-maintenance">
        <span className="size-2 rounded-full bg-current" />
        MAINTENANCE
      </span>
    );
  }
  const s = STATUS_STYLES[status];
  return (
    <span className={clsx("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold tracking-wide", s.cls)}>
      <span className={clsx("relative size-2 rounded-full bg-current", (status === "UP" || status === "DOWN") && "pulse-dot")} />
      {s.label}
    </span>
  );
}

/** Native <dialog> modal: Esc, focus trapping and the backdrop come from the browser. */
export function Modal({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className={clsx(
        "m-auto w-[calc(100%-2rem)] rounded-2xl border border-border bg-surface p-0 text-foreground shadow-2xl",
        wide ? "max-w-3xl" : "max-w-md",
      )}
    >
      {open && (
        <div className="p-5 sm:p-6">
          <div className="mb-5 flex items-start justify-between gap-4">
            <h2 className="text-lg font-semibold leading-tight min-w-0">{title}</h2>
            <Button variant="ghost" className="size-8 px-0 shrink-0" onClick={onClose} aria-label="Close">
              <X className="size-4" />
            </Button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}
