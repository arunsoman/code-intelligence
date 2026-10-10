// Test/dev loader: resolve the workspace packages (@cie/schema, @cie/model) to their real TypeScript sources so
// `node --test` can run without a build step and without symlinks (this filesystem forbids them). Node strips types
// only for files outside node_modules, so the copies under node_modules/@cie are not usable for .ts execution.
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const MAP = {
  "@cie/schema": () => pathToFileURL(resolvePath(root, "packages/schema/src/index.ts")).href,
  "@cie/model": () => pathToFileURL(resolvePath(root, "packages/model/src/index.ts")).href,
};

export async function resolve(specifier, context, nextResolve) {
  if (Object.hasOwn(MAP, specifier)) return { url: MAP[specifier](), shortCircuit: true };
  return nextResolve(specifier, context);
}
