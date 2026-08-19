def rep(f, o, n):
    with open(f, "r") as fl: d = fl.read()
    with open(f, "w") as fl: fl.write(d.replace(o, n))

rep("apps/studio/src/components/providers/ShortcutProvider.test.tsx", "expect(items[0].textContent)", "expect(items[0]!.textContent)")

rep("apps/studio/src/components/providers/ShortcutProvider.tsx", "matchesPart(part, eventSeq[i])", "matchesPart(part, eventSeq[i]!)")
rep("apps/studio/src/components/providers/ShortcutProvider.tsx", "matchesPart(parsedSeq[i], part)", "matchesPart(parsedSeq[i]!, part)")

rep("apps/studio/src/components/runs/RunsTable.test.tsx", "...(actual as unknown),", "...(actual as any),")
rep("apps/studio/src/components/runs/RunsTable.test.tsx", "...(actual as object),", "...(actual as any),")
rep("apps/studio/src/components/runs/RunsTable.test.tsx", "screen.getAllByTitle(\"Select\")[1];", "screen.getAllByTitle(\"Select\")[1]!;")
rep("apps/studio/src/components/runs/RunsTable.test.tsx", "screen.getAllByTitle(\"Select\")[2];", "screen.getAllByTitle(\"Select\")[2]!;")

rep("apps/studio/src/components/runs/RunsTable.tsx", "import { useCallback, useEffect, useState }", "import { useCallback, useState }")

rep("apps/studio/src/routes/runs/$runId.test.tsx", "...(actual as object),", "...(actual as any),")
rep("apps/studio/src/routes/runs/$runId.test.tsx", "useParamsResult", "any")

