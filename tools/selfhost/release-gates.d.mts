export const ENTRY_BASELINE_BYTES: number;
export const ENTRY_BUDGET_BYTES: number;
export function runGates(distDir: string, options?: { entryBudget?: number }): { ok: boolean; problems: string[]; notes: string[] };
