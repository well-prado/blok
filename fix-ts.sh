# ShortcutProvider.test.tsx
sed -i '' 's/import React from "react";//g' apps/studio/src/components/providers/ShortcutProvider.test.tsx
sed -i '' 's/afterEach, //g' apps/studio/src/components/providers/ShortcutProvider.test.tsx
sed -i '' 's/beforeEach, //g' apps/studio/src/components/providers/ShortcutProvider.test.tsx
sed -i '' 's/(s, i)/(s)/g' apps/studio/src/components/providers/ShortcutProvider.test.tsx
sed -i '' 's/expect(result.current\[0\]\.description)/expect(result.current[0]?.description)/g' apps/studio/src/components/providers/ShortcutProvider.test.tsx

# ShortcutProvider.tsx
sed -i '' 's/matchesCombo(p, c)/p \&\& c \&\& matchesCombo(p, c)/g' apps/studio/src/components/providers/ShortcutProvider.tsx
sed -i '' 's/if (p && c && matchesCombo(p, c)) {/if (p \&\& c \&\& matchesCombo(p, c)) {/g' apps/studio/src/components/providers/ShortcutProvider.tsx

# RunsTable.test.tsx
sed -i '' 's/act, //g' apps/studio/src/components/runs/RunsTable.test.tsx
sed -i '' 's/...actual,/...(actual as object),/g' apps/studio/src/components/runs/RunsTable.test.tsx
sed -i '' 's/unknown\[\]/any\[\]/g' apps/studio/src/components/runs/RunsTable.test.tsx
sed -i '' 's/row2Checkbox\.click()/row2Checkbox?.click()/g' apps/studio/src/components/runs/RunsTable.test.tsx
sed -i '' 's/row3Checkbox\.click()/row3Checkbox?.click()/g' apps/studio/src/components/runs/RunsTable.test.tsx

# RunsTable.tsx
sed -i '' 's/useEffect, //g' apps/studio/src/components/runs/RunsTable.tsx
sed -i '' 's/runs\[cursorIndex\]/runs[cursorIndex!]/g' apps/studio/src/components/runs/RunsTable.tsx

# GlobalShortcuts.test.tsx
sed -i '' 's/\.toHaveBeenCalledWith/\?.toHaveBeenCalledWith/g' apps/studio/src/components/shared/GlobalShortcuts.test.tsx

# ShortcutKey.test.tsx
sed -i '' 's/\.textContent/\?.textContent/g' apps/studio/src/components/shared/ShortcutKey.test.tsx

# ShortcutKey.tsx
sed -i '' 's/sequences\[0\]/sequences[0]!/g' apps/studio/src/components/shared/ShortcutKey.tsx

# $runId.test.tsx
sed -i '' 's/...actual,/...(actual as object),/g' apps/studio/src/routes/runs/\$runId.test.tsx
sed -i '' 's/useParams: () => ({ runId: "run-123" }),/useParams: () => ({ runId: "run-123" } as any),/g' apps/studio/src/routes/runs/\$runId.test.tsx

# $runId.tsx
sed -i '' 's/res\.runs\[idx + 1\]/res.runs[idx + 1]!/g' apps/studio/src/routes/runs/\$runId.tsx
sed -i '' 's/res\.runs\[idx - 1\]/res.runs[idx - 1]!/g' apps/studio/src/routes/runs/\$runId.tsx

bash fix-ts.sh
