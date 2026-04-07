---
id: r6b2dlw3kf32p5fqkpg2w2i
title: 2026 03 03 Queue Hardening
desc: ''
updated: 1772565624868
created: 1772565295231
---

daemon-control.json is the cross-process command queue (start|stop|export|clean) that clients write and daemon consumes.

the real issue: current control queue has potential write contention because enqueue() is read-modify-write JSON without locking, and 

## Discussion.


- the daemon does not enqueue its own commands there; it only consumes/marks processed. In-chat commands are handled inside daemon runtime state, not via this queue file.