'use client';

import { useState, type FormEvent } from 'react';
import { Button, Field, Textarea } from '@stellar-health/ui';

export type AlertAction = 'acknowledge' | 'resolve';

const LABELS: Record<AlertAction, string> = {
  acknowledge: 'Acknowledge alert',
  resolve: 'Resolve alert',
};

/** Inline confirmation for acknowledge/resolve with an optional note for other responders. */
export function AlertActionForm({
  alertId,
  action,
  onSubmit,
  onCancel,
}: {
  alertId: string;
  action: AlertAction;
  onSubmit: (note: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const id = `note-${action}-${alertId}`;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await onSubmit(note.trim());
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-2 border-t border-slate-100 px-4 py-3 dark:border-slate-800"
      aria-label={LABELS[action]}
    >
      <Field label="Note (optional)" htmlFor={id} hint="Visible to everyone in Alert history.">
        <Textarea
          id={id}
          rows={2}
          maxLength={1000}
          value={note}
          autoFocus
          onChange={(e) => setNote(e.target.value)}
          placeholder={
            action === 'acknowledge' ? 'Known issue, extending TTL tomorrow' : 'TTL extended'
          }
        />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={saving}>
          {LABELS[action]}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
