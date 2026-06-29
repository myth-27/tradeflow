/**
 * TradeFlow V3 — Data Export/Import (D:\trade_data)
 *
 * Exports the entire database to D:\trade_data for backup.
 * Handles file download in-browser via Blob URLs.
 */

import { exportDatabase, importDatabase } from './db';

const EXPORT_PREFIX = 'tradeflow_v3_';

/** Generate a filename with timestamp */
function generateFilename(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const time = now.toISOString().slice(11, 16).replace(/:/g, '');
  return `${EXPORT_PREFIX}${date}_${time}.json`;
}

/**
 * Export all data as a JSON download.
 * Since we're in a browser, we use Blob + download link.
 * The user can save to D:\trade_data manually.
 */
export async function downloadExport(): Promise<void> {
  const data = await exportDatabase();
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = generateFilename();
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Import data from a JSON file.
 * Opens a file picker and imports the selected file.
 */
export async function importFromFile(): Promise<{ success: boolean; message: string }> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';

    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) {
        resolve({ success: false, message: 'No file selected' });
        return;
      }

      try {
        const text = await file.text();
        const data = JSON.parse(text);

        if (!data.signalMemory && !data.simulationMemory) {
          resolve({ success: false, message: 'Invalid export file format' });
          return;
        }

        await importDatabase(data);

        const signalCount = Array.isArray(data.signalMemory) ? data.signalMemory.length : 0;
        const simCount = Array.isArray(data.simulationMemory) ? data.simulationMemory.length : 0;

        resolve({
          success: true,
          message: `Imported ${signalCount} signals, ${simCount} simulations`,
        });
      } catch (err) {
        resolve({
          success: false,
          message: `Import failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
        });
      }
    };

    input.click();
  });
}

/**
 * Auto-export: saves data periodically.
 * Uses the /api/export endpoint if available (for server-side D:\trade_data writes).
 */
export async function autoExportToServer(): Promise<boolean> {
  try {
    const data = await exportDatabase();
    const res = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return res.ok;
  } catch {
    return false;
  }
}
