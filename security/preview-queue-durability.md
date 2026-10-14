<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Preview queue durability

Webhook deploy/close events, manual teardown and expired-preview cleanup commit
their state transition, immutable preview_queue_jobs snapshot and
queue_outbox_events intention in one PostgreSQL transaction. Redis carries only
previewJobId. The dispatcher retries publication with the same BullMQ-safe job
ID and both queues are in the transactional registry.

Workers load the snapshot before side effects, skip completed or superseded
intentions, and mark completion only after the existing handler succeeds.
Errors remain visible through outbox last_error/attempt_count or BullMQ retries.
A recovered teardown preserves container_id and tearing_down until the worker
confirms removal. Older queued payloads remain accepted during deployment.

The latest queue_job_id prevents a delayed replay from starting an obsolete
transition. It is not a lease for already running deployment/teardown handlers;
their existing concurrency behavior is unchanged. No Redis flush or infrastructure
fault injection is performed by validation. PostgreSQL tests use isolated temporary
tables and a publisher that rejects, then succeeds.

Apply migration 0081 before the API and worker release. Job snapshots are retained
as durable records; their retention policy follows a later operator decision.
