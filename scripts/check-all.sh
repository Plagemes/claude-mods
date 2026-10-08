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
node scripts/check-startup.mjs "${mods[@]/#/mods/}" >/dev/null && echo "✓ session.start stays fast" || { echo "✗ session.start waits on slow work (node scripts/check-startup.mjs)"; failed+=(startup); }
node scripts/check-render.mjs "${mods[@]/#/mods/}" >/dev/null && echo "✓ every pane draws a tree of its own" || { echo "✗ a ui.render hook can leave a pane blank (node scripts/check-render.mjs)"; failed+=(render); }
node scripts/check-prompt-budget.mjs >/dev/null && echo "✓ tool and agent descriptions stay short" || { echo "✗ a tool or agent description is over its prompt budget (node scripts/check-prompt-budget.mjs)"; failed+=(prompt-budget); }
claude plugin validate . >/dev/null 2>&1 && echo "✓ marketplace" || { echo "✗ marketplace"; failed+=(marketplace); }
echo "${#mods[@]} mods checked, ${#failed[@]} failed ${failed[*]:-}"
[ ${#failed[@]} -eq 0 ]
