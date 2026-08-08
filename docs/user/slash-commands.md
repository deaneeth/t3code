# Slash commands

Type `/` in the composer to see commands that act on the thread itself — no matter which provider (Codex, Claude, Cursor, Grok, OpenCode, CommandCode) is answering. Every surface works the same: web, desktop, and mobile.

The list filters as you type. Commands fall into three groups:

- **Instant commands** run as soon as you pick them (or press Enter when the message is just the command).
- **Arg commands** need a value, like a new title or a duration — pick the command, type the value, send.
- **Provider commands** (marked in the picker) belong to the agent CLI itself and are sent to it as text.

## Command reference

| Command                   | What it does                                                   |
| ------------------------- | -------------------------------------------------------------- |
| `/model`                  | Switch the model used for the next turn.                       |
| `/plan`                   | Put the thread in plan mode — the agent plans before building. |
| `/default`                | Leave plan mode and go back to normal build mode.              |
| `/todos`                  | Open this thread's plan and task list.                         |
| `/clear`                  | Start a new thread and clear this conversation.                |
| `/rename new title`       | Rename the thread.                                             |
| `/context`                | Show context window usage for this thread.                     |
| `/stats`                  | Show token and activity stats for this thread.                 |
| `/stop`                   | Stop the current turn.                                         |
| `/revert 3`               | Revert the thread to an earlier checkpoint.                    |
| `/snooze 2h`              | Snooze the thread for a duration (`30m`, `2h`, `1d`, …).       |
| `/unsnooze`               | Wake a snoozed thread.                                         |
| `/archive` / `/unarchive` | Archive or restore the thread.                                 |
| `/pin` / `/unpin`         | Pin or unpin the thread in the sidebar.                        |
| `/settle` / `/unsettle`   | Settle the thread so it stops nagging, or unsettle it.         |
| `/help`                   | List these commands.                                           |

## On mobile

Commands run via the same picker, and the standalone ones also work when you type
them and hit send: `/stop` interrupts the turn, `/archive` archives the thread, and
so on. A few surface-dependent actions (`/context`, `/stats`, `/revert`, `/clear`,
`/todos`) explain themselves inside the app rather than pretending to work there.

## Inside a message

A slash command at the start of the message, followed by more text, is ordinary
prompt text and goes to the agent — only the pickup (or the message that contains
exactly the command) acts on the thread itself.
