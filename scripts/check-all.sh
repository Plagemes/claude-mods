#!/usr/bin/env bash
# Validates and tests every mod (or the ones named): bash scripts/check-all.sh [mod...]
set -u
cd "$(dirname "$0")/.."
mods=("$@"); [ ${#mods[@]} -eq 0 ] && mods=($(ls mods))
failed=()
for m in "${mods[@]}"; do
  if claude plugin validate "mods/$m" >/dev/null 2>&1 && claude plugin test "mods/$m" >/dev/null 2>&1; then
    echo "✓ $m"
  else
    echo "✗ $m"; failed+=("$m")
  fi
done
claude plugin validate . >/dev/null 2>&1 && echo "✓ marketplace" || { echo "✗ marketplace"; failed+=(marketplace); }
echo "${#mods[@]} mods checked, ${#failed[@]} failed ${failed[*]:-}"
[ ${#failed[@]} -eq 0 ]
