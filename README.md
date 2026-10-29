# The Literature Games: live quiz

- **/host**: the projector screen. Pick a day plan or a single game; students join with the room code or the QR code.
- **/**: the students' page (phones).
- **/admin**: plan class days and edit questions, pictures and sounds.

The host and admin pages ask for the password set in `ADMIN_PASSWORD`.

## Settings on Render (Environment)

| Key | Value |
|---|---|
| `ADMIN_PASSWORD` | a password of your choice |
| `DATA_REPO` | `ndcyv/literature-games-data` (the private repository with the questions) |
| `GITHUB_TOKEN` | a fine-grained GitHub token with *Contents: Read and write* on that repository only |

Without `GITHUB_TOKEN` and `DATA_REPO` the app reads a local `data/` folder, and changes made in /admin are lost when the server restarts.

## The data repository

```
games/<game>.json   one file per game (16 games)
media/              pictures and sounds
plans.json          day plans
```

## Running it on your own computer

```
npm install
npm start
```

Put a copy of the data folder in `data/`, then open http://localhost:3000/host (password: `literature` unless you set `ADMIN_PASSWORD`).
