# Privacy policy — Tour Navigator

_Last updated: 6 September 2026_

Tour Navigator is a browser extension that draws a cycling stage's elevation
profile over a video player's navigation bar. This policy describes everything
it stores and everything it sends.

## What stays in your browser

Using `chrome.storage.local`, on your machine only:

- **Your calibration readings** — the "km to go" figures you type in and the
  corresponding positions in the recording, so the profile is aligned the next
  time you open it.
- **Moments you flag** with the star button, so you can find them again.
- **Which stage you selected** from the dropdown, if the extension could not
  work it out on its own.
- **When you first installed it, and your license key once one verifies** —
  used only to decide whether the free trial is still active. See
  *Licensing* below.

Nothing here is synced to a Google account, and nothing is transmitted unless
you enter a reading (see below), or a license key once the trial ends.

## What is sent, and when

Entering a calibration reading submits that calibration so other viewers of the
**same recording** inherit it. Nothing else you do in the browser triggers a
request. A submission contains:

| field | example |
|---|---|
| stage number and date | 20, 2026-07-25 |
| which race, for a stage number that exists in more than one (e.g. the Vuelta) | `vuelta` |
| the site's hostname | `www.peacocktv.com` |
| the recording's length in seconds | 21519.4 |
| your km-to-go readings and their positions in the recording | 60 km at 4500s |
| the broadcast's own displayed start time, if the player exposes one | — |
| ad-break positions detected in the player's own scrub bar | — |
| positions of any moments you flagged with the star button | 4200s |
| timestamps and the extension's version number | — |

It does **not** contain your name, email, account, IP address, device
identifiers, browsing history, or anything about pages other than the one you
calibrated.

## Viewing measurement

While a stage is open, the extension also records **how the recording was
watched**, and sends a summary when you close the tab:

- **Coverage** — how many seconds were spent on each kilometre of the route.
- **Navigation** — each skip or rewind, with the kilometre jumped from and to.

These are grouped under a random session identifier that is generated fresh
each time and is not linked to you, an account, or any previous session. They
are used to understand which parts of a stage people watch and how they move
around a recording.

This is measurement of the video, not of you: it records positions within one
recording and nothing about other tabs, sites, or activity. It runs
automatically while the extension is active. If you would rather it did not
run, remove or disable the extension.

Session data is sent to a **private** repository, separate from the public
calibration store below, and is not published.

Flagged moments are submitted as bare positions in the recording, with no note
or label attached. They are collected so the parts of a stage people mark can
be studied, and are **never shown to anyone else** — the extension only ever
displays the moments flagged in your own browser.

## Licensing

The extension is free to use for a limited trial, after which continuing to
use it requires a one-time $5 payment. Payment is handled entirely by
**Stripe** — this project never sees your card details, name, or email at
all; that information stays with Stripe.

Once you pay, Stripe hands you a license key. Entering it sends **only that
key** to the same collector Worker described above, which checks it against
a list of valid keys and reports back yes or no. Your IP address reaches the
Worker for this the same way it does for a calibration submission (used
briefly to rate-limit repeated attempts, never stored). Nothing about who you
are is attached to a key at any point after Stripe's own checkout — the
Worker only ever knows "this specific string is or isn't valid," never who
holds it.

## Where it goes

Submissions pass through a Cloudflare Worker, which writes them to a **public**
file in this repository: `extension/data/calibrations.json`. Two consequences
worth stating plainly:

- Anyone can read it.
- Because it is stored in git, an entry remains in the repository's history
  even after it is removed from the current file.

Your IP address reaches the Worker, as it does any web server. It is used in
memory to limit how often one source can submit, and is not written to the
file or retained.

## What the extension does not do

- It does not sell or transfer your data to third parties.
- It does not publish session viewing data; that store is private.
- It does not use your data for advertising, profiling, or creditworthiness.
- It does not read, capture, download or modify any video or stream content.
  It reads the player's current position and sets it when you click to seek.
- It loads no remote code. Every script is bundled in the extension package.

## Removing your data

Reset in the panel clears that recording's readings from your browser. To have
a submitted calibration removed from the public file, open an issue at
https://github.com/elliebaker3/tour-scraper/issues and say which recording it
relates to.

## Contact

Questions or removal requests: https://github.com/elliebaker3/tour-scraper/issues
