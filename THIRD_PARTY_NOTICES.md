# Third-party notices

The agent detection rules in `src/services/agent-rules.ts` and region extraction
in `src/services/agent-model.ts` adapt Herdr detection manifests and behavior:
https://github.com/dmtr-p/herdr/tree/2563803dca97c040beaf3dc3acdcb5a3221b4238

Copyright belongs to the Herdr contributors. These adapted portions are licensed
under Apache License 2.0, reproduced in `docs/licenses/herdr-Apache-2.0.txt`.
The remaining wct code retains its MIT license.

Changes include JavaScript regex syntax, conservative unknown fallback,
explicit readiness evidence, and bounded retention of transcript/menu state.
