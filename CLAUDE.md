# 掃書 (BookScan)

Mobile-friendly static web app that does exactly one thing: scan a book's barcode with the
device camera and open that book's page on the 真的書店 website in a new tab. No backend, no
data storage, no build-time secrets — TypeScript bundled with esbuild, deployed as static
files to GitHub Pages on every push to `main` (`.github/workflows/deploy.yml`).

## Commands

```bash
npm install
npm run build   # esbuild bundle to dist/bundle.js + copy zxing_reader.wasm
npm run watch   # same, with --watch
npm run serve   # http-server on :8080
```

No test suite or linter is configured.

## Architecture

Four files, and only one of them is doing real work:

- `src/scanner.ts` — the whole point of the app. getUserMedia → crop the central scan region
  of each frame → decode with zxing-wasm. **Don't casually refactor this**; the cropping and
  the choice of zxing-wasm over JS decoders were both arrived at by testing against real
  photos and real iOS devices (see the comments in the file).
- `src/app.ts` — ~150 lines of glue: start the camera, on a decode open the book page.
- `src/utils.ts` — toast + modal helpers.
- `index.html` / `styles.css` — one screen.

There is no state. Nothing is persisted, nothing is sent anywhere.

## Key design decision: the app is a redirector, not a database

Earlier versions of this repo were a collection manager — books saved into named collections
in localStorage, CSV export, and opt-in sync of scanned ISBNs to a Google Sheet through an
Apps Script Web App. **All of that was deliberately removed.** The app's job is now: scan →
open the book's page on the website. If you find references to collections, `bookScan_*`
localStorage keys, CSV export, or Apps Script sync anywhere in this repo, they are stale docs,
not features to restore.

Consequences worth knowing:

- There is still **no book-metadata API call** — no Google Books, no OpenLibrary. There never
  needs to be one: the website's book page *is* the metadata. (This was already true before
  the rewrite; Google cut the keyless quota to zero and the lookup was removed in `45e73e1`.)
- The barcode is the only key. The URL is
  `https://trulybookstore.in-common.tw/books/book-<barcode>/` — no `index.html` needed, it
  returns 200 either way. Series members each have their own `book-` page, so series need no
  special handling. Not every barcode is an ISBN (the catalog contains EAN-13s like
  `4711488873708`), which is why `scanner.ts` accepts any 13-digit code, not just `978/979`.

## The app cannot know whether a book page exists

The website is hosted on **Netlify and sends no CORS headers**. A cross-origin `fetch` from
this app can't read the response status, and `mode: 'no-cors'` yields an opaque response where
200 and 404 are indistinguishable. So there is no way to check from the browser whether a
scanned barcode has a page.

The deliberate answer is: **don't check — just open the URL, and let the website's own 404
page explain the miss.** `truly-bookstore/404.html` is styled to match the site and says "這本
書還不在我們的書單裡" with a link to the book list. Netlify serves it for any missing path.

Two things follow from this, and both have bitten:

- **`404.html` must use absolute asset paths** (`/css/style.css`, `/img/logo.png`). Netlify
  serves that one file for *any* missing path, so a relative `css/style.css` resolves against
  e.g. `/books/book-9999999999999/` and 404s in turn.
- A build-time manifest of valid ISBNs was considered and rejected — it would go stale between
  this repo's deploys and the website's monthly regeneration cron, for a check the 404 page
  already handles.

## Opening the book page: an overlay, because navigating away kept breaking

The book page is shown **in an iframe overlay on the scanner page**. Nothing navigates. Two
earlier designs were tried on real phones and both failed, so don't "simplify" back to either:

- **`window.open` in a new tab.** The scan callback comes from an async decode loop, which
  browsers don't count as a user gesture, so iOS Safari blocked it as a popup and showed a
  warning; the reader had to tap a fallback link to get through.
- **`location.assign` in the same tab.** No popup warning, but WebKit treats a gesture-less
  navigation shortly after load as a *client redirect* and **replaces** the current history
  entry instead of pushing one. The scanner's entry got eaten, so back skipped past it to
  whatever preceded the app. A camera-decoded barcode is never a gesture, so this path always
  qualifies. A defensive `history.pushState` before navigating was tried; the overlay replaced
  it before it could be judged on a phone.

The overlay has neither failure mode, and it's faster: the camera never stops, so closing puts
you straight back to scanning. Framing is safe to rely on — the site sends no
`X-Frame-Options` and no CSP `frame-ancestors`, and neither the book pages nor `js/script.js`
contain frame-busting code (re-check if that ever changes).

How it holds together:

- **✕ closes the overlay directly.** It used to call `history.back()` and let the popstate
  handler do the closing, so both routes shared a path — but the popstate didn't arrive on a
  real phone and only the iframe got cleared, leaving the card on screen. Closing happens once
  per book; it can't depend on an event turning up.
- Opening pushes a history entry so the phone's back gesture **closes the overlay** instead of
  leaving the app. Closing does *not* reclaim that entry — trying to (a `history.back()` in
  the close path) raced with the next `pushState` and broke the back gesture entirely. Instead
  `pushedHistory` makes sure at most one entry is outstanding, so they never pile up. Only
  popstate clears the flag, because only then has the browser actually consumed the entry.
- **The iframe is created and removed, never re-`src`-ed.** Every iframe navigation adds a
  joint-session-history entry — one to open, another to reset to `about:blank` — so back walked
  those instead of closing the overlay. Removing the element drops its history with it, and a
  fresh iframe's first load adds nothing, which keeps the only entry the one we pushed
  ourselves. It also stops the embedded page and frees its memory.
- Tapping the scrim closes too, matching the site's other modals; clicks inside the card don't.
- The overlay pauses decoding but **keeps the camera stream** (`pauseScanning` /
  `resumeScanning`). Stopping the camera outright would mean renegotiating `getUserMedia` on
  every close — half a second of dead time before the next book can be scanned.
- The "last scanned" link goes through the overlay as well. Letting it navigate would drag the
  history problem back in through a side door.

### `ScannerService.armed`

The scanner reports nothing until it has seen **one frame containing no barcode**. Otherwise,
resuming with the camera still pointed at the book you just scanned reopens it immediately.

Don't replace this with "remember the last barcode and skip re-scans of the same code", which
is what it used to be. It failed twice over: many books here carry a second barcode beside the
ISBN (`471…` internal codes), and the wide scan region catches whichever, so the codes alternate
and the check never matches; and it made rescanning a book on purpose impossible. `armed`
ignores the code entirely — move the camera away and back and anything scans again.

### Concurrent starts will break `armed` if you let them

`isScanning` only becomes true after awaiting `getUserMedia` and `video.play()`, so two callers
arriving during those awaits both saw it false and both started a camera. That leaked streams,
and — the part that actually bit — ran **two scan loops sharing one `armed` flag**, where one
sets it on a clear frame and the other consumes it on the next, so the gate silently stopped
holding. `pageshow` and `visibilitychange` both fire on return, which is exactly that case.

`isStarting` (set synchronously) blocks re-entry, and `startGeneration` retires superseded scan
loops and discards a stream acquired after a stop. Starting while already running returns
quietly rather than throwing — the old throw surfaced as a camera error with a "start camera"
button on a scanner that was working fine.

### What can and cannot be tested here

Headless Chrome never advances far enough under its virtual clock to decode a barcode, load the
wasm, or fire the overlay iframe's `load` event, so end-to-end scanning can't be verified
locally. What works, and is worth redoing after changes:

- Replay Y4M frames through the real decoder in Node and run the `armed` state machine over the
  results — barcode in every frame must never fire, blank-then-barcode must fire exactly once.
- Stub `getUserMedia` with `canvas.captureStream()` and a delay, then fire the return events
  during that window and count cameras opened — it must stay at one.
- Drive the overlay through manual entry and assert all four behaviours: ✕ closes it
  synchronously, the back gesture closes it, the scrim closes it, a click inside the card does
  not — and that `location` never changes and the history depth stays at +1 across repeated
  open/close cycles. Point the iframe at a local page while testing; four real remote loads
  hang headless Chrome.

## Key design decision: the UI follows the truly-bookstore website

The interface deliberately mirrors the 真的書店 website (`../truly-bookstore`), whose design
system is documented in that repo's `DESIGN_GUIDE.md` — that file is the source of truth for
colors, type, radii, and motion, not this app. What's mirrored:

- The 5 custom colors from the site's `tailwind.config` (`js/script.js`): `primary #4A403A`,
  `secondary #6B5E55`, `accent #8C7B6C`, `light #F9F7F2`, `deco #D4C5B0`, plus the background
  scale `#F9F7F2 → #F2EFE9 → #FFFFFF → #4A403A → #3E3530` and the `#E5E0D8` border color.
  They live as CSS custom properties at the top of `styles.css`. **Don't invent new colors.**
- Noto Serif TC for headings, Noto Sans TC for body/UI (loaded from Google Fonts).
- **Buttons are always `border-radius: 9999px`, cards/inputs always `2px`** — this is a hard
  rule on the site (`rounded-full` vs `rounded-sm`), not a preference.
- The modal shell: `rgba(0,0,0,.8)` + `backdrop-filter: blur(12px)` scrim, `--light` card,
  `scale(.95) → scale(1)`, and **all modal transitions are 300ms** (the site reserves 500ms
  for photo hovers only).
- Eyebrow labels (`.eyebrow`): uppercase English, `letter-spacing: .25em`, `--accent`.
- Only the `sm/md/lg` breakpoints.

`styles.css` is hand-written rather than Tailwind CDN like the site. That's deliberate: this
is a single-page app whose scanner view can't tolerate the flash-of-unstyled-content that
`DESIGN_GUIDE.md` itself records Tailwind CDN causing. The values are copied, the delivery
mechanism isn't. (`truly-bookstore/404.html` *does* use the CDN, because it lives in that repo
and matches its siblings.)

UI copy is Traditional Chinese, matching the site.

**If the website's design system changes, `DESIGN_GUIDE.md` is what to re-read** — the CSS
comments in `styles.css` cite the specific sections each rule comes from.
