# Shared contract seeds

These are reviewable starting interfaces and machine-readable design constraints, not a working game, vendor SDK wrappers, or validated vehicle tuning. A0 owns this directory; department leads must approve changes before consumers diverge.

- `runtime-contracts.ts`: engine-independent subsystem interfaces. All platform callbacks are translated inside a target adapter, never copied directly into gameplay code.
- `vehicle-config.schema.json`: JSON Schema for original vehicle tuning records. Validate data at build time; this schema alone does not prove physical plausibility.
- `vehicle-config.example.json`: an intentionally unvalidated ARC-S tuning seed, with units explicit. Tune on the handling fixtures before calling it production-ready.
- `quality-budgets.json`: internal targets, not achieved measurements or guarantees. The human-readable specifications explain methodology and platform-specific exceptions.

At G0, review these contracts against the selected engine/library versions and generate a contract version/change log. Keep runtime immutable snapshots separate from mutable solver state. Do not pull a renderer or vendor SDK dependency into the shared types.

## Revision 2.0 additions

`owner-review-contracts.ts` defines profile/identity/export interfaces only. `qa-gates.json` freezes stage membership and minimum internal evidence. `owner-review` is the private fifth target; four production targets remain. No schema or interface implements the game or demonstrates that runtime tests passed.
