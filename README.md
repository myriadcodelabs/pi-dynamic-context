# pi-dynamic-context

Domain-aware dynamic context extraction and injection extension for [Pi](https://pi.dev).

> **Alpha:** this package is currently in alpha. Behavior and configuration may change.

## Install

```bash
pi install npm:@myriadcodelabs/pi-dynamic-context
```

Then start or reload Pi. The package manifest exposes `index.ts` as a Pi extension.

## What it does

- Automatically selects a domain for each prompt.
- Injects the stored context for that domain into provider requests.
- Extracts updated context after each settled agent run.
- Omits adding previous conversation history when generating the latest context.
- Stores extracted context in the current Pi session as custom entries.

## Commands and tools

- `/dynamic-context` shows current status.
- `get_dynamic_context` lets the assistant inspect selected and stored context.
