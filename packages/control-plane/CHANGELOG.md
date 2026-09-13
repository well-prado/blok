# @blokjs/control-plane

## 2.2.1

### Patch Changes

- Fix the workspace filesystem watcher on macOS: kqueue's directory self-event was turned into a bogus path and consumed the bounded watch budget before the real per-file event (#991). Lockstep 2.2.1 for every package.
- Updated dependencies
  - @blokjs/shared@2.2.1
  - @blokjs/runner@2.2.1

## 2.2.0

### Minor Changes

- Lockstep 2.2.0 release alongside the new runtime sidecars (no package-local changes).
