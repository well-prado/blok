with open("apps/studio/src/components/primitives/AnimatedNumber.tsx", "r") as f:
    d = f.read()

d = d.replace("\t// biome-ignore lint/correctness/useExhaustiveDependencies: explicitly omitting displayValue to avoid infinite loops\n\tuseEffect(() => {\n\t\tconst mql = window.matchMedia", "\tuseEffect(() => {\n\t\tconst mql = window.matchMedia")

with open("apps/studio/src/components/primitives/AnimatedNumber.tsx", "w") as f:
    f.write(d)
