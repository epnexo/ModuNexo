-- The register of what agents ask modules to do and what people decide. A person running a write action in the portal is the
-- decision itself (it is recorded already approved); an agent over MCP can only leave a pending proposal, which a person holding
-- the action's permission approves or rejects, and which expires if nobody does. Approving queues the module's own job; the
-- job's result is settled here afterwards. The input is kept because the approver has to see what they approve; it is never
-- copied into an event.

create table core.action_proposals (
  id            bigserial   primary key,
  module_id     text        not null,
  action_key    text        not null,
  risk          text        not null check (risk in ('write', 'sensitive')),
  status        text        not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired')),
  input         jsonb       not null,
  proposed_by   text        not null,
  proposed_via  text        not null check (proposed_via in ('mcp', 'portal', 'cli')),
  proposed_at   timestamptz not null,
  expires_at    timestamptz not null,
  decided_by    text,
  decided_at    timestamptz,
  decision_note text,
  job_id        bigint,
  outcome       text        check (outcome in ('executed', 'failed')),
  last_error    text,
  settled_at    timestamptz
);

create index action_proposals_status_idx on core.action_proposals (status, expires_at);
create index action_proposals_module_idx on core.action_proposals (module_id, action_key, id desc);
-- What still needs settling: approved, with a job, not yet settled.
create index action_proposals_unsettled_idx on core.action_proposals (id) where status = 'approved' and outcome is null and job_id is not null;
