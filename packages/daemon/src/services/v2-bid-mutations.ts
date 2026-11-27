import { randomUUID } from 'node:crypto';
import {
  BraiinsApiError,
  BraiinsInvalidRequestError,
  BraiinsNetworkError,
  normalizeV2BidState,
  type BraiinsClient,
  type PlaceBidRequest,
} from '@hashrate-autopilot/braiins-client';
import { sql, type Kysely } from 'kysely';
import type { Proposal } from '../controller/types.js';
import { OwnedBidsRepo } from '../state/repos/owned_bids.js';
import type { Database } from '../state/types.js';

type BidProposal = Exclude<Proposal, { kind: 'PAUSE' }>;
type Command =
  | { kind: 'place'; body: PlaceBidRequest }
  | { kind: 'price'; bid: string; price: number; decrease: boolean }
  | { kind: 'speed'; bid: string; speed: number }
  | { kind: 'cancel'; bid: string };
type Intent = Database['braiins_mutation_intents'];

const RECONCILE_AFTER_MS = 60_000;

function validateProposal(proposal: BidProposal): void {
  const checkSats = (value: number, field: string) => {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(`${field} must be a safe non-negative integer.`);
  };
  if (proposal.kind === 'CREATE_BID') {
    checkSats(proposal.amount_sat, 'amount_sat');
    checkSats(proposal.price_sat, 'price_sat');
  } else if (!proposal.braiins_order_id.trim() || ['.', '..'].includes(proposal.braiins_order_id)) {
    throw new Error('A public Braiins bid ID is required.');
  }
  if (proposal.kind === 'EDIT_PRICE') checkSats(proposal.new_price_sat, 'price_sat');
  const speed =
    proposal.kind === 'EDIT_SPEED'
      ? proposal.new_speed_limit_ph
      : proposal.kind === 'CREATE_BID'
        ? proposal.speed_limit_ph
        : undefined;
  if (speed !== undefined && (!Number.isFinite(speed) || speed < 0))
    throw new Error('Invalid speed limit.');
}

function commandFor(proposal: BidProposal, uuid: string): Command {
  switch (proposal.kind) {
    case 'CREATE_BID':
      return {
        kind: 'place',
        body: {
          dest_upstream: { url: proposal.dest_pool_url, identity: proposal.dest_worker_name },
          amount_sat: proposal.amount_sat,
          price_sat: proposal.price_sat,
          speed_limit_ph: proposal.speed_limit_ph,
          memo: `hashrate-autopilot ${uuid}`,
        },
      };
    case 'EDIT_PRICE':
      return {
        kind: 'price',
        bid: proposal.braiins_order_id,
        price: proposal.new_price_sat,
        decrease: proposal.new_price_sat < proposal.old_price_sat,
      };
    case 'EDIT_SPEED':
      return { kind: 'speed', bid: proposal.braiins_order_id, speed: proposal.new_speed_limit_ph };
    case 'CANCEL_BID':
      return { kind: 'cancel', bid: proposal.braiins_order_id };
  }
}

function terminal(status: string | undefined): boolean {
  return status === 'BID_STATUS_CANCELED' || status === 'BID_STATUS_FULFILLED';
}

function hasSettledTerms(status: string | undefined): boolean {
  return (
    status === 'BID_STATUS_ACTIVE' ||
    status === 'BID_STATUS_CREATED' ||
    status === 'BID_STATUS_PAUSED' ||
    status === 'BID_STATUS_FROZEN'
  );
}

// Braiins canonicalizes the scheme, host and port on placement. Keep the
// authority-key path case sensitive for Stratum V2 and secure destinations.
function comparablePool(value: string): string {
  const input = value.trim();
  const url = new URL(input.includes('://') ? input : 'stratum+tcp://' + input);
  const port = url.port || (url.protocol.startsWith('stratum2+') ? '3336' : '3333');
  return (
    url.protocol +
    '//' +
    url.hostname.toLowerCase() +
    ':' +
    port +
    (url.pathname === '/' ? '' : url.pathname)
  );
}

function acceptedCancelStatus(raw: string | undefined): string {
  switch (raw) {
    case 'BID_STATE_CANCELING':
      return 'BID_STATUS_PENDING_CANCEL';
    case 'BID_STATE_CANCELED':
      return 'BID_STATUS_CANCELED';
    case 'BID_STATE_FULFILLED':
      return 'BID_STATUS_FULFILLED';
    default:
      throw new Error('Cancellation has an unrecognized outcome. Keeping the original request ID.');
  }
}

/** The same instance serves the tick and the dashboard. Network calls always
 * run outside SQLite transactions. The outstanding UUID survives a crash in
 * the gap between remote execution and committing the local ownership row. */
export class V2BidMutations {
  private busy = false;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly client: BraiinsClient,
    private readonly now: () => number = Date.now,
  ) {}

  async pending() {
    return (
      (await this.db
        .selectFrom('braiins_mutation_intents')
        .selectAll()
        .where('id', '=', 1)
        .executeTakeFirst()) ?? null
    );
  }

  async pendingForOperator() {
    const row = await this.pending();
    if (!row) return null;
    const command = JSON.parse(row.command) as Command;
    return {
      request_id: row.request_id,
      account_id: row.account_id,
      created_at: row.created_at,
      command,
      needs_review:
        command.kind === 'place' &&
        !row.unexecuted &&
        this.now() - row.created_at >= RECONCILE_AFTER_MS,
    };
  }

  private async account(): Promise<string> {
    if (this.client.apiVersion !== 'v2' || !this.client.getAccountId) {
      throw new Error('Braiins v2 account required.');
    }
    return this.client.getAccountId();
  }

  async run(proposal: BidProposal): Promise<string> {
    validateProposal(proposal);
    if (this.busy) throw new Error('A Braiins bid change is already in progress.');
    this.busy = true;
    try {
      const account = await this.account();
      const { intent, command, priorUncertain } = await this.db
        .transaction()
        .execute(async (tx) => {
          const binding = await tx
            .selectFrom('braiins_account_binding')
            .selectAll()
            .where('id', '=', 1)
            .executeTakeFirst();
          if (binding?.account_id !== account)
            throw new Error('The Braiins account differs from the locally bound account.');
          const runtime = await tx
            .selectFrom('runtime_state')
            .select('run_mode')
            .where('id', '=', 1)
            .executeTakeFirst();
          if (binding.needs_live_confirmation || runtime?.run_mode !== 'LIVE')
            throw new Error('Braiins bid changes require LIVE mode.');
          const existing = await tx
            .selectFrom('braiins_mutation_intents')
            .selectAll()
            .where('id', '=', 1)
            .executeTakeFirst();
          const now = this.now();
          let uuid = existing?.request_id ?? randomUUID();
          let command = commandFor(proposal, uuid);
          if (existing && existing.account_id !== account)
            throw new Error('An unresolved change belongs to another Braiins account.');
          if (existing?.retry_at != null && now < existing.retry_at)
            throw new Error('Waiting for the Braiins rate limit to reset.');
          if (existing?.unexecuted) {
            // Every attempt was rejected without execution. A new decision may
            // replace this one, but a changed payload needs its own UUID and memo.
            if (existing.command !== JSON.stringify(command)) {
              uuid = randomUUID();
              command = commandFor(proposal, uuid);
            }
          } else if (existing) {
            const original = JSON.parse(existing.command) as Command;
            if (existing.accepted)
              throw new Error('The prior Braiins edit was accepted and is awaiting confirmation.');
            const age = now - existing.created_at;
            if (age < 0)
              throw new Error(
                'Correct the system clock before reconciling the pending Braiins change.',
              );
            if (original.kind === 'place' && age >= RECONCILE_AFTER_MS)
              throw new Error(
                `Verify the pending placement ${uuid} on Braiins before placing another bid.`,
              );
            if (existing.command !== JSON.stringify(command))
              throw new Error(`Resolve the pending Braiins change ${uuid} first.`);
            if (age >= RECONCILE_AFTER_MS)
              throw new Error(`Waiting to reconcile Braiins request ${uuid}.`);
            command = original;
          }
          const owned = new OwnedBidsRepo(tx);
          if (command.kind === 'place') {
            if ((await owned.listActiveForPrune()).length)
              throw new Error('An owned bid is still open. Refresh before creating a bid.');
          } else {
            const bid = await owned.findById(command.bid);
            if (!bid || bid.abandoned || terminal(bid.last_known_status ?? ''))
              throw new Error('Bid is not an active owned bid.');
            if (bid.last_known_status === 'BID_STATUS_PENDING_CANCEL')
              throw new Error('Cancellation is pending.');
            if (
              bid.last_known_status === 'BID_STATUS_CREATING' ||
              bid.last_known_status === 'BID_STATUS_UPDATING' ||
              bid.last_known_status === 'BID_STATUS_UNSPECIFIED'
            )
              throw new Error('Waiting for Braiins to confirm the bid state.');
          }
          const priorUncertain = existing != null && !existing.unexecuted;
          const intent = {
            id: 1,
            account_id: account,
            request_id: uuid,
            command: JSON.stringify(command),
            created_at: priorUncertain ? existing.created_at : now,
            attempt: existing?.request_id === uuid ? existing.attempt + 1 : 1,
            accepted: 0,
            unexecuted: 0,
            retry_at: null,
          };
          // Commit the unknown disposition *before* calling Braiins. A crash
          // during a retry must lose the earlier certainty of non-execution.
          if (existing) {
            await tx
              .updateTable('braiins_mutation_intents')
              .set(intent)
              .where('id', '=', 1)
              .execute();
          } else {
            await tx.insertInto('braiins_mutation_intents').values(intent).execute();
          }
          return { intent, command, priorUncertain };
        });
      return await this.dispatch(intent, command, priorUncertain);
    } finally {
      this.busy = false;
    }
  }

  private async dispatch(
    intent: Intent,
    command: Command,
    priorUncertain: boolean,
  ): Promise<string> {
    const deadline = intent.created_at + RECONCILE_AFTER_MS;
    let id: string;
    let status: string | undefined;
    let settledAmountSat: number | undefined;
    try {
      switch (command.kind) {
        case 'place': {
          const response = await this.client.placeBid(command.body, intent.request_id, deadline);
          if (!response.id) throw new Error('Braiins did not return a bid ID.');
          id = response.id;
          settledAmountSat = response.settledAmountSat;
          status = response.bidState
            ? normalizeV2BidState(response.bidState)
            : 'BID_STATUS_CREATED';
          break;
        }
        case 'price':
        case 'speed': {
          id = command.bid;
          const patch =
            command.kind === 'price'
              ? { new_price_sat: command.price }
              : { new_speed_limit_ph: { value: command.speed } };
          const edit = await this.client.editBid(
            { bid_id: id, ...patch },
            intent.request_id,
            deadline,
          );
          settledAmountSat = edit?.settledAmountSat;
          if (edit?.bidState) status = normalizeV2BidState(edit.bidState);
          break;
        }
        case 'cancel': {
          id = command.bid;
          const result = await this.client.cancelBid({ order_id: id }, intent.request_id, deadline);
          status = acceptedCancelStatus(result.bidState);
          settledAmountSat = result.settledAmountSat;
          break;
        }
      }
    } catch (error) {
      // A gateway rejection can happen while replaying a request whose
      // previous outcome is unknown (e.g. an expired key). A mismatched
      // UUID, invalid JSON or unreadable success also needs reconciliation.
      if (error instanceof BraiinsInvalidRequestError && !priorUncertain) await this.remove(intent);
      const apiError = error instanceof BraiinsNetworkError ? error.cause : error;
      if (apiError instanceof BraiinsApiError) {
        if (apiError.status === 429) {
          await this.db
            .updateTable('braiins_mutation_intents')
            .set({
              retry_at: sql`max(coalesce(retry_at, 0), ${apiError.retryAt ?? this.now()})`,
              // A second sender may already have reserved this UUID. A late
              // rejection from our attempt cannot speak for the other one.
              unexecuted:
                !priorUncertain && error === apiError
                  ? sql`CASE WHEN attempt = ${intent.attempt} THEN 1 ELSE unexecuted END`
                  : 0,
            })
            .where('request_id', '=', intent.request_id)
            .execute();
        }
        const denied = apiError.status === 401 || apiError.status === 403;
        if (denied) {
          await this.db.transaction().execute(async (tx) => {
            await tx
              .updateTable('runtime_state')
              .set({ run_mode: 'PAUSED' })
              .where('id', '=', 1)
              .execute();
            await tx
              .updateTable('braiins_account_binding')
              .set({ needs_live_confirmation: 1 })
              .where('account_id', '=', intent.account_id)
              .execute();
          });
        }
        if (
          error instanceof BraiinsApiError &&
          error.status >= 400 &&
          error.status < 500 &&
          ![408, 409, 429].includes(error.status) &&
          !(priorUncertain && (denied || !error.reason))
        ) {
          await this.remove(intent);
        }
      }
      throw error;
    }
    const confirmedTerms = hasSettledTerms(status);
    const awaitingEdit =
      (command.kind === 'price' || command.kind === 'speed') &&
      !confirmedTerms &&
      !terminal(status) &&
      status !== 'BID_STATUS_PENDING_CANCEL';
    await this.finish(intent, command, id, status, settledAmountSat, {
      awaitingEdit,
      confirmedDecrease: confirmedTerms,
    });
    return `Braiins v2 ${command.kind} accepted for ${id}${status ? ' (' + status + ')' : ''}`;
  }

  private async remove(intent: Intent) {
    await this.db
      .deleteFrom('braiins_mutation_intents')
      .where('request_id', '=', intent.request_id)
      .where('attempt', '=', intent.attempt)
      .execute();
  }

  private async finish(
    intent: Intent,
    command: Command,
    id: string,
    status?: string,
    settledAmountSat?: number,
    options: { awaitingEdit?: boolean; confirmedDecrease?: boolean } = {},
  ) {
    await this.db.transaction().execute(async (tx) => {
      if (options.awaitingEdit) {
        const taken = await tx
          .updateTable('braiins_mutation_intents')
          .set({ accepted: 1 })
          .where('request_id', '=', intent.request_id)
          .executeTakeFirst();
        if (taken.numUpdatedRows === 0n) return;
      } else {
        const done = await tx
          .deleteFrom('braiins_mutation_intents')
          .where('request_id', '=', intent.request_id)
          .executeTakeFirst();
        if (done.numDeletedRows === 0n) return;
      }
      const owned = new OwnedBidsRepo(tx);
      if (command.kind === 'place') {
        if (await owned.findById(id))
          throw new Error('The confirmed bid already belongs to the ownership ledger.');
        await owned.insert({
          braiins_order_id: id,
          cl_order_id: null,
          created_at: intent.created_at,
          price_sat: command.body.price_sat,
          amount_sat: command.body.amount_sat,
          speed_limit_ph: command.body.speed_limit_ph ?? null,
          last_known_status: status ?? 'BID_STATUS_CREATED',
          dest_url: command.body.dest_upstream.url,
        });
      } else if (command.kind === 'price' && command.decrease && options.confirmedDecrease) {
        await owned.setLastPriceDecrease(id, intent.created_at, command.price);
      }
      if (status && (command.kind !== 'place' || settledAmountSat !== undefined)) {
        await owned.setKnownStatus(id, status, settledAmountSat);
      }
    });
  }

  /** Past the retry window read the current state before a future tick may
   * issue a new edit or cancel. Failed reads leave the intent intact. */
  async reconcile(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const intent = await this.pending();
      if (
        !intent ||
        intent.unexecuted ||
        (intent.retry_at !== null && this.now() < intent.retry_at)
      )
        return;
      const age = this.now() - intent.created_at;
      if (!intent.accepted && age < RECONCILE_AFTER_MS) return;
      const command = JSON.parse(intent.command) as Command;
      if (command.kind === 'place') return; // list absence never proves non-execution
      if ((await this.account()) !== intent.account_id)
        throw new Error('Pending mutation belongs to another account.');
      const { bid, counters_committed } = await this.client.getBidDetail(command.bid);
      if (bid.id !== command.bid) return;
      if (terminal(bid.status) || bid.status === 'BID_STATUS_PENDING_CANCEL') {
        await this.finish(
          intent,
          command,
          command.bid,
          bid.status,
          counters_committed?.amount_consumed_sat,
          { confirmedDecrease: command.kind === 'price' && bid.price_sat === command.price },
        );
        return;
      }
      if (!hasSettledTerms(bid.status)) return;
      // Remote state is settled. The next tick will re-evaluate current
      // terms before asking for a fresh command.
      const desired =
        command.kind === 'price'
          ? bid.price_sat === command.price
          : command.kind === 'speed' && (bid.speed_limit_ph ?? 0) === command.speed;
      if (desired) {
        await this.finish(
          intent,
          command,
          command.bid,
          bid.status,
          counters_committed?.amount_consumed_sat,
          { confirmedDecrease: command.kind === 'price' && bid.price_sat === command.price },
        );
      } else if (age >= RECONCILE_AFTER_MS) {
        // The server reports settled terms. The controller will decide anew,
        // using its next observation rather than replaying an outdated edit.
        await this.db.transaction().execute(async (tx) => {
          const released = await tx
            .deleteFrom('braiins_mutation_intents')
            .where('request_id', '=', intent.request_id)
            .executeTakeFirst();
          if (released.numDeletedRows > 0n)
            await new OwnedBidsRepo(tx).setKnownStatus(command.bid, bid.status);
        });
      }
    } finally {
      this.busy = false;
    }
  }

  /** Resolve a confirmed non-execution after the operator has checked with
   * Braiins. Absence from the bid list cannot establish this outcome. */
  async confirmNotPlaced(requestId: string, confirmationReference: string): Promise<void> {
    if (this.busy) throw new Error('A Braiins bid change is in progress.');
    const reference = confirmationReference.trim();
    if (!reference || reference.length > 250)
      throw new Error('Supply the independent confirmation reference (up to 250 characters).');
    this.busy = true;
    try {
      const account = await this.account();
      await this.db.transaction().execute(async (tx) => {
        const row = await tx
          .selectFrom('braiins_mutation_intents')
          .selectAll()
          .where('request_id', '=', requestId)
          .executeTakeFirst();
        if (
          !row ||
          row.account_id !== account ||
          (JSON.parse(row.command) as Command).kind !== 'place'
        ) {
          throw new Error('The pending placement does not match the request and account.');
        }
        if (row.unexecuted) throw new Error('Braiins rate limited the placement before execution.');
        if (this.now() - row.created_at < RECONCILE_AFTER_MS)
          throw new Error('The placement is still within its retry window.');
        const runtime = await tx
          .selectFrom('runtime_state')
          .select('run_mode')
          .where('id', '=', 1)
          .executeTakeFirst();
        if (runtime?.run_mode !== 'PAUSED')
          throw new Error('Pause bidding before confirming non-execution.');
        await tx
          .updateTable('braiins_account_binding')
          .set({ needs_live_confirmation: 1 })
          .where('account_id', '=', account)
          .execute();
        await tx
          .insertInto('system_events')
          .values({
            occurred_at: this.now(),
            kind: 'braiins_placement_not_executed',
            field: null,
            old_value: row.command,
            new_value: null,
            detail: `Request ${requestId}; operator confirmation: ${reference}`,
          })
          .execute();
        await tx
          .deleteFrom('braiins_mutation_intents')
          .where('request_id', '=', requestId)
          .execute();
      });
    } finally {
      this.busy = false;
    }
  }

  /** An explicit operator-supplied ID links the unresolved creation to a
   * concrete bid in this account. Use the unique memo chosen before send. */
  async resolvePlacement(requestId: string, bidId: string): Promise<void> {
    if (this.busy) throw new Error('A Braiins bid change is in progress.');
    this.busy = true;
    try {
      const intent = await this.pending();
      if (!intent || intent.request_id !== requestId)
        throw new Error('Pending placement ID does not match.');
      if (intent.unexecuted)
        throw new Error('Braiins rate limited the placement before execution.');
      if ((await this.account()) !== intent.account_id)
        throw new Error('Pending placement belongs to another account.');
      const command = JSON.parse(intent.command) as Command;
      if (command.kind !== 'place') throw new Error('The pending change is not a placement.');
      const { bid, counters_committed } = await this.client.getBidDetail(bidId);
      if (bid.id !== bidId || bid.memo !== command.body.memo)
        throw new Error('Bid ID or placement memo does not match.');
      const destination = bid.dest_upstream;
      if (
        !destination?.url ||
        destination.identity.trim() !== command.body.dest_upstream.identity.trim() ||
        comparablePool(destination.url) !== comparablePool(command.body.dest_upstream.url)
      ) {
        throw new Error('The bid destination or worker differs from the recorded placement.');
      }
      const createdAt = Date.parse(bid.created ?? '');
      const clockSkew = 5 * 60_000;
      if (
        !Number.isFinite(createdAt) ||
        createdAt < intent.created_at - clockSkew ||
        createdAt > this.now() + clockSkew
      ) {
        throw new Error('The bid creation time does not match the pending placement.');
      }
      await this.finish(
        intent,
        command,
        bidId,
        bid.status,
        counters_committed?.amount_consumed_sat,
      );
    } finally {
      this.busy = false;
    }
  }
}
