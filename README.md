# preview

A live preview pane for Claude Code: the page Claude just made, a dev server, or the iOS simulator, beside the transcript.

- **Follows Claude**: when Claude writes or edits an `.html` file, or a command prints a `localhost:PORT` URL, the pane opens on it.
- **Refreshes as Claude edits**: a web page is re-captured after each edit and every 10 seconds, the simulator every 1.5 seconds (only when the picture changed).
- **Any terminal**: real pixels where the terminal speaks the kitty graphics protocol (Ghostty, kitty, WezTerm), colored half blocks elsewhere (Terminal.app).

## Commands

| Command | |
| --- | --- |
| `/preview` | Open or close the pane |
| `/preview index.html` · `/preview 5173` · `/preview localhost:3000 desktop` | Show a file, a port or a URL (phone width, or `desktop`) |
| `/preview sim` | Show the booted iOS simulator |
| `/preview refresh` | Capture again now |

Keys while the pane has focus: `s` simulator, `w` web, `r` refresh.

## Install

```sh
claude plugin marketplace add manikosto/preview
claude plugin install preview@preview
```

Needs Claude Code 2.1.289 or later, macOS, Google Chrome for web pages and Xcode for the simulator.

## How it works

It is a picture, not a live browser: headless Chrome (`--screenshot`) or `xcrun simctl io booted screenshot` writes a PNG to a temp folder, `sips` scales it, and the pane draws it. Settings in `/plugin`: refresh intervals and the pane's share of the terminal width.

## License

MIT
