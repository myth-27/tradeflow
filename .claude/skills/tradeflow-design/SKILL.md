---
name: tradeflow-design
description: Professional trading-terminal UI/UX design system — color tokens, typography, page/panel layout grid, top bar, signal strip and pattern cards, AI analysis panel, chart container styling, and micro-interactions for a Bloomberg-Terminal-style dark UI. Load this skill whenever touching any UI file — page.tsx, globals.css, tailwind.config, or any component dealing with layout, colors, typography, spacing, signal cards, or panel design.
---

## Role

You are a senior product designer who specializes in professional trading terminals. You have studied Bloomberg Terminal, TradingView, Bookmap, and Thinkorswim. Your designs feel premium, information-dense but scannable, and immediately trustworthy. You never produce bland, gray, lifeless UIs.

The aesthetic goal: a Bloomberg Terminal that a designer built. Dense but beautiful. Data-heavy but readable. Dark but not depressing. Every color communicates meaning.

---

## Chain: Color System

### Token Definitions
```
BACKGROUNDS (darkest to lightest):
  --bg-void:    #050505  ← absolute darkest, outer background
  --bg-base:    #0a0a0a  ← page background
  --bg-card:    #111111  ← card/panel background
  --bg-elevated:#171717  ← hover states, slightly elevated
  --bg-subtle:  #1e1e1e  ← input backgrounds, subtle areas

BORDERS:
  --border-dim:   #1a1a1a  ← very subtle, structure only
  --border-base:  #222222  ← standard borders
  --border-focus: #333333  ← hover/focus borders

TEXT:
  --text-primary:   #f0f0f0  ← main content (NOT pure white)
  --text-secondary: #888888  ← labels, metadata
  --text-muted:     #444444  ← disabled, placeholders
  --text-accent:    #cccccc  ← slightly brighter secondary

SEMANTIC COLORS (MUST BE CONSISTENT):
  --green:       #22c55e  ← LONG, profit, up, buy, bullish
  --green-dim:   rgba(34,197,94,0.15)  ← green zone fills
  --green-glow:  rgba(34,197,94,0.08)  ← very subtle bg
  
  --red:         #ef4444  ← SHORT, loss, down, sell, bearish
  --red-dim:     rgba(239,68,68,0.15)  ← red zone fills
  --red-glow:    rgba(239,68,68,0.08)  ← very subtle bg
  
  --amber:       #f59e0b  ← WAIT, warning, neutral, trendlines
  --amber-dim:   rgba(245,158,11,0.15)
  
  --blue:        #3b82f6  ← support levels, info, EMA20
  --purple:      #8b5cf6  ← target prices, EMA indicators
  --teal:        #14b8a6  ← secondary accent, volume

RULE: Never use a semantic color for decoration.
  Green = always positive/bullish
  Red = always negative/bearish
  Amber = always caution/neutral
  Blue = always support/info
```

### CSS Variables Setup
```
In globals.css:
  :root {
    --bg-void: #050505;
    --bg-base: #0a0a0a;
    --bg-card: #111111;
    --bg-elevated: #171717;
    --bg-subtle: #1e1e1e;
    --border-dim: #1a1a1a;
    --border-base: #222222;
    --border-focus: #333333;
    --text-primary: #f0f0f0;
    --text-secondary: #888888;
    --text-muted: #444444;
    --text-accent: #cccccc;
    --green: #22c55e;
    --red: #ef4444;
    --amber: #f59e0b;
    --blue: #3b82f6;
    --purple: #8b5cf6;
  }
```

---

## Chain: Typography

### Type Scale
```
FONT: Use system monospace for prices and numbers
      Use sans-serif for labels and text

PRICE DISPLAYS (numbers that move):
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace
  font-feature-settings: 'tnum' 1  ← tabular numbers, no layout shift
  
  Large price (hero): font-size: 28px, font-weight: 600
  Mid price: font-size: 18px, font-weight: 500
  Small price: font-size: 13px, font-weight: 400

LABELS:
  font-family: system-ui, -apple-system, sans-serif
  Section labels: 10px, UPPERCASE, letter-spacing: 0.08em, color: var(--text-muted)
  Field labels: 11px, color: var(--text-secondary)
  Body text: 13px, color: var(--text-primary), line-height: 1.5

SIGNAL VERDICT:
  font-size: 22px, font-weight: 700, letter-spacing: 0.04em
  LONG → color: var(--green)
  SHORT → color: var(--red)  
  WAIT → color: var(--amber)
```

---

## Chain: Layout

### Page Structure
```
FULL PAGE LAYOUT (no scroll):
  height: 100vh
  display: grid
  grid-template-rows: 48px 1fr 28px
    Row 1: TopBar (48px fixed)
    Row 2: MainContent (fills remaining)
    Row 3: SignalStrip (28px fixed, new feature)

MAIN CONTENT:
  display: grid
  grid-template-columns: 240px 1fr 280px
    Col 1: LeftPanel (fixed 240px)
    Col 2: CenterContent (flex-1)
    Col 3: RightPanel (fixed 280px)
  
CENTER CONTENT:
  display: grid
  grid-template-rows: 1fr 120px
    Top: Chart (fills space)
    Bottom: SignalBoxes strip (120px) ← NEW FEATURE

OVERFLOW: hidden on all panels
  Each panel scrolls independently with overflow-y: auto
```

### Top Bar
```
TOPBAR DESIGN:
  height: 48px
  background: var(--bg-card)
  border-bottom: 1px solid var(--border-dim)
  display: flex, align-items: center
  padding: 0 16px
  gap: 24px

LEFT: Logo
  "TradeFlow" — font-size: 15px, font-weight: 600
  color: var(--text-primary)
  Add small chart icon (svg) before text in --green color

CENTER: Symbol tabs
  Each tab: padding 6px 14px, border-radius: 6px
  Inactive: bg transparent, color: var(--text-secondary)
  Active: bg: var(--bg-elevated), color: white, 
          border: 1px solid var(--border-focus)
  Below symbol name: show current price in 10px
    color: green/red based on 24h change

MODE TOGGLE (next to symbols):
  Two pills: [Intraday · 5m] [Swing · 4h]
  font-size: 11px, padding: 4px 10px
  Active: bg var(--bg-elevated), border 1px var(--border-focus)

RIGHT:
  Price: 22px monospace, colored by direction
  Change %: 13px, green/red
  Connection dot: 8px circle, green pulse animation
```

---

## Chain: Signal Strip (NEW — Below Chart)

### Signal Box Component
```
THIS IS THE KEY NEW FEATURE.
Below the chart, show 3-4 horizontal signal boxes.
These replace the bottom ticker bar.

CONTAINER:
  height: 120px
  background: var(--bg-card)
  border-top: 1px solid var(--border-dim)
  display: flex
  gap: 1px  ← 1px gap creates divider effect
  padding: 0

EACH SIGNAL BOX (flex: 1):
  background: var(--bg-card)
  border-right: 1px solid var(--border-dim)
  padding: 12px 16px
  display: flex
  flex-direction: column
  gap: 4px
  position: relative

BOX TYPES:
  1. CURRENT SIGNAL BOX — most prominent
  2. LAST SIGNAL BOX — previous signal with outcome
  3. INDICATORS BOX — live RSI/MACD/Vol
  4. ENTRY DETAILS BOX — entry/stop/target layout

CURRENT SIGNAL BOX DESIGN:
  Top row:
    LEFT: Signal badge — "LONG" or "SHORT" or "WAIT"
      LONG: bg: rgba(34,197,94,0.15), color: #22c55e,
            border: 1px solid rgba(34,197,94,0.3)
            font: 11px, 700, letter-spacing: 0.06em
            padding: 2px 8px, border-radius: 4px
    RIGHT: Pattern name — "Bull Flag" — 11px, color: var(--text-secondary)
  
  Price row (if LONG/SHORT):
    Three columns with dividers:
    
    ENTRY column:
      Label: "ENTRY" — 9px, muted, uppercase
      Value: "$65,920" — 16px, monospace, white
    
    TARGET column:
      Label: "TARGET" — 9px, muted, uppercase
      Value: "$67,340" — 16px, monospace, green
      Sub: "+2.1%" — 11px, green
    
    STOP column:
      Label: "STOP LOSS" — 9px, muted, uppercase
      Value: "$65,200" — 16px, monospace, red
      Sub: "-1.1%" — 11px, red
  
  Bottom row:
    "R:R  1 : 3.4" — amber color, 13px, monospace
    Confidence bar: thin 2px bar, green fill, percentage
    "Next candle: 3:42" countdown — 11px, muted

LEFT BORDER ACCENT on current signal box:
  LONG → border-left: 3px solid var(--green)
  SHORT → border-left: 3px solid var(--red)
  WAIT → border-left: 3px solid var(--amber)
```

### Indicators Box
```
INDICATORS BOX DESIGN:
  header: "INDICATORS" — 9px, uppercase, muted
  
  Grid 2x3 of indicators:
  [RSI  57.2] [MACD  ↑]
  [Vol  1.4x] [ATR  $142]
  [EMA  Up ↗] [BB  Mid]

  Each indicator cell:
    label: 9px, muted
    value: 13px, monospace, colored
    
  RSI coloring:
    < 30: green (oversold)
    30-45: light green
    45-55: white (neutral)
    55-70: light red
    > 70: red (overbought)
```

---

## Chain: Left Panel — Pattern Cards

### Signal Card Design
```
LEFT PANEL:
  width: 240px
  background: var(--bg-card)
  border-right: 1px solid var(--border-dim)
  display: flex
  flex-direction: column
  overflow-y: auto

SECTION HEADER:
  "PATTERNS" — 9px, uppercase, letter-spacing: 0.1em
  color: var(--text-muted)
  padding: 12px 14px 6px
  border-bottom: 1px solid var(--border-dim)

PATTERN CARD:
  margin: 8px
  padding: 10px 12px
  background: var(--bg-elevated)
  border-radius: 6px
  border: 1px solid var(--border-dim)
  border-left: 3px solid [signal color]  ← colored accent

  TOP ROW:
    Pattern name: 13px, font-weight 500, white
    Badge: BULLISH/BEARISH/WAIT pill
      BULLISH: bg rgba(34,197,94,0.15), color green, border green/30
      BEARISH: bg rgba(239,68,68,0.15), color red, border red/30
      WAIT: bg rgba(245,158,11,0.15), color amber

  CONFIDENCE ROW:
    "87% confidence" — 10px, text-secondary
    Thin progress bar (3px height):
      bg: var(--bg-subtle)
      fill: green if > 70, amber if 50-70, red if < 50
      width: confidence%
      border-radius: 2px

  LEVELS GRID (if not WAIT):
    2-column grid:
    Support:    $65,360  (blue)
    Resistance: $66,210  (red)
    Target:     $64,512  (purple)
    Stop Loss:  $66,280  (red, smaller)
    R:R:        1 : 3.1  (amber, slightly larger)

  WAIT STATE:
    Center text: "⏳ No Clear Setup"
    Sub: conflicting pattern names in muted
    Countdown: "Next candle in 3:42"
```

### Indicators Section
```
SECTION after patterns:
  header: "INDICATORS" — same style as PATTERNS header

  Each row:
    padding: 6px 14px
    display: flex, justify-content: space-between
    
    Label: 11px, var(--text-secondary)
    Value: 11px, monospace, colored
    
  Add thin separator between rows:
    border-bottom: 1px solid var(--border-dim)
    opacity: 0.5

SIGNAL HISTORY at bottom:
  header: "RECENT SIGNALS"
  
  Each row (compact):
    "14:25  Bull Flag  LONG  ✓" — 11px
    background: rgba(34,197,94,0.05) for wins
    background: rgba(239,68,68,0.05) for losses
    
  Outcome icon:
    ✓ → color: green
    ✗ → color: red
    · → color: amber (pending)

"Analyze with GPT-4o" BUTTON at bottom:
  width: calc(100% - 16px), margin: 8px
  padding: 10px
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)
  border: 1px solid #2a3a5e
  border-radius: 6px
  color: #60a5fa
  font-size: 12px, font-weight: 500
  cursor: pointer
  
  hover: border-color: #3b82f6, box-shadow: 0 0 12px rgba(59,130,246,0.15)
```

---

## Chain: Right Panel — AI Analysis

### Panel Design
```
RIGHT PANEL:
  width: 280px
  background: var(--bg-card)
  border-left: 1px solid var(--border-dim)
  display: flex, flex-direction: column

HEADER:
  "GPT-4O ANALYSIS" — 9px, uppercase, muted
  Auto toggle on right: small pill toggle
  padding: 12px 14px
  border-bottom: 1px solid var(--border-dim)

EMPTY STATE (before analysis):
  Center of panel
  Icon: brain or chart icon, 32px, muted
  Text: "Ready to analyze" or "Waiting for signal..."
  Sub: "Click Analyze when pattern detected"
  
  Analyze button:
    Full width, margin: 16px
    bg: var(--blue), color: white
    font-size: 13px, font-weight: 500
    padding: 10px
    border-radius: 6px
    hover: bg: #2563eb

RESULTS STATE:
  VERDICT (large):
    padding: 14px
    border-bottom: 1px solid var(--border-dim)
    
    "GPT-4O SAYS" — 9px, uppercase, muted
    "STRONG BUY" — 20px, font-weight 700, colored
    
    Confidence bar:
      height: 4px
      bg: var(--bg-subtle)
      fill: var(--green/red/amber)
      animated: width transitions from 0% on mount
    
    "85% confidence" — 11px, muted

  ANALYSIS TEXT:
    padding: 12px 14px
    font-size: 12px, line-height: 1.6
    color: var(--text-primary)
    
    Streaming: show typing cursor (|) that blinks
    As text streams in, it appears character by character
    
    border-bottom: 1px solid var(--border-dim)

  ENTRY STRATEGY:
    padding: 10px 14px
    "ENTRY STRATEGY" — 9px, uppercase, muted label
    Text: 12px, line-height: 1.5

  RISK NOTE:
    padding: 10px 14px
    background: rgba(245,158,11,0.05)
    border-left: 2px solid var(--amber)
    "RISK" — 9px, uppercase, amber label
    Text: 11px, amber-tinted

  TIMESTAMP:
    "Analyzed at 14:23:07" — 10px, muted
    padding: 8px 14px
    Refresh button: "↺ Refresh" — 10px, right-aligned, muted
```

---

## Chain: Chart Area Styling

### Chart Container
```
CHART CONTAINER:
  background: #0a0a0a  ← matches chart background
  position: relative
  
  PNG EXPORT BUTTON:
    position: absolute, top: 8px, right: 8px, z-index: 10
    bg: rgba(0,0,0,0.6), border: 1px solid #333
    color: var(--text-secondary), font-size: 11px
    padding: 4px 10px, border-radius: 4px
    hover: bg rgba(0,0,0,0.8), color white
    backdrop-filter: blur(4px)

  MODE INDICATOR:
    position: absolute, top: 8px, left: 8px, z-index: 10
    "Intraday · 5m" or "Swing · 4h"
    bg: rgba(0,0,0,0.6), border: 1px solid #333
    color: var(--amber), font-size: 11px
    padding: 4px 10px, border-radius: 4px
```

---

## Chain: Micro-interactions

### Animations
```
PRICE FLASH (when price updates):
  On price increase: flash green then fade back
    @keyframes flashGreen {
      0% { color: var(--text-primary); }
      20% { color: var(--green); text-shadow: 0 0 8px rgba(34,197,94,0.5); }
      100% { color: var(--text-primary); }
    }
  On price decrease: flash red then fade back
  Duration: 600ms, timing: ease-out

SIGNAL CARD UPDATE (new signal fires):
  Border pulses once:
    @keyframes borderPulse {
      0% { border-left-color: transparent; }
      50% { border-left-color: var(--green); box-shadow: -2px 0 8px rgba(34,197,94,0.4); }
      100% { border-left-color: var(--green); }
    }
  Duration: 800ms

CONNECTION DOT:
  @keyframes pulse {
    0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(34,197,94,0.4); }
    50% { opacity: 0.8; box-shadow: 0 0 0 4px rgba(34,197,94,0); }
  }
  Duration: 2s, infinite

CONFIDENCE BAR FILL:
  transition: width 800ms ease-out
  On mount: width starts at 0%, animates to final value

STREAMING TEXT CURSOR:
  After analysis text, add:
    <span class="cursor">|</span>
    @keyframes blink { 50% { opacity: 0; } }
    animation: blink 1s infinite
  Remove cursor when streaming complete
```

---

## Chain: Common Design Bugs

```
BUG: Everything looks gray and lifeless
FIX: Check semantic colors are being USED
     Signal cards must have colored left borders
     Prices must use monospace font
     Labels must be tiny and muted (9-10px)
     Values must be larger and white (13-16px)

BUG: Text hierarchy is flat
FIX: Labels: 9-10px, muted, uppercase, letter-spacing
     Values: 13-16px, primary, monospace for numbers
     Headers: 9px, muted, uppercase, wider letter-spacing

BUG: Panels feel cramped
FIX: Section headers need 12px top padding
     Cards need 8px gap between them
     Values need 4px gap from labels
     Use 14px horizontal padding in panels

BUG: Colors don't mean anything
FIX: Audit every color usage:
     Is every green thing positive/bullish? Yes → ok
     Is every red thing negative/bearish? Yes → ok
     Are amber things warnings/neutral? Yes → ok
     Otherwise → fix to match semantic system

BUG: Numbers shift layout when they change
FIX: font-feature-settings: 'tnum' on all price displays
     min-width on price containers
     text-align: right for price columns

BUG: Chart and panels feel disconnected
FIX: All backgrounds: chart #0a0a0a, panels #111111
     This 1-stop difference creates subtle depth
     Borders between elements: #1a1a1a (very subtle)
     Don't use white or bright borders

BUG: Signal boxes below chart look like an afterthought
FIX: Signal strip must have:
     Same border-top as panel borders
     Left-border accent matching signal type
     Monospace font for all prices
     Row dividers as 1px lines not gaps
```
