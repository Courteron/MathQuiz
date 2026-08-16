
# MathQuiz - A way to learn maths

A pirate-themed, Kahoot-style math quiz you host yourself. One "master" screen (meant to be projected or shared on a TV/laptop) creates a game and displays a QR code; players join from their phone and answer questions live, with a real-time scoreboard and a ship race showing everyone's progress.

### This project is still in development.
You can try a demo version of it on: https://mathquiz-f4j6.onrender.com/

## Requirements

- [Node.js](https://nodejs.org/) (v18 or later recommended) and npm
- [ngrok](https://ngrok.com/download) — only needed if you want to share the game with players outside your local network (e.g. over the internet instead of just Wi-Fi). A free ngrok account and its authtoken are enough.

## Installation

```bash
git clone <this-repo-url>
cd MathQuiz
npm install
```

## Configuration

By default the server runs locally on port `8080` — no configuration needed if all your players are on the same Wi-Fi/network as the host.

To also expose the game publicly through an ngrok tunnel (so players can join from outside your local network), create a `.env` file at the root of the project:

```
NGROK_AUTHTOKEN=your_ngrok_authtoken_here
```

You can find your authtoken on your [ngrok dashboard](https://dashboard.ngrok.com/get-started/your-authtoken). Never commit this file — it's already excluded via `.gitignore`.

If `NGROK_AUTHTOKEN` isn't set, the server still starts fine and works locally; it just skips creating the public tunnel.

## Running the game

```bash
npm start
```

This starts the server on `http://localhost:8080` (and prints a public `https://...ngrok-free.dev` URL too, if you configured `NGROK_AUTHTOKEN`).

Open that URL in a browser on the host machine — that's the **master screen**.

## How to play

1. On the master screen, click **Family game**, pick your calculation types, difficulty, number of questions (or a time limit), and optional sound/music, then **Start**.
2. A QR code and a game code appear. Players scan the QR code (or open the site and choose **Join a game** with the code) on their own phone to enter a pseudo and join.
3. Once everyone's in, click **Start Game** on the master screen. Questions are sent to each player individually; answers, scores and the ship race update live on the master screen.
4. When everyone's done, the master screen shows the final scoreboard.

## Project structure

- `main.js` — Node/Express server + WebSocket game logic (one server, no database, everything in memory)
- `server/index.html` — the master (host) screen
- `server/mobile/index.html` — the player screen, opened on each participant's phone
- `assets/` — music, sound effects and images

## Legal

I 'borrowed' some content of some websites, mainly graphical elements of "Je peux pas j'ai maths" (jepeuxpasjaimaths.fr - ARSAC Benjamin.) I will try and replace them in the following days.
