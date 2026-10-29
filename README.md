# Celestillion

Celestillion has two modes:

- **Daily challenge (single player):** every day at 00:00 UTC, five new questions appear, each with a hidden list of correct answers. You get 25 seconds and one answer per question. Rarer answers score more: Refill 15, Spinner 30, Pufferfish 60, Seeker 85, Celestillion 100. A blank or wrong answer scores 0. Each player can play once per day, and there's a daily leaderboard and a copyable share card.
- **Multiplayer (2–6 players):** each round is a question with a hidden answer list. Players take turns, with 20 seconds to give an answer nobody has said yet this round. Wrong or repeated answers don't cost anything; the player keeps trying until time runs out. Running out of time costs one of 3 hearts and sits that player out for the rest of the round. Once two players have lost a heart in a round, play continues until the turn gets back to the player who started the round; then a new question begins, everyone with hearts is back in, and the next player in order starts. The last player with hearts left wins. A solo game runs until you lose all 3 hearts.

## How it works

- `server.js` runs an Express web server and a Socket.IO server. It holds every room in memory, keeps the answers secret, checks every guess, and runs the turn clock. The server is authoritative, so players can't cheat by editing the page.
- `game.js` has the multiplayer rules: turns, hearts, sitting out, and when a round ends.
- `daily.js` runs the daily challenge: picking the day's questions, the 25-second clock, scoring, and the leaderboard.
- `daily.txt` holds the questions and their answers, tagged by tier. Both modes use it; multiplayer rooms pick questions in a random order and skip that day's daily questions so nobody gets spoilers. There are 70 questions (14 days); after the last day it starts again from the top. Add more questions at the end of the file to extend it. The format is explained at the top of the file.
- Daily results and leaderboards are saved to `data/daily.json` (or the folder in `DATA_DIR`).
- `public/` is the page players open. It only sends actions and draws the state the server sends back. `public/fonts/` holds the Renogare font the whole site uses.

## Run it on your computer

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000 in two browser windows to play against yourself.

To run the automated checks (daily scoring and timing, the multiplayer round rules, and a short two-player game over the network):

```bash
npm test
```

## Deploy to Render

1. **Put the code on GitHub.** Create a new repository on github.com, then from this folder run:
   ```bash
   git init
   git add .
   git commit -m "Phrase Hunt"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/phrase-hunt.git
   git push -u origin main
   ```
2. **Create a Render account** at https://render.com and sign in with GitHub.
3. **Create the service.** In the Render dashboard, choose **New → Blueprint**, pick your repository, and click **Apply**. Render reads `render.yaml` and sets everything up.
   - Or choose **New → Web Service**, pick the repo, and enter: Runtime `Node`, Build command `npm install`, Start command `npm start`, Instance type `Starter`. Then add a disk (mount path `/var/data`) and set `DATA_DIR` to `/var/data` under **Environment**.
4. **Wait for the first deploy** (a couple of minutes). Render gives you a URL like `https://celestillion.onrender.com`. Share it with friends.

Every time you push to GitHub, Render redeploys automatically.

`render.yaml` uses the paid **Starter** instance with a 1 GB persistent disk, so daily scores and leaderboards survive restarts and deploys. Render doesn't do zero-downtime deploys for services with a disk: each deploy has a short gap, and open multiplayer games end.

### Things to know about the free plan

- The server goes to sleep after 15 minutes with no visitors. The next visitor waits about a minute while it wakes up. An active game keeps it awake.
- Rooms live in the server's memory, so they are cleared whenever the server sleeps, restarts, or redeploys. That's fine for casual games; a database would be needed to keep rooms longer.
- To avoid the wake-up wait, upgrade the service to a paid instance in Render.

## Settings

- `PORT` — set automatically by Render.
- `TURN_SECONDS` — length of each multiplayer turn (default 20).
- `ROUND_PAUSE_SECONDS` — pause between multiplayer rounds (default 6).
- `DAILY_SECONDS` — time per daily question (default 25).
- `DATA_DIR` — where daily results are saved (set to the disk in `render.yaml`).

In Render, change these under the service's **Environment** tab.

## Ideas for next steps

- Let the host pick question categories in the lobby.
- Proper capitalization for answers (they're shown as written in `daily.txt`, which is lowercase).
- Accounts, so the daily challenge can't be replayed by clearing browser data.
