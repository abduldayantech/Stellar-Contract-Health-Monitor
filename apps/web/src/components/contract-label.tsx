'use client';

import { useState } from 'react';
import { Button, Input } from '@stellar-health/ui';
import { api, errorMessage, useMe } from '@/lib/api';

export function ContractLabel({
  id,
  label,
  onSaved,
}: {
  id: string;
  label: string | null;
  onSaved?: () => void | Promise<unknown>;
}) {
  const role = useMe().data?.principal.role;
  const canEdit = role === 'EDITOR' || role === 'ADMIN';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function start() {
    setDraft(label ?? '');
    setError(null);
    setEditing(true);
  }

  function cancel() {
    setError(null);
    setEditing(false);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api(`/contracts/${id}`, { method: 'PATCH', body: { label: draft.trim() } });
      setEditing(false);
      await onSaved?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <span className="inline-flex items-center gap-1.5">
        {label ?? 'Unnamed contract'}
        {canEdit && (
          <button
            type="button"
            aria-label="Rename contract"
            onClick={start}
            className="rounded p-1 text-slate-500 dark:text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-3.5 w-3.5"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z"
              />
            </svg>
          </button>
        )}
      </span>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Input
        aria-label="Contract name"
        value={draft}
        maxLength={120}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void save();
          } else if (e.key === 'Escape') {
            cancel();
          }
        }}
        className="w-56"
      />
      <Button type="button" size="sm" loading={saving} onClick={() => void save()}>
        Save
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={cancel} disabled={saving}>
        Cancel
      </Button>
      {error && (
        <span role="alert" className="text-xs font-normal text-rose-600 dark:text-rose-400">
          {error}
        </span>
      )}
    </span>
  );
}
