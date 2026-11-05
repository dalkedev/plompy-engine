# A timeout is not a failure: building a self-hosted agent that knows when to stop

A personal agent is easy to describe: send a message, let it work, get an answer.
The difficult case is the one where the answer never comes back.

Imagine an agent publishing a post. The website accepts it. Before the agent can record the
confirmation, its process times out. The local task now looks interrupted, but the post is
already public. Starting the whole task again can publish the same thing twice.

This is one of the problems behind **[szpont-engine](https://github.com/dalkedev/szpont-engine)**:
a small, self-hosted engine connecting private Discord threads to Codex CLI sessions,
a SQLite queue and a private Markdown workspace. Send a task from your phone; the work
happens on your own Linux machine.

The first public edition focuses on one worker and explicit recovery. The optional Camoufox
bridge provides browser tools over local MCP. Neither a browser click nor a completed model
turn is proof that an external publication succeeded.

## Three different questions

Three things can fail independently:

1. **Was the instruction accepted?** A verified owner message enters the queue with its Discord
   message ID. Receiving that same ID again should not create another job.
2. **Did the local turn finish?** The engine starts a bounded subprocess, stores its session ID
   and requires a completed turn event. A killed process is not a completed turn.
3. **Did the external action happen?** The external service owns this answer. The local queue
   cannot establish it from a timeout.

A unique job ID solves duplicate intake. It does not make arbitrary external effects exactly once.

## Recovery is a state transition

The queue records `queued`, `running`, `succeeded`, `failed` and `interrupted` jobs.
On restart, jobs that were running become interrupted. Their conversations are blocked until
the owner requests recovery; other queued conversations can continue.

An interrupted job is never automatically put back into the execution queue.

The owner can inspect `!status` and `!result MESSAGE_ID`, then use `!recover MESSAGE_ID`.
Recovery creates a new job referencing the original instruction and tells the runtime to inspect
saved state and destination receipts first. This is a useful workflow, not a guarantee that the
model will reconcile every external system correctly.

For a publication, the question is concrete: does the intended post already exist under the
intended account? If it does, record the destination evidence. If the result remains uncertain,
stop for reconciliation. A second click is not a diagnostic tool.

## Delivering the answer has its own ambiguity

The task result and its Discord notification are separate state.

Before sending a result, the engine reserves its notification as `sending`. If the process
crashes at that point, it cannot reliably tell whether Discord received the answer. On startup,
that reservation becomes `ambiguous`; it is not automatically resent.

The saved result remains available through `!result`, without repeating the underlying task.
There is no distributed transaction here. The design makes uncertainty visible.

## Public engine, private memory

Publishing an agent's source should not require publishing its conversations.

The public repository contains the engine, tests, dependency locks and synthetic templates.
A setup command creates a separate private Git workspace outside the source checkout:

```sh
npm run init:workspace -- "$HOME/.local/share/szpont/workspace"
```

That workspace holds personality instructions, owner preferences, notes and transcripts. The
engine commits selected Markdown locally; it does not push it. Credentials, Codex authentication
and browser state stay outside both the public source and memory history.

Guild, owner, bot and forum IDs are required configuration, so another person can run the engine
without inheriting the author's account settings.

## What the tests can establish

Offline tests exercise real SQLite job transitions, restart interruption, duplicate intake,
notification ambiguity, session identity and child-process timeout handling. Fake subprocesses
emit representative Codex events, without model calls or account actions.

Other checks cover configured authorization and workspace initialization, including refusal to
overwrite existing data or create private memory inside the public source checkout.

These tests do not establish live Discord permissions, browser authentication, model entitlement
or successful publication. Those require observed checks on the target installation.

## A deliberately limited first edition

This edition has one global worker, text and bounded still-image intake, and no message-history catch-up after a
full outage. The private installation's concurrent lanes, editorial scheduler and publication
broker are not included. Browser navigation checks are best-effort guards; processes sharing
a Unix account still share a trust boundary.

The starting promise is smaller: keep local state durable, preserve the right conversation,
and expose interrupted or uncertain work before continuing it.

The [source is MIT-licensed](https://github.com/dalkedev/szpont-engine). Start with
[`store.ts`](../../apps/discord-agent/src/store.ts) for state transitions and
[`engine.ts`](../../apps/discord-agent/src/engine.ts) for execution and notification handling.
