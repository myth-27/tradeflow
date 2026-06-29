/**
 * TradeFlow V3 — Data Export API
 *
 * Saves database export to D:\trade_data for persistent backup.
 */

import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';

const EXPORT_DIR = 'D:\\trade_data';

export async function POST(req: Request) {
  try {
    const data = await req.json();

    // Ensure export directory exists
    await fs.mkdir(EXPORT_DIR, { recursive: true });

    // Generate filename
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const timeStr = now.toISOString().slice(11, 16).replace(/:/g, '');
    const filename = `tradeflow_v3_${dateStr}_${timeStr}.json`;
    const filepath = path.join(EXPORT_DIR, filename);

    // Write the export
    await fs.writeFile(filepath, JSON.stringify(data, null, 2), 'utf-8');

    // Also maintain a "latest" symlink-like file
    const latestPath = path.join(EXPORT_DIR, 'tradeflow_v3_latest.json');
    await fs.writeFile(latestPath, JSON.stringify(data, null, 2), 'utf-8');

    // Clean up old exports (keep last 10)
    const files = await fs.readdir(EXPORT_DIR);
    const exports = files
      .filter(f => f.startsWith('tradeflow_v3_') && f !== 'tradeflow_v3_latest.json')
      .sort()
      .reverse();

    if (exports.length > 10) {
      for (const old of exports.slice(10)) {
        await fs.unlink(path.join(EXPORT_DIR, old)).catch(() => {});
      }
    }

    return NextResponse.json({
      success: true,
      filename,
      path: filepath,
      size: JSON.stringify(data).length,
    });
  } catch (error) {
    return NextResponse.json(
      { error: `Export failed: ${error instanceof Error ? error.message : 'Unknown error'}` },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    await fs.mkdir(EXPORT_DIR, { recursive: true });
    const files = await fs.readdir(EXPORT_DIR);
    const exports = files
      .filter(f => f.startsWith('tradeflow_v3_') && f.endsWith('.json'))
      .sort()
      .reverse();

    const details = await Promise.all(
      exports.slice(0, 10).map(async (f) => {
        const stat = await fs.stat(path.join(EXPORT_DIR, f));
        return {
          filename: f,
          size: stat.size,
          created: stat.mtime.toISOString(),
        };
      })
    );

    return NextResponse.json({ exports: details, directory: EXPORT_DIR });
  } catch {
    return NextResponse.json({ exports: [], directory: EXPORT_DIR });
  }
}
