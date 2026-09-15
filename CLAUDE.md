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

## Opening the book page: same tab, and the `armed` gate that makes back work

`openBookPage` uses `location.assign` — a **same-tab** navigation. It was `window.open` with a
new tab, which does not survive contact with a phone: the scan callback fires from an async
decode loop, which browsers don't treat as a user gesture, so iOS Safari showed a blocked-popup
warning and the reader had to tap a fallback card to get through. Same-tab navigation is never
popup-blocked, so the warning cannot occur. Don't reintroduce `window.open` here.

The cost is that reading the next book means pressing back, which creates the failure this
section is really about. On back the scanner reloads and the camera restarts; **if it is still
pointed at the book, it decodes again instantly and navigates away again** — the reader presses
back, gets bounced straight to the book page, and concludes the back button is broken.

`ScannerService.armed` is the fix: after the scanner starts, it reports nothing until it has
seen **one frame with no barcode in it**. That means the camera has to actually leave the book
before the next navigation, so returning always lands you on a stable scanner.

This was originally solved in `app.ts` by remembering the last barcode and ignoring re-scans of
the same code. **Don't go back to that** — it fails twice over:

- Many books carry a second barcode next to the ISBN (a `471…` internal/price code is common
  here). The wide scan region picks up whichever, so the two codes alternate and a
  remembered-code check never matches. The reader gets bounced anyway.
- It made a book impossible to rescan on purpose. The `armed` gate doesn't look at the code at
  all, so scanning the same book again works — just move the camera away and back.

Other behaviors that exist for a reason:

- The camera stops on `visibilitychange` (leaving it on drains battery and keeps the recording
  indicator lit) and restarts on return.
- `pageshow` with `persisted` restarts the scanner, because a bfcache-restored `<video>` has a
  dead stream. A page that has used `getUserMedia` often isn't bfcache-eligible, so the plain
  reload path in the constructor matters just as much.
- The last code is kept in `sessionStorage` purely to render the "last scanned" card after a
  return. It is **not** a duplicate-scan guard; see above.

Headless Chrome cannot verify any of this: the camera and wasm pipeline never advance far
enough under the virtual clock to produce a decode. What is testable, and worth redoing after
changes here, is replaying Y4M frames through the real decoder in Node and running the `armed`
state machine over the results — barcode-in-every-frame must never fire, blank-then-barcode
must fire exactly once.

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
