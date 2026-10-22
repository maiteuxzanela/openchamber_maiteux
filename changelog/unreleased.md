---
title:
---

## App

### Improvements
- Desktop/Performance: the embedded browser now frees heap when the native shell reports memory pressure (`openchamber:memory-pressure`): hidden extension frames are detached (`about:blank`) and derived caches (rendered markdown, turn projections, file contents, parsed diffs, file trees, debug buffers) are released, while the active session, drafts and the visible pane keep their state.

## VS Code
