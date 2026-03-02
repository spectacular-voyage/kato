---
id: 4t97owqubbhk7poems1t1va
title: 2026 03 01 Tweaks
desc: ''
updated: 1772432178798
created: 1772422088094
---

## Goals

- for filename templating, instead of {timestampUtc} let's just have {timestampISO8601} and {timestampHumane} that looks like "2026-03-01_1234", and a separate configuration key for timezone, which can take timezone key, or "local" to just use the system timezone.
- 