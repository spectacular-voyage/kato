---
id: utup12ei9wpp60uh2agzuhb
title: 2026 02 26 Workspace Settings
desc: ''
updated: 1772122525379
created: 1772118628434
---

## User Story

As a user, I would like to be able to set workspace-specific settings for:
  - ConversationEventKind capture
  - default filenaming
  - default output location
  - output format

## Requirements

- each project/workspace folder can have its own .kato/ folder with kato-config.yaml file that specifies where conversations go by default and filename patterns
- overriding the "general settings" gracefully, i.e., if not specified in workspace config, use general settings
- support robust workspace detection and explicit registration
  - in general settings, you should be able to specify file patterns (including wildcards) that will be scanned for `.kato/kato-config.yaml` files
  - there should be a kato CLI command for registering a workspace into the general config file and creating a `.kato/` folder and starter `kato-config.yaml` file there
- 
