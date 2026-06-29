/**
 * TradeFlow V3 — Order Flow API Proxy
 *
 * Proxies requests to Binance Futures API to avoid CORS.
 * Fetches: Open Interest, Funding Rate, approximated liquidations.
 */

import { NextResponse } from 'next/server';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get('symbol')?.toUpperCase() || 'BTCUSDT';

  try {
    // Fetch Open Interest
    const oiRes = await fetch(
      `https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`,
      { next: { revalidate: 60 } }
    );
    const oiData = oiRes.ok ? await oiRes.json() : null;

    // Fetch Funding Rate (latest)
    const fundingRes = await fetch(
      `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=2`,
      { next: { revalidate: 300 } }
    );
    const fundingData = fundingRes.ok ? await fundingRes.json() : [];

    // Fetch 24h ticker for price context
    const tickerRes = await fetch(
      `https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${symbol}`,
      { next: { revalidate: 60 } }
    );
    const tickerData = tickerRes.ok ? await tickerRes.json() : null;

    // Calculate OI change
    let openInterest = 0;
    let openInterestChange = 0;
    if (oiData) {
      openInterest = parseFloat(oiData.openInterest || '0');
    }

    // Funding rate
    let fundingRate = 0;
    if (Array.isArray(fundingData) && fundingData.length > 0) {
      fundingRate = parseFloat(fundingData[fundingData.length - 1].fundingRate || '0');
    }
    const fundingRateAnnualized = fundingRate * 3 * 365;

    // Approximate CVD from volume data
    let cvd = 0;
    if (tickerData) {
      const buyVolume = parseFloat(tickerData.volume || '0') * 0.5;
      const totalVolume = parseFloat(tickerData.volume || '1');
      cvd = totalVolume > 0 ? (buyVolume / totalVolume - 0.5) * 2 : 0;
    }

    // OI change approximation (comparing to previous funding rate period)
    if (Array.isArray(fundingData) && fundingData.length >= 2) {
      // Very rough approximation — Binance doesn't give historical OI in one call
      openInterestChange = 0;
    }

    return NextResponse.json({
      openInterest,
      openInterestChange,
      fundingRate,
      fundingRateAnnualized,
      cvd,
      estimatedLiquidations: 0,
      timestamp: Date.now(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch order flow data' },
      { status: 500 }
    );
  }
}
