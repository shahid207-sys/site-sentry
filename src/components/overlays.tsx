"use client";
import { CircleCheck, CircleX, Info, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Button, cx } from "./ui";

// ---------- toasts ----------

type Tone = "ok" | "error" | "info";
interface ToastItem {
  id: number;
  tone: Tone;
  title: string;
  detail?: string;
}
const ToastCtx = createContext<(t: Omit<ToastItem, "id">) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const push = useCallback((t: Omit<ToastItem, "id">) => {
    const id = ++seq.current;
    setItems((xs) => [...xs.slice(-3), { ...t, id }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), t.tone === "error" ? 9000 : 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="no-print pointer-events-none fixed inset-x-4 bottom-4 z-[60] flex flex-col items-end gap-2 sm:inset-x-auto sm:right-5 sm:w-96">
        {items.map((t) => {
          const Icon = t.tone === "ok" ? CircleCheck : t.tone === "error" ? CircleX : Info;
          return (
            <div key={t.id} role={t.tone === "error" ? "alert" : "status"} className="toast-in pointer-events-auto flex w-full items-start gap-3 rounded-lg bg-elevated px-4 py-3 shadow-pop">
              <Icon className={cx("mt-0.5 size-4 shrink-0", t.tone === "ok" ? "text-ok" : t.tone === "error" ? "text-sev-high" : "text-info")} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-fg">{t.title}</p>
                {t.detail ? <p className="mt-0.5 text-[13px] text-fg-2">{t.detail}</p> : null}
              </div>
              <button type="button" className="text-fg-3 hover:text-fg" aria-label="Dismiss" onClick={() => setItems((xs) => xs.filter((x) => x.id !== t.id))}>
                <X className="size-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------- modal & drawer (native <dialog>: focus trap, Esc, inert background) ----------

function useDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const onCancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    d.addEventListener("cancel", onCancel);
    return () => d.removeEventListener("cancel", onCancel);
  }, [onClose]);
  return ref;
}

export function Modal({ open, onClose, title, description, children, footer, wide }: { open: boolean; onClose: () => void; title: string; description?: ReactNode; children?: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useDialog(open, onClose);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onClick={(e) => e.target === ref.current && onClose()}
      className={cx("m-auto max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] rounded-xl border-0 bg-elevated p-0 text-fg shadow-pop backdrop:bg-scrim backdrop:backdrop-blur-[2px]", wide ? "max-w-2xl" : "max-w-md")}
    >
      {open ? (
        <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
          <div className="flex items-start justify-between gap-4 px-5 pb-2 pt-5">
            <div>
              <h2 className="text-base font-semibold">{title}</h2>
              {description ? <div className="mt-1 text-sm text-fg-2">{description}</div> : null}
            </div>
            <button type="button" onClick={onClose} className="-mr-1 rounded p-1 text-fg-3 hover:bg-hover hover:text-fg" aria-label="Close">
              <X className="size-4" />
            </button>
          </div>
          {children ? <div className="overflow-y-auto px-5 py-3">{children}</div> : null}
          {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3.5">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  danger,
  busy,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  children?: ReactNode;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  );
}

/** Right-hand panel on wide screens, full-screen sheet on phones. */
export function Drawer({ open, onClose, title, children, actions }: { open: boolean; onClose: () => void; title: string; children: ReactNode; actions?: ReactNode }) {
  const ref = useDialog(open, onClose);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onClick={(e) => e.target === ref.current && onClose()}
      className="m-0 ml-auto h-dvh max-h-dvh w-full max-w-full border-0 border-l border-line bg-surface p-0 text-fg shadow-pop backdrop:bg-scrim sm:max-w-[min(720px,92vw)]"
    >
      {open ? (
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
            <p className="truncate text-sm font-semibold">{title}</p>
            <div className="flex items-center gap-2">
              {actions}
              <button type="button" onClick={onClose} className="rounded p-1.5 text-fg-3 hover:bg-hover hover:text-fg" aria-label="Close panel">
                <X className="size-4" />
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-5 sm:px-5">{children}</div>
        </div>
      ) : null}
    </dialog>
  );
}

/** Copy text with feedback. Falls back to a hidden textarea where the async clipboard is unavailable. */
export function useCopy() {
  const toast = useToast();
  return useCallback(
    async (text: string, what = "Copied to clipboard") => {
      try {
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
        else {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand("copy");
          ta.remove();
          if (!ok) throw new Error("copy failed");
        }
        toast({ tone: "ok", title: what });
      } catch {
        toast({ tone: "error", title: "Could not copy", detail: "Your browser blocked clipboard access. Select the text and copy it manually." });
      }
    },
    [toast],
  );
}
