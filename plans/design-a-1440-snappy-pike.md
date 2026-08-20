# Plan: FirstFrame — Retro Pixel Desktop App

## Context
Build a fully designed 1440×900 desktop application mockup called **FirstFrame** — a retro pixel-art tool for extracting the first frame from uploaded videos. The app shows a loaded state with 3 sample files processed.

## Fonts
Add Google Fonts imports to `src/index.css` (before all other CSS):
- **Press Start 2P** — pixel display font for titles, badges, status tags
- **JetBrains Mono** — mono for filenames, queue labels, resolution metadata
- **Inter** — clean body for button text, small UI copy

## Palette / Tokens (in `src/index.css` via Tailwind v4 `@theme`)
```
--navy:       #0d1b2a   (page background)
--cobalt:     #1a4a8a   (outer window frame)
--cobalt-mid: #1e5aaa   (frame highlights)
--cyan-panel: #1a3a5c   (panel bg)
--cyan-border:#2a7fc1   (panel borders)
--orange:     #ff6b1a   (primary CTA buttons)
--orange-lt:  #ff8c42   (button hover)
--coral:      #e84855   (warning/error badges)
--mint:       #3dd68c   (success badges)
--cream:      #f0e6cc   (text on dark panels)
--grid-line:  rgba(42,127,193,0.15)
```

## File to modify
`src/App.tsx` — full replacement with the complete FirstFrame UI.

`src/index.css` — add Google Fonts `@import` lines at top, then Tailwind v4 `@theme` block with custom tokens.

## Layout Structure (all in one component, no router needed)

```
┌─────────────────────────────────────────────────────────┐  ← cobalt outer frame (8px border)
│  TOP BAR: "FIRSTFRAME // FRAME LAB" badge + mascot icon  │
├──────┬──────────────────────────────┬────────────────────┤
│ LEFT │     CENTER CAPTURE BAY       │  RIGHT CLIP QUEUE  │
│ TOOL │  dashed drop zone            │  "CLIP QUEUE 03/10"│
│ BAR  │  "DROP UP TO 10 VIDEOS"      │  3 video rows      │
│      │  [CHOOSE VIDEOS] btn         │  (thumb + status)  │
│      │  corner brackets + rulers    │                    │
├──────┴──────────────────────────────┴────────────────────┤
│  EXTRACTED FRAMES: 3 preview cards (thumb + SAVE PNG)    │
├──────────────────────────────────────────────────────────┤
│  STATUS BAR: "3 FRAMES READY" + [SAVE ALL PNGs] button   │
└──────────────────────────────────────────────────────────┘
```

## Component breakdown (all inline in App.tsx)

1. **`<AppShell>`** — fixed 1440×900 centered canvas, navy bg, 8px cobalt border with pixel bevel effect (box-shadow layers)
2. **`<TopBar>`** — film-reel SVG mascot, "FIRSTFRAME // FRAME LAB" in Press Start 2P, pixel-styled decorative corners
3. **`<LeftToolbar>`** — 3 icon buttons (Upload/Frames/Settings) with pixel border style, cobalt bg, orange active state
4. **`<CaptureBay>`** — large dark panel with:
   - Scanner grid overlay (CSS repeating-linear-gradient)
   - Dashed upload zone with corner bracket decorations
   - Press Start 2P drop copy
   - Orange "CHOOSE VIDEOS" button (beveled pixel style)
   - Pixel ruler details along edges
5. **`<ClipQueue>`** — right panel with:
   - Header "CLIP QUEUE — 03 / 10"
   - 3 rows: colored thumbnail placeholder, JetBrains Mono filename, status badge
   - Statuses: FRAME FOUND (mint), EXTRACTING (orange), READY (cyan)
   - × remove icon per row
6. **`<ExtractedFrames>`** — bottom grid of 3 large preview cards:
   - Colorful thumbnail placeholder (gradient simulating a video frame)
   - Filename + resolution in JetBrains Mono
   - Orange "SAVE PNG" pixel button
7. **`<StatusBar>`** — full-width bottom bar: mint "3 FRAMES READY" badge, "CHOOSE A FOLDER TO SAVE" copy, large orange "SAVE ALL PNGs" button, privacy badge "LOCAL ONLY — YOUR VIDEOS STAY ON YOUR COMPUTER."

## Visual details
- Outer frame: 8px cobalt border + multi-layer box-shadow for pixel bevel
- Beveled pixel buttons: use border-top/left lighter, border-bottom/right darker (classic OS button)
- Corner brackets: 4 SVG `<path>` elements at drop-zone corners
- Ruler marks: repeating CSS gradients along top/left edges of capture bay
- Status badges: `font-family: 'Press Start 2P'`, uppercase, 2px border, no border-radius
- All borders: square (border-radius: 0) for the pixel-art feel, except thumbnail images (2px)
- Pixel mascot: hand-drawn inline SVG film reel (no external assets)
- Sample thumbnails: CSS gradient blocks simulating cinematic stills (warm orange/teal/purple gradients)

## Verification
1. App renders at 1440×900 in the Figma Make preview panel
2. All three sections visible without scrolling
3. Press Start 2P font loaded (check Network tab or visual check)
4. No TypeScript errors, clean Vite HMR
