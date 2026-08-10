# Packet-Prep Contact Discovery — Design

**Date:** 2026-07-29
**Status:** Implemented and verified

## Goal

Spend contact-discovery effort only after a strong role has reached explicit
application-packet preparation, while keeping all outreach drafting and delivery behind
the existing confirmed-submission boundary.

Contact discovery answers “who could I contact?” It is application research, not an
outreach action.

## Decision

Application-packet preparation triggers best-effort contact and professional-email
discovery when the role's fit score is **4.3/5 or higher**.

- The trigger is an explicit packet-preparation request, not queue ingestion, queue
  refresh, daily selection, or merely viewing a role.
- Roles below 4.3 do not consume contact-discovery effort during packet preparation.
- A valid cached discovery snapshot is reused instead of repeating provider work.
- Discovery is non-blocking. A provider outage, rate limit, authentication problem, or
  no-result outcome must not prevent the application packet from completing.
- The packet reports the discovery outcome distinctly as found, no verified result, or
  unavailable. Unavailable evidence is never interpreted as proof that no contact
  exists.

The 4.3 floor is intentionally stricter than the 4.0 application minimum. A 4.0 score
means a role may be worth considering; 4.3 means the role is strong enough to justify
additional distribution work.

## Submission and Outreach Boundary

Packet preparation may discover and display:

- a relevant recruiter, hiring manager, or team contact;
- public or first-party relationship evidence;
- a verified professional email address;
- an explicitly labeled convention-derived email hypothesis; and
- manual search links when automated sources are unavailable.

Packet preparation must not:

- mark the role applied or submitted;
- create an implicit permission to contact anyone;
- send email or LinkedIn messages;
- weaken contact-verification requirements; or
- treat an uncertain application state as confirmation.

Outreach drafting, scheduling, and delivery remain gated on confirmed submission
evidence. Existing email-account, rate-limit, evidence, suppression, and human-control
guardrails remain unchanged.

## Workflow Consequence

Routine queue refresh should stop running broad contact discovery across `ready` and
`in_review` roles. Previously cached discovery evidence remains reusable, but new
discovery belongs to qualifying packet preparation.

The resulting lifecycle is:

1. Discover and score the role.
2. Select a role for application work.
3. Explicitly prepare its application packet.
4. If the score is at least 4.3, run or reuse non-blocking contact discovery and include
   the result in the packet.
5. The human reviews and submits the application.
6. Only confirmed submission evidence can unlock outreach preparation or delivery.

## Acceptance Criteria

1. Preparing a packet for a 4.3+ role runs or reuses contact discovery.
2. Preparing a packet below 4.3 does not run new contact discovery.
3. Discovery failure never changes a successful packet into a blocked packet.
4. The packet preserves provenance and distinguishes no-result from source
   unavailability.
5. Queue refresh does not initiate new contact discovery.
6. No packet-preparation path can draft, schedule, or send outreach before confirmed
   submission.

## Implementation Discretion

The exact configuration key, whether discovery runs concurrently with other packet
work, and the packet presentation format are implementation choices. They must preserve
the approved 4.3 floor, non-blocking behavior, cached-evidence reuse, and
confirmed-submission gate.

This decision changes the timing and scope of contact discovery only. It does not
authorize application submission or outreach delivery.
