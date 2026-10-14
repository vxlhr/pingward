"use client";

import { useState, type FormEvent } from "react";
import { getToken, setToken } from "@/lib/api";
import { Button, Field, Input, Modal } from "./ui";

export function TokenDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [value, setValue] = useState(() => (typeof window === "undefined" ? "" : getToken()));

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setToken(value.trim());
    onSaved();
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="API token">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <p className="text-sm text-muted">
          Adding, pausing and deleting monitors is protected by the Worker&apos;s <code className="font-mono">API_TOKEN</code>
          (and viewing too, if the dashboard is private). The token is stored only in this browser. Leave it empty to sign out.
        </p>
        <Field label="Token">
          <Input type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit">Save</Button>
        </div>
      </form>
    </Modal>
  );
}
