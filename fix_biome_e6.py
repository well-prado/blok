def rep(f, o, n):
    with open(f, "r") as fl: d = fl.read()
    with open(f, "w") as fl: fl.write(d.replace(o, n))

rep("apps/studio/src/components/primitives/AnimatingArrow.tsx", "<svg", "// biome-ignore lint/a11y/noSvgWithoutTitle: presentation only\n      <svg")
rep("apps/studio/src/components/primitives/AnimatedNumber.tsx", "useEffect(() => {", "// biome-ignore lint/correctness/useExhaustiveDependencies: explicitly omitting displayValue to avoid infinite loops\n\tuseEffect(() => {")
rep("apps/studio/src/components/primitives/AnimatedNumber.tsx", "Math.pow(1 - progress, 5)", "(1 - progress) ** 5")

