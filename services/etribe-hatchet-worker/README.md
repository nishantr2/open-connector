# eTribe Hatchet Worker

Versioned cloud runtime for the eTribe self-running operating system.

## Ownership

- Google Drive remains canonical durable project truth.
- Supabase owns operational jobs, approvals, route gates, events, evidence, and recovery state.
- Hatchet owns active workflow execution and bounded execution retries after dispatch.
- This Railway service is a capability worker only. It is not a second task database.

## Runtime

Hatchet worker name: `ETRIBE_CLOUD_RUNTIME_V2`.

Registered workflows:

- `etribe-cloud-acceptance-v2` — reversible worker acceptance.
- `etribe-retry-acceptance-v2` — intentionally fails once to prove Hatchet-owned retries.
- `etribe-cloud-noop-job-v2` — end-to-end no-side-effect operating-system acceptance.
- `etribe-drive-job-v2` — Google Drive capability wrapper. Keep its Supabase route disabled until the Drive service-account and effect-idempotency acceptance gates pass.

The V2 names are intentionally different from the retired Railway Function worker so stale replicas cannot consume V2 work.

## Required environment

- `HATCHET_CLIENT_TOKEN`
- `SUPABASE_URL`
- `HATCHET_WORKER_SLOTS` (production cap: 5)
- `PORT`

No static callback secret is stored in this service. Supabase creates a job-scoped callback capability token and sends it in Hatchet workflow input. The token authorizes callbacks only for that job.

## Dispatch path

`os_jobs queued` -> Postgres event trigger -> Supabase `hatchet-dispatcher` -> Hatchet stable API -> this worker -> Supabase `hatchet-control` -> result/evidence writeback.

A one-minute dispatcher recovery heartbeat handles missed/due events. A five-minute run monitor reconciles terminal Hatchet state if callback writeback is missed.

## Activation gate

Do not enable a capability route until all of these pass:

1. Worker health and Hatchet listener registration.
2. Reversible acceptance task.
3. Fail-once retry acceptance.
4. Supabase -> Hatchet -> worker -> Supabase no-op round trip.
5. Duplicate/idempotency test.
6. Capability-specific acceptance test.

FCP/SpliceKit, Blender, and ComfyUI remain Mac-local capabilities and must never be routed to this cloud worker.
