'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Card, Field, Input, Mono, Select, formatLedgers } from '@stellar-health/ui';
import { PageHeader } from '@/components/app-shell';
import { api, ApiError, errorMessage } from '@/lib/api';
import {
  BACKFILL_OPTIONS,
  backfillLedgers,
  DEFAULT_BACKFILL,
  type BackfillChoice,
} from '@/lib/backfill';
import { NETWORK_OPTIONS, type Contract, type Network } from '@/lib/types';

interface Validation {
  contractId: string;
  network: Network;
  executableType: string;
  wasmHash: string | null;
  instanceLiveUntilLedger: number | null;
  codeLiveUntilLedger: number | null;
  latestLedger: number;
  alreadyRegistered: string | null;
}

const CONTRACT_ID_RE = /^C[A-Z2-7]{55}$/;

export default function AddContractPage() {
  const router = useRouter();
  const [contractId, setContractId] = useState('');
  const [network, setNetwork] = useState<Network>('TESTNET');
  const [label, setLabel] = useState('');
  const [backfill, setBackfill] = useState<BackfillChoice>(DEFAULT_BACKFILL);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);

  const trimmed = contractId.trim().toUpperCase();
  const formatError =
    trimmed.length === 0
      ? null
      : trimmed.startsWith('G')
        ? 'That looks like an account address (G…). Contract IDs start with C.'
        : !CONTRACT_ID_RE.test(trimmed)
          ? 'Contract IDs are 56 characters, start with C and use A–Z and 2–7.'
          : null;

  const reset = () => {
    setValidation(null);
    setError(null);
  };

  async function validate() {
    setValidating(true);
    setError(null);
    try {
      setValidation(
        await api<Validation>('/contracts/validate', {
          method: 'POST',
          body: { contractId: trimmed, network },
        }),
      );
    } catch (err) {
      setValidation(null);
      setError(errorMessage(err));
    } finally {
      setValidating(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!validation) return validate();
    setSaving(true);
    setError(null);
    try {
      const c = await api<Contract>('/contracts', {
        method: 'POST',
        body: {
          contractId: trimmed,
          network,
          label: label.trim() || undefined,
          lookbackLedgers: backfillLedgers(backfill),
        },
      });
      router.push(`/contracts/${c.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ALREADY_REGISTERED') {
        const id = (err.details as { id?: string } | undefined)?.id;
        if (id) return router.push(`/contracts/${id}`);
      }
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Add contract"
        description="Register a deployed contract. We check that it exists on-chain before monitoring starts."
      />
      <Card className="p-5">
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field
            label="Contract ID"
            htmlFor="contractId"
            error={formatError}
            hint="The C… address shown when you deployed the contract."
          >
            <Input
              id="contractId"
              value={contractId}
              onChange={(e) => {
                setContractId(e.target.value);
                reset();
              }}
              placeholder="CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
              className="font-mono"
              spellCheck={false}
              autoComplete="off"
              required
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Network" htmlFor="network">
              <Select
                id="network"
                value={network}
                onChange={(e) => {
                  setNetwork(e.target.value as Network);
                  reset();
                }}
              >
                {NETWORK_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n.charAt(0) + n.slice(1).toLowerCase()}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Label (optional)" htmlFor="label">
              <Input
                id="label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. My token"
                maxLength={120}
              />
            </Field>
          </div>

          <Field
            label="Backfill history"
            htmlFor="backfill"
            hint="Events older than the RPC's retention window can't be fetched: public RPCs keep about 7 days (less on some providers), so longer backfills start at the oldest ledger available."
          >
            <Select
              id="backfill"
              value={backfill}
              onChange={(e) => setBackfill(e.target.value as BackfillChoice)}
            >
              {BACKFILL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>

          {error && <Alert title="Could not validate contract">{error}</Alert>}

          {validation && (
            <div
              className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm dark:border-emerald-900 dark:bg-emerald-950/40"
              data-testid="validation-result"
            >
              <p className="font-medium text-emerald-800 dark:text-emerald-200">
                ✓ Contract found on {validation.network.toLowerCase()}
              </p>
              <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs text-emerald-900 sm:grid-cols-2 dark:text-emerald-200">
                <dt className="text-emerald-700 dark:text-emerald-400">Type</dt>
                <dd>
                  {validation.executableType === 'wasm'
                    ? 'WASM contract'
                    : 'Stellar Asset Contract'}
                </dd>
                {validation.wasmHash && (
                  <>
                    <dt className="text-emerald-700 dark:text-emerald-400">WASM hash</dt>
                    <dd>
                      <Mono>{validation.wasmHash.slice(0, 16)}…</Mono>
                    </dd>
                  </>
                )}
                <dt className="text-emerald-700 dark:text-emerald-400">Instance TTL</dt>
                <dd>
                  {formatLedgers(
                    validation.instanceLiveUntilLedger
                      ? validation.instanceLiveUntilLedger - validation.latestLedger
                      : null,
                  )}
                </dd>
                {validation.codeLiveUntilLedger && (
                  <>
                    <dt className="text-emerald-700 dark:text-emerald-400">Code TTL</dt>
                    <dd>
                      {formatLedgers(validation.codeLiveUntilLedger - validation.latestLedger)}
                    </dd>
                  </>
                )}
              </dl>
              {validation.alreadyRegistered && (
                <p className="mt-2 text-xs">
                  Already monitored —{' '}
                  <Link className="underline" href={`/contracts/${validation.alreadyRegistered}`}>
                    open it
                  </Link>
                  .
                </p>
              )}
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="secondary"
              onClick={validate}
              loading={validating}
              disabled={!trimmed || Boolean(formatError)}
            >
              Validate
            </Button>
            <Button
              type="submit"
              loading={saving}
              disabled={!validation || Boolean(validation.alreadyRegistered)}
            >
              Start monitoring
            </Button>
          </div>
        </form>
      </Card>
      <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">
        Backfilled history is limited to the RPC retention window (about 7 days on public testnet
        RPC). Older events are not available from RPC.
      </p>
    </div>
  );
}
