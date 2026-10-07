// Build feature wizard: stage list and the rule that navigation is not execution (spec §43.1). Pure, so tests cover it.
export type WizardStage = "DESCRIBE" | "CLARIFY" | "PLAN" | "CHANGES" | "VALIDATE" | "DELIVER";
export const STAGES: { id: WizardStage; label: string; primary: string }[] = [
  { id: "DESCRIBE", label: "Describe", primary: "Start analysis" },
  { id: "CLARIFY", label: "Clarify", primary: "Continue with ready work" },
  { id: "PLAN", label: "Plan", primary: "Build candidate" },
  { id: "CHANGES", label: "Changes", primary: "Request revision" },
  { id: "VALIDATE", label: "Validate", primary: "Run required checks" },
  { id: "DELIVER", label: "Deliver", primary: "Export patch" },
];
/** Effectful actions are always their own buttons; "Next" only moves the view and never starts one (plan S10). */
export const EFFECTFUL_ACTIONS = ["Build candidate", "Run validation", "Export patch", "Create draft PR"] as const;
