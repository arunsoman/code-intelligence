export { runModel } from "./gateway.ts";
export type { GatewayResult, GatewayFailure } from "./gateway.ts";
export { StubProvider } from "./stub.ts";
export { inferSourceOverview } from "./source-overview.ts";
export { OllamaProvider, modelEvidence, listInstalledModels, hasModel, resolveModel, type ModelResolution } from "./ollama.ts";
export { createProvider } from "./factory.ts";
export type { ProviderChoice } from "./factory.ts";
export { BudgetController, type BudgetPolicy } from "./budget.ts";
