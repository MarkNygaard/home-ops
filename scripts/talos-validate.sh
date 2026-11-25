#!/usr/bin/env bash
# Generate the Talos node configs from talos/ and validate them.
#
# Runs in CI (.github/workflows/talos.yaml) and works the same locally. It
# never reads the real cluster secrets: talsecret.sops.yaml is encrypted, and
# the shape of the config does not depend on the secret values, so a
# throwaway set is generated instead. Nothing touches talos/clusterconfig/.
#
# Fails on:   genconfig errors, `talosctl validate` errors.
# Reports:    `--strict` findings (deprecations) as warnings, without failing.
#             talhelper bundles an older Talos config library than talosctl,
#             so some deprecations cannot be fixed until talhelper catches up.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cp -r "$repo_root/talos/talconfig.yaml" "$repo_root/talos/talenv.yaml" "$repo_root/talos/patches" "$work/"
cd "$work"

annotate() { # level message
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    echo "::$1::$2"
  else
    echo "$1: $2"
  fi
}

talhelper gensecret > talsecret.yaml

if ! talhelper genconfig --secret-file talsecret.yaml --out-dir out --no-gitignore >genconfig.log 2>&1; then
  cat genconfig.log
  annotate error "talhelper genconfig failed: $(grep -m1 -i 'failed' genconfig.log || tail -1 genconfig.log)"
  exit 1
fi

shopt -s nullglob
nodes=0
failed=0
declare -A warnings=()

for f in out/*.yaml; do
  [[ "$(basename "$f")" == talosconfig ]] && continue
  nodes=$((nodes + 1))
  node="$(basename "$f" .yaml)"

  if ! out="$(talosctl validate --mode metal --config "$f" 2>&1)"; then
    echo "$out"
    annotate error "$node: talosctl validate failed"
    failed=1
    continue
  fi

  if ! strict="$(talosctl validate --mode metal --strict --config "$f" 2>&1)"; then
    while IFS= read -r w; do
      warnings["$w"]+="$node "
    done < <(grep -oE 'warning: .*' <<<"$strict" | sed 's/^warning: //' | sort -u)
  fi
  echo "$node: valid"
done

if [[ $nodes -eq 0 ]]; then
  annotate error "genconfig produced no node configs"
  exit 1
fi

for w in "${!warnings[@]}"; do
  annotate warning "talosctl validate --strict: $w (${warnings[$w]% })"
done

exit $failed
