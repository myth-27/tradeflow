export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';

// Sends SSLRequest to Railway's Postgres and reports the raw bytes received.
// This diagnoses what byte is coming back (should be 'S'=0x53 or 'N'=0x4E).
export async function GET() {
  const url = process.env.DATABASE_URL ?? '';
  if (!url) return NextResponse.json({ error: 'no DATABASE_URL' });

  let host = 'unknown', port = 5432;
  try {
    const p = new URL(url);
    host = p.hostname;
    port = parseInt(p.port) || 5432;
  } catch { /* ignore */ }

  // SSLRequest packet: 8 bytes, fixed magic number
  const SSL_REQUEST = Buffer.from([0x00, 0x00, 0x00, 0x08, 0x04, 0xD2, 0x16, 0x2F]);

  // Test 1: raw SSLRequest
  const sslResult = await new Promise<string>((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const net = require('net') as typeof import('net');
    const sock = new net.Socket();
    let responded = false;

    const timer = setTimeout(() => {
      if (!responded) { responded = true; sock.destroy(); resolve('timeout'); }
    }, 5000);

    sock.connect(port, host, () => {
      sock.write(SSL_REQUEST);
    });

    sock.once('data', (buf: Buffer) => {
      if (!responded) {
        responded = true;
        clearTimeout(timer);
        sock.destroy();
        resolve(`bytes=${buf.length} hex=${buf.toString('hex')} char=${buf.toString('utf8', 0, Math.min(buf.length, 8))}`);
      }
    });

    sock.on('error', (err: Error) => {
      if (!responded) { responded = true; clearTimeout(timer); resolve(`error: ${err.message}`); }
    });

    sock.on('close', () => {
      if (!responded) { responded = true; clearTimeout(timer); resolve('closed-before-data'); }
    });
  });

  // Test 2: raw Postgres StartupMessage (no SSL) — see if Postgres just accepts it
  const startupResult = await new Promise<string>((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const net = require('net') as typeof import('net');
    const sock = new net.Socket();
    let responded = false;

    const timer = setTimeout(() => {
      if (!responded) { responded = true; sock.destroy(); resolve('timeout'); }
    }, 5000);

    sock.connect(port, host, () => {
      // Postgres StartupMessage: length (4) + proto version 3.0 (4) + user=postgres + database=railway + \0
      const user = 'postgres';
      const db = 'railway';
      const msg = Buffer.concat([
        Buffer.alloc(4), // placeholder for length
        Buffer.from([0x00, 0x03, 0x00, 0x00]), // protocol 3.0
        Buffer.from('user\x00' + user + '\x00database\x00' + db + '\x00\x00'),
      ]);
      msg.writeUInt32BE(msg.length, 0); // fill in length
      sock.write(msg);
    });

    sock.once('data', (buf: Buffer) => {
      if (!responded) {
        responded = true;
        clearTimeout(timer);
        sock.destroy();
        resolve(`bytes=${buf.length} hex=${buf.slice(0, 20).toString('hex')} char=${JSON.stringify(buf.slice(0, 5).toString('utf8'))}`);
      }
    });

    sock.on('error', (err: Error) => {
      if (!responded) { responded = true; clearTimeout(timer); resolve(`error: ${err.message}`); }
    });

    sock.on('close', () => {
      if (!responded) { responded = true; clearTimeout(timer); resolve('closed-before-data'); }
    });
  });

  return NextResponse.json({ host, port, sslRequest: sslResult, startup: startupResult });
}
