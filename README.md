# name-the-game

Online party game: the host picks any topic, everyone takes turns naming things in it, no repeats. If you can't think of one (or your time runs out), you're out. Last player standing wins.

Players join a room with a 4-letter code. Answers are judged by Google Gemini through a small Node backend (no dependencies).

## Setup

1. Get a free Gemini API key at https://aistudio.google.com/apikey (sign in with a Google account, click **Create API key**).
2. Create a file called `.env` next to `server.js` containing:

   ```
   GEMINI_API_KEY=your-key-here
   ```

   (`.env` is git-ignored. You can also set `GEMINI_API_KEY` as a normal environment variable, which is what you'd do on a host like Render.)

## Run

```sh
npm start
```

Open http://localhost:3000, enter your name and click **Host a new room**. Share the 4-letter code or the link shown in the lobby. Requires Node 18+ and an internet connection.

## Letting friends join

- **Same Wi-Fi:** the lobby's share link already uses your computer's local network address (also printed when the server starts).
- **Anywhere else:** the server has to be reachable from the internet. Either:
  - run a free tunnel next to `npm start`, e.g. `cloudflared tunnel --url http://localhost:3000` (Cloudflare, no account needed) or `npx localtunnel --port 3000`, and share the URL it prints; or
  - deploy the folder to any Node host (Render, Railway, Fly.io…). The server reads `PORT` and `GEMINI_API_KEY` from the environment.

## How it works

- The host sets the topic and seconds per turn, and starts the game. Gemini first checks that the topic is something you can name several things of. Only the current player can type; everyone sees answers, checks and eliminations live.
- Each answer is sent to Gemini with the topic and the answers so far. Short names, nicknames and small typos are accepted when they clearly mean one thing ("Ford" for car brands), ambiguous ones are rejected with what they could mean ("Korea" for countries), and the same thing written differently counts as a repeat ("USA" after "United States"). The full name is what appears in the list.
- The judge's verdict is final: a rejected answer just means try again while your clock runs (the clock stops while an answer is being checked). The host can pause the game.
- Refreshing the page rejoins you as the same player. A player who stays disconnected for 15 seconds during a game is out; if it was the host, someone else becomes host. Rooms are deleted once everyone has been gone for 10 minutes.

The model defaults to `gemini-flash-lite-latest` (about 1 second per check). `GEMINI_MODEL=gemini-flash-latest` is smarter but takes around 8 seconds and has a lower free limit.

## Test

```sh
npm test
```

Plays a full 3-player game over HTTP against a real server (using an offline stand-in judge), and runs live Gemini answer checks if `GEMINI_API_KEY` is set.
