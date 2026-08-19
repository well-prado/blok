with open("apps/studio/src/components/providers/ShortcutProvider.tsx", "r") as f:
    data = f.read()
data = data.replace("if (p && c && matchesCombo(p, c)) {", "if (p && c && matchesCombo(p as ParsedCombo, c as ParsedCombo)) {")
with open("apps/studio/src/components/providers/ShortcutProvider.tsx", "w") as f:
    f.write(data)
