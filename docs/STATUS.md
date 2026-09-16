# Enterprise login implementation status

Updated 2026-09-16. PR #422 targets `V0.9.1@f4f0fbde30e56d2f436ebfa06409b3b04136414c`, with Harness `0.1.5-rc.2`. The merge preserves enterprise-login history and uses the version branch's rollout declarations and tests. The release workflow includes pull requests targeting V0.9.1.

## Implemented

- Model usage keeps the actual used and limit values when an administrator lowers quota. Hover percentages cap at 100%; both displays use the shared neutral secondary text color.
- BiSheng enterprise browser login, callback handling, secure local credential vault, token refresh and logout.
- Enterprise model adapter and account settings for the compatible `0.4.0` and `0.5.0` contracts.
- Enterprise model catalogues publish each model's managed vision capability. Image-capable models advertise text and image input; text-only models continue to advertise text input.
- Enterprise account API routes explicitly use buffered request bodies, which keeps the local state read and browser-login refresh compatible with Harness `0.1.5-rc.2`.
- Stable Harness port and prewarmed shell environment remain active while enterprise variables are added to the child process.
- Expired enterprise model selection is cleared and recovered through the session model-selection API. Preference order is the last available non-enterprise model, an available default, then an advertised and routed external model. With no available alternative, the picker shows Select model and keeps submission blocked.
- Previous provider preference survives enterprise model changes and restarts. The first model catalog waits for enterprise login restoration, while a temporary catalog lookup failure preserves a routed enterprise model. Manual selection takes precedence over pending automatic recovery.

## Verification

- Quota display update: all 5 enterprise package tests, type checking and diff checks passed; regression covers a reduced quota (10,000 used / 8,000 limit) displaying 100% on hover and an ordinary 50% case.
- The original model-recovery worktree passed 68 related tests, type checking, isolated actual-component rendering and macOS arm64 package integrity checks. This PR adapts the same recovery logic to the V0.9.1 enterprise-login branch.
- Current merged PR: clean lockfile installation applied all 24 dependency patches; all 970 tests across 114 files passed, including the enterprise account route-body and managed-vision catalogue regressions. Type checking and production build passed.
- Real enterprise login, model calls and native packaged-app acceptance remain separate gates.
