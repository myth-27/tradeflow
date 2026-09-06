export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';

export async function GET() {
  const url = process.env.DATABASE_URL ?? '';
  if (!url) return NextResponse.json({ error: 'no DATABASE_URL' });

  let host = 'unknown', port = 5432;
  try {
    const p = new URL(url);
    host = p.hostname;
    port = parseInt(p.port) || 5432;
  } catch { /* ignore */ }

  const SSL_REQUEST = Buffer.from([0x00, 0x00, 0x00, 0x08, 0x04, 0xD2, 0x16, 0x2F]);

  const sslResult = await new Promise<string>((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const net = require('net') as typeof import('net');
    const sock = new net.Socket();
    let responded = false;

    const timer = setTimeout(() => {
      if (!responded) { responded = true; sock.destroy(); resolve('timeout'); }
    }, 5000);

    sock.connect(port, host, () => { sock.write(SSL_REQUEST); });

    sock.once('data', (buf: Buffer) => {
      if (!responded) {
        responded = true; clearTimeout(timer); sock.destroy();
        resolve(`bytes=${buf.length} hex=${buf.toString('hex')} first-byte=0x${buf[0].toString(16).padStart(2,'0')} char=${JSON.stringify(String.fromCharCode(buf[0]))}`);
      }
    });

    sock.on('error', (err: Error) => {
      if (!responded) { responded = true; clearTimeout(timer); resolve(`error: ${err.message}`); }
    });

    sock.on('close', () => {
      if (!responded) { responded = true; clearTimeout(timer); resolve('closed-before-data'); }
    });
  });

  return NextResponse.json({ host, port, sslRequest: sslResult });
}
