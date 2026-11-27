import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';

export function BraiinsPendingPlacement() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['braiins-pending-mutation'],
    queryFn: api.pendingBraiinsMutation,
    refetchInterval: 15_000,
    retry: false,
  });
  const pending = query.data?.pending;
  if (!pending || pending.command.kind !== 'place' || !pending.needs_review) return null;
  return (
    <RecoveryForm
      key={pending.request_id}
      requestId={pending.request_id}
      memo={pending.command.body.memo}
      onResolved={() => Promise.all([
        queryClient.invalidateQueries({ queryKey: ['braiins-pending-mutation'] }),
        queryClient.invalidateQueries({ queryKey: ['security-state'] }),
      ])}
    />
  );
}

function RecoveryForm({
  requestId,
  memo,
  onResolved,
}: {
  requestId: string;
  memo: string;
  onResolved: () => void;
}) {
  const { t } = useLingui();
  const [found, setFound] = useState(true);
  const [evidence, setEvidence] = useState('');
  const mutation = useMutation({
    mutationFn: async () => {
      const result = found
        ? await api.resolveBraiinsPlacement(requestId, evidence.trim())
        : await api.confirmBraiinsNonPlacement(requestId, evidence.trim());
      if (!result.ok) throw new Error(result.error ?? t`Could not resolve this placement.`);
    },
    onSuccess: onResolved,
  });
  return (
    <div className="my-4 space-y-2 rounded border border-amber-600 p-3 text-sm">
      <h3 className="font-semibold">
        <Trans>Verify pending Braiins placement</Trans>
      </h3>
      <p>
        <Trans>
          Autopilot is holding new placements. Check current and historical bids on Braiins for this
          memo.
        </Trans>
      </p>
      <code className="break-all">{memo}</code>
      <label className="block">
        <span className="block">
          <Trans>Verification result</Trans>
        </span>
        <select
          className="rounded bg-slate-950 p-2"
          value={found ? 'found' : 'absent'}
          disabled={mutation.isPending}
          onChange={(e) => {
            setFound(e.target.value === 'found');
            setEvidence('');
            mutation.reset();
          }}
        >
          <option value="found">
            <Trans>Found the matching bid</Trans>
          </option>
          <option value="absent">
            <Trans>Braiins confirmed the bid was never placed</Trans>
          </option>
        </select>
      </label>
      {!found && (
        <p>
          <Trans>
            Pause Autopilot and obtain independent confirmation from Braiins. An empty order list
            alone is insufficient.
          </Trans>
        </p>
      )}
      <label className="block">
        <span className="block">
          {found ? t`Braiins bid ID` : t`Braiins confirmation reference`}
        </span>
        <input
          className="w-full rounded border border-slate-700 bg-slate-950 p-2"
          value={evidence}
          disabled={mutation.isPending}
          onChange={(e) => setEvidence(e.target.value)}
        />
      </label>
      <button
        type="button"
        className="rounded bg-slate-700 px-3 py-1.5 disabled:opacity-50"
        disabled={!evidence.trim() || mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        {found ? t`Verify bid and restore tracking` : t`Record confirmed non-placement`}
      </button>
      {mutation.isError && (
        <p role="alert" className="text-red-400">
          {mutation.error.message}
        </p>
      )}
    </div>
  );
}
