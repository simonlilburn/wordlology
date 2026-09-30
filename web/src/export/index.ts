// Export entry points. Owned by the platform agent.
export type ExportLevel = 'tree' | 'card' | 'atlas';

/** Open the export dialog for a level (size guard, partial export, filter limit). */
export function openExport(level?: ExportLevel): void {}

/** Copy the R snippet for the most recent export (or the one the current level would produce). */
export async function copyRCode(): Promise<void> {}
