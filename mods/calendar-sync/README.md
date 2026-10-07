# calendar-sync
> Reads your calendar (private iCal link) so notifications and questions respect meetings and time off, and suggests slots for long jobs.

**Category:** Productivity · **Version:** 1.0.0

## What it does
Reads one private iCal (ICS) address (Google, Outlook and Apple all give you one), keeps a 15-minute cache, and turns it into three things. A status line ("In a meeting until 12:30", "Next in 20m: Standup"). A `/calendar` agenda with today's free slots and a suggestion for a long job ("You're free 14:00–16:30"). And, with `mods-hub` installed, presence: in a meeting you are `away`, out of office (vacation, ferie, PTO, sick…) the hub goes into a Night-like hold, so the other mods' notifications and questions adapt. Without the hub you still get the agenda and the status line.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install calendar-sync@claude-mods
```

## Usage
**Setup (once):** put your private calendar address in `/config` under calendar-sync > Private iCal (ICS) address. `/calendar setup` says where to find it: Google (calendar settings > "Secret address in iCal format"), Outlook (Publish a calendar > ICS link), Apple (Public calendar link, `webcal://` works). Treat the address like a password; it is a secret option and never written to the cache, a toast or an error message.

| Command | What it does |
| --- | --- |
| `/calendar` · `today` | Today and tomorrow: agenda, what is on now, free slots inside your working hours. |
| `/calendar week` | Seven days. |
| `/calendar free [2h]` | The first free slot long enough (default 2 h): "You're free 14:00–16:30 today (2h 30m)", or the next day that fits. Handy before starting something long such as autopilot. |
| `/calendar refresh` | Read the calendar now. |
| `/calendar panel` | Open the Calendar tab of the Claude Mods panel (or a pane of its own without the hub). Buttons: Refresh, Today + tomorrow / Whole week. |
| `/calendar setup` | Where to find your private address. |

What it understands: `VEVENT` with `RRULE` (DAILY, WEEKLY with BYDAY, MONTHLY by day or Nth weekday, YEARLY; INTERVAL, UNTIL, COUNT), `EXDATE`, moved or cancelled instances (`RECURRENCE-ID`), all-day events (including multi-day), UTC, floating and `TZID` times (IANA names and the Windows names Outlook writes, through `Intl`), `TRANSP:TRANSPARENT` and Outlook's busy status (free, out of office). Events you declined (set `myEmail`) and cancelled ones are ignored.

**What counts as what.** A timed event is busy. An all-day event is information (a birthday), unless its title says you are away: *vacation, holiday, PTO, sick, ferie, permesso, malattia, urlaub, congé, vacaciones…* (add your own words in `offKeywords`). A short timed event ("Holiday party planning", 1 h) needs a stronger phrase (*out of office*, *OOO*, *fuori ufficio*) so it is not mistaken for time off.

## Configuration
| Key | Default | Description |
| --- | --- | --- |
| `icsUrl` | — | Private iCal (ICS) address (secret). Nothing happens until it is set. |
| `refreshMinutes` | `15` | How often the calendar is read; every session shares one copy. |
| `timezone` | this machine's | IANA zone for all-day events, floating times and working hours, e.g. `Europe/Rome`. |
| `workHours` · `workDays` | `09:00-18:00` · `mon-fri` | Free slots are offered inside these. |
| `minSlotMinutes` | `30` | Shorter gaps are not listed as free time. |
| `meetingPresence` | `true` | A meeting tells the hub you are away (hub only). |
| `outOfOffice` | `true` | Time off puts the hub in a Night-like hold (hub only). |
| `offKeywords` | — | Extra comma-separated words that make an event count as time off. |
| `myEmail` | — | Events you declined (matched on this address) are ignored. |
| `statusLine` | `true` | The "In a meeting until…" status line. |

## How it works
- **One reader for all sessions.** Files live in `~/.claude/claude-mods/calendar-sync/`: `cache.json` (parsed events and a hash of the address, never the address), `lease.json`, `applied.json`. A lease (renewed every 10 s, taken over after 30 s) elects one session as the leader: it refreshes the calendar, tells the hub and publishes the facts; the others read the cache file. A failed refresh keeps the last good copy and says so. A session with no copy at all fetches one itself at start.
- **What it tells the hub (`mods-hub` installed).** Only on a transition: a meeting calls `setPresence('away')`; time off also calls `setMode` with Night on and quiet hours `00:00-23:59`, remembering your previous Night settings in `applied.json`. When the event ends (or disappears after a refresh) the settings are given back, but only those still as it left them, and presence only if you did not change it by hand meanwhile. A presence you set by hand (`/hub here`, `/hub away`) is never overridden. It publishes `x.calendar-sync.busy` (`isBusy`, `kind` meeting | out-of-office | free, `until`; never a title) and shares the fact `calendar-sync.status` (kind, until, the best free slot today) for other mods, for example to pick a window for a long job. The tab is `Calendar` in the shared panel.
- **Without the hub** every hub call fails quietly: you keep `/calendar`, the pane and the status line, and nothing is changed anywhere.
- **Limits.** It reads the calendar; it never writes it. `HOURLY`/`MINUTELY` rules show their first instance only, and `BYSETPOS`/`BYWEEKNO` are not expanded. If you uninstall the mod while a time-off hold is on, the hub keeps the hold until you run `/hub night off` (a new session restores it on its own as soon as the mod runs again). Calendar titles are kept in the cache file and shown in `/calendar` output, which the model can read; nothing is sent anywhere except the one request to your calendar server.
