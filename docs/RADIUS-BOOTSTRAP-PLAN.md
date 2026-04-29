# Radius Bootstrap Parity Plan (OpenClaw ↔ Hermes)

Date: 2026-04-29
Owner: Eriks + Hermes Agent
Target: `radius-openclaw-railway-template`

## Objective

Bring `radius-openclaw-railway-template` to functional parity with the Radius Hermes template for:

- vendored Radius + project skills
- deterministic runtime/plugin wiring for Radius capabilities
- agent-server/discovery/A2A surfaces

without introducing checkpoint gates or partial-feature flags.

## Scope (Today)

1. Vendor and persist Radius skills repo in OpenClaw template.
2. Wire OpenClaw bootstrap to consume vendored and project-specific skills.
3. Introduce deterministic Radius runtime bridge based on upstream skills-repo structure.
4. Add agent-server layer and connect discovery + A2A endpoints.
5. Update docs + deployment instructions for single-pass deployment path.

## Working Assumptions

- We will work from `radiustechsystems/skills` PR #25 ref while unmerged.
- After merge, source ref switches to upstream main with minimal changes.
- Demo deadline is same-day 8pm ET; speed and end-to-end operability are prioritized.

## Initial Gap Summary

`radius-openclaw-railway-template` currently lacks Hermes-style bootstrap assets:

- no `HERMES.md` / `AGENTS.md`
- no bundled `skills/` and `plugins/`
- no `scripts/agent_server/`
- no Radius wallet scripts/runtime wiring

## Execution Order

1. Repo/bootstrap wiring (branch + baseline docs + Docker/entrypoint vendor plumbing)
2. Skills discovery/install path in OpenClaw startup flow
3. Runtime/plugin bridge for deterministic Radius tools
4. Agent server integration (discovery + A2A)
5. Validation, docs, and final deploy/test runbook

## Success Criteria

- OpenClaw deployment boots with Radius vendored skills available and loaded.
- Radius deterministic tools are callable through configured runtime bridge.
- Agent discovery and A2A endpoints are live from OpenClaw template deployment.
- Template documentation reflects the new bootstrap architecture and operator setup.
