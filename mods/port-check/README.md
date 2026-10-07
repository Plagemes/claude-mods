# port-check
> Before a dev server starts, tells you if the port is already taken and by which process.

**Category:** DevOps & Cloud · **Version:** 1.0.0

## What it does
Before Claude runs a Bash command that starts a dev server (`npm run dev`, `vite`, `next dev`, `rails s`, `python manage.py runserver`, `flask run`, `uvicorn`, `php artisan serve`, `--port N` and many more), port-check works out the port the server will use and looks whether something is already listening there. If so you get a toast naming the process, and Claude gets a note with its pid and command line. The command still runs: nothing is blocked.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install port-check@claude-mods
```

## Usage
Nothing to run. You see a toast such as `port 3000 is already in use by node (pid 4821)`, and Claude gets:

```
port-check: port 3000 (next's port for this command) is already listening: node, pid 4821: node /app/server.js --watch.
The server may fail with EADDRINUSE or move to another port. Stop that process (kill 4821) or pick another port with --port.
```

The port comes from the command (`--port 4000`, `-p 4000`, `runserver 0.0.0.0:8080`, `PORT=4000 ...`) and otherwise from the tool's default (Vite 5173, Next.js 3000, Rails 3000, Django 8000, Flask 5000, ...). For `npm run dev`, `pnpm dev`, `yarn start` and the like it reads the script from `package.json` (also `npm run dev -- --port 4100`, `cd app && ...` and `concurrently` lists) and checks the ports of the servers in it.

## Configuration
No configuration needed.

## How it works
- Hooks `tool.call` for `Bash`. It reads the command like a shell, finds server starts and their ports, and asks `lsof -nP -iTCP:<port> -sTCP:LISTEN` (or `ss -ltnp` where lsof is missing), plus `ps` for the command line, each with a 3 second limit. The note is added to the command's result.
- Silent when neither lsof nor ss is installed, when the port is free, or when it cannot tell which port a script uses (for example `node server.js` without `--port`).
- Limits: it checks TCP listeners the current user can see, only once before the command starts, and a script that picks its port at run time (config files, `.env`) is not understood.
