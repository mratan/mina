#!/bin/sh
# Rebuild the carried pi-claude-subscription package: upstream 0.2.4 plus mina's patches (docs/vendor-patches.md).
# Output: vendor/pi-claude-subscription-0.2.4-mina.5.tgz. Run from the repository root; needs npm and patch.
set -eu
UPSTREAM=pi-claude-subscription@0.2.4
VERSION=0.2.4-mina.5
PATCHES="$PWD/vendor/patches"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
(cd "$work" && npm pack --silent "$UPSTREAM" >/dev/null && tar -xzf pi-claude-subscription-0.2.4.tgz)
for patch in rate-limit-event account-profiles refusal-fallback history-fidelity telemetry-off; do
  patch -d "$work/package" -p1 --forward --silent < "$PATCHES/pi-claude-subscription-0.2.4-$patch.patch"
done
# Mark the carried build so it can never be mistaken for the upstream release.
node -e 'const f=process.argv[1],p=JSON.parse(require("fs").readFileSync(f));p.version=process.argv[2];require("fs").writeFileSync(f,JSON.stringify(p,null,2)+"\n")' "$work/package/package.json" "$VERSION"
(cd "$work/package" && npm pack --silent --pack-destination "$work" >/dev/null)
mv "$work/pi-claude-subscription-$VERSION.tgz" "vendor/pi-claude-subscription-$VERSION.tgz"
echo "vendor/pi-claude-subscription-$VERSION.tgz"
