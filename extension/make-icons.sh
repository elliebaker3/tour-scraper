#!/bin/sh
# Regenerate the toolbar PNGs from icon.svg. Chrome wants several sizes: 16
# beside the address bar, 32 on Windows, 48 on the extensions page, 128 in
# the store and the install dialog. Shipping only a large one and letting the
# browser downscale gives a muddy 16px, which is the size actually seen most.
set -e
cd "$(dirname "$0")"
for s in 16 32 48 128; do
  rsvg-convert -w $s -h $s icon.svg -o "icon-$s.png"
  echo "  icon-$s.png"
done
