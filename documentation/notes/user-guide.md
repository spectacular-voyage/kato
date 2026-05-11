---
id: fenubr668qxsy1dtv8r1a5c
title: User Guide
desc: ''
updated: 1775504358256
created: 1775504358256
---

## Kato Web Port Selection

Kato Web uses the configured web port as its preferred port. The default is
`http://127.0.0.1:5173/`.

When `kato web start` sees that port is already in use, it tries the next port
up until it finds an available one. For example, if Windows is already serving
Kato Web at `127.0.0.1:5173`, a WSL2 Kato Web start can choose
`127.0.0.1:5174` instead. Use `kato web status` to see the actual running URL.
