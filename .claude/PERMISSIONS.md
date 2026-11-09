# Shell permissions for Task 0

Task 0 ("Clone Repository or Verify Codebase") materialises your legacy source
into this directory. It runs exactly these commands:

```bash
  git init
  git remote add origin <REPOSITORY_URL>
  git fetch --depth 1 origin HEAD
  git checkout FETCH_HEAD -- .
```

The last one writes the repository into the working tree. Most assistants class
that as a destructive command and will pause for approval — that is expected,
and approving it is safe here: this directory holds only the ProjexLight export
until the source lands.

## Granting it in claude

This export ships `.claude/settings.local.json` pre-granting exactly these commands, so Task 0 should run unattended.

If you are still prompted (for example the settings file was overwritten when the legacy repo was checked out), approve the prompt, or run `/permissions` and add `Bash(git checkout FETCH_HEAD -- .)`.

## If your assistant is blocked and cannot ask

Some hosts deny a command outright instead of prompting. If that happens, the
assistant should stop and hand you the command to run yourself:

```bash
git checkout FETCH_HEAD -- .
```

Run it from the project root, then tell the assistant to continue. Nothing is
lost — `git fetch` has already downloaded every object; only the working-tree
write is outstanding.

## After the checkout: three files need merging, not overwriting

The checkout can overwrite files this export owns. Restore or merge them:

| Path | Action |
|---|---|
| `.gitignore` | **Merge.** Keep the repo's rules AND the ProjexLight block that ignores `.projexlight/config.json` and `mcp-server/mcp-config.json` — those hold your session token. |
| `.claude/` config | **Merge.** Keep your repo's settings AND this export's MCP registration. |
| `.env.example` | **Keep the export's copy** (it carries the `PROJEXLIGHT_*` variables). |

`.projexlight/` and `mcp-server/` are not shipped by application repos and
normally do not collide — but verify all three coexist before continuing.
