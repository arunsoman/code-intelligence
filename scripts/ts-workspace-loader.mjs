// Test/dev loader for filesystems that cannot hold the symlinks npm workspaces create (no symlink support, or a
// node_modules populated with real copies). Node's native TypeScript stripping refuses files under node_modules,
// so the workspace specifiers are redirected at the real package sources, which live outside node_modules.
//
//   node --experimental-loader ./scripts/ts-workspace-loader.mjs --test packages/core/test/*.test.ts
//
// On a normal checkout (real symlinks) this loader is unnecessary: node_modules/@cie/* already resolves outside
// node_modules and strips fine without it.
const entries = {
  "@cie/schema": new URL("../packages/schema/src/index.ts", import.meta.url).href,
  "@cie/model": new URL("../packages/model/src/index.ts", import.meta.url).href,
};

export async function resolve(specifier, context, nextResolve) {
  const hit = entries[specifier]; // the workspace packages export only ".": exact match is the whole contract
  if (hit) return { url: hit, shortCircuit: true };
  return nextResolve(specifier, context);
}
