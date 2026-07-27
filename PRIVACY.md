# Privacy policy — Tour Navigator

_Last updated: 26 July 2026_

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

Nothing here is synced to a Google account, and nothing is transmitted unless
you enter a reading (see below).

## What is sent, and when

Entering a calibration reading submits that calibration so other viewers of the
**same recording** inherit it. Nothing else you do in the browser triggers a
request — the extension does not track what you watch, and records nothing
unless you press a button. A submission contains:

| field | example |
|---|---|
| stage number and date | 20, 2026-07-25 |
| the site's hostname | `www.peacocktv.com` |
| the recording's length in seconds | 21519.4 |
| your km-to-go readings and their positions in the recording | 60 km at 4500s |
| ad-break positions detected in the player's own scrub bar | — |
| positions of any moments you flagged with the star button | 4200s |
| timestamps and the extension's version number | — |

It does **not** contain your name, email, account, IP address, device
identifiers, browsing history, or anything about pages other than the one you
calibrated. The extension has no analytics and no tracking of any kind.

Flagged moments are submitted as bare positions in the recording, with no note
or label attached. They are collected so the parts of a stage people mark can
be studied, and are **never shown to anyone else** — the extension only ever
displays the moments flagged in your own browser.

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
