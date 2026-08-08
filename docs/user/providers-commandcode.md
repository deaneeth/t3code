# CommandCode

T3 Code can use the CommandCode CLI as a server-side provider. The server machine must have
CommandCode installed and authenticated; the browser or mobile device does not need a separate
installation.

## Setup

Install and authenticate CommandCode on the machine running T3 Code:

```bash
npm install --global command-code
command-code login
command-code status
```

Open **Settings** and refresh the provider status. T3 Code detects the `command-code` executable,
shows the live model catalog, and adds CommandCode to the model picker. If the executable is not on
the server's `PATH`, set **Binary path** on the CommandCode provider instance.

Effort choices are model-specific. T3 Code exposes the levels advertised by its CommandCode model
catalog, including **Low**, **Medium**, **High**, **Extra High**, and **Max** where supported. Models
without a declared effort capability leave the effort flag unset so CommandCode can choose its own
default. CommandCode's own model ids are passed through unchanged, including ids such as
`deepseek/deepseek-v4-flash` and `claude-sonnet-4-6`.

## Permission modes

T3 Code starts CommandCode in headless JSON mode and maps the thread's permission mode to the
corresponding CommandCode mode. Full access uses CommandCode's `--yolo` flag; other modes retain
CommandCode's own restrictions. CommandCode headless mode does not expose an interactive approval
reply channel, so a supervised turn can show a denied tool instead of waiting for an inline approval.
Use Auto-accept or Full access when the thread needs to edit files or run commands unattended.

## Sessions and limitations

Follow-up turns resume the CommandCode session returned by the CLI, so the model keeps its context
within the T3 thread. T3 Code also passes the project directory and attachment paths to CommandCode.
Stopping a turn terminates the headless process; rolling a thread back starts a fresh CommandCode
session because the CLI does not document a headless rewind operation.

The provider works in local, remote, desktop, and mobile connection modes because the CLI always
runs on the T3 server.
