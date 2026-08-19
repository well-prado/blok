import re
def replace(file, old, new):
    with open(file, "r") as f:
        d = f.read()
    with open(file, "w") as f:
        f.write(d.replace(old, new))

replace("apps/studio/src/components/providers/ShortcutProvider.test.tsx", "expect(result.current[0]?.description)", "expect(result.current[0]!.description)")
replace("apps/studio/src/components/providers/ShortcutProvider.test.tsx", "expect(result.current[0].description)", "expect(result.current[0]!.description)")

replace("apps/studio/src/components/runs/RunsTable.test.tsx", "...(actual as object),", "...(actual as any),")
replace("apps/studio/src/components/runs/RunsTable.test.tsx", "row2Checkbox?.click()", "row2Checkbox!.click()")
replace("apps/studio/src/components/runs/RunsTable.test.tsx", "row3Checkbox?.click()", "row3Checkbox!.click()")
replace("apps/studio/src/components/runs/RunsTable.test.tsx", "row2Checkbox.click()", "row2Checkbox!.click()")
replace("apps/studio/src/components/runs/RunsTable.test.tsx", "row3Checkbox.click()", "row3Checkbox!.click()")

replace("apps/studio/src/routes/runs/$runId.test.tsx", "...(actual as object),", "...(actual as any),")
replace("apps/studio/src/routes/runs/$runId.test.tsx", "useParams: () => ({ runId: \"run-123\" }),", "useParams: () => ({ runId: \"run-123\" } as any),")
