// Preloaded by the CI test matrix via --import for workspaces whose tests build
// an atproto IdResolver.
//
// @atproto-labs/fetch-node's unicast SSRF guard reads `process.versions.undici`
// to decide whether the runtime carries undici's SSRF fix. Deno does not emulate
// that field, so the check sees `undefined` and `createDefaultFetch` throws
// "Unicast SSRF protection requires Node.js 20.6+", which kills anything
// constructing an IdResolver. The question the guard is asking -- is undici
// patched? -- is inapplicable under Deno, whose fetch is not undici at all,
// rather than unanswered.
//
// Lives at the org root rather than in any one workspace because the failure is
// a property of the CI environment shared by every workspace, not of any
// service. Nothing in the services depends on it; it is inert unless the guard
// runs.
const versions = process.versions as Record<string, string>;
if (!versions.undici) versions.undici = "6.11.1";
