# The Literature Games: live quiz

A small classroom quiz app. You show the **host screen** on the projector. Students join on their phones with a **room code** or by scanning the **QR code**. Answers stay hidden until everyone has answered (or time runs out), and then you reveal them.

Pilot game: **Crack the Code!** (10 questions from the 2024 classes).

## In class

1. Open `https://<your-app>.onrender.com/host` about a minute before class (the free plan sleeps when nobody uses it).
2. Click **Crack the Code!**. A room code and a QR code appear.
3. Students scan the QR code (put it on your Canva slide too), or open the site and type the code and their name.
4. Click **Start the game** (or press Space).
5. Each question reveals itself when everyone has answered. You can also press **Reveal now**.
6. On the answer screen, press **Accept** under a wrong answer that should count (a typo, another spelling). Points are added straight away.
7. Press **Next question** (or Space / →).
8. At the end, **Download results (CSV)** gives every student's answers and points (it opens in Excel).

**Scoring:** a correct answer earns 500–1,000 points; the faster the answer, the more points. A perfect game is close to 10,000, the same scale as the solo round in the course.

**If a phone disconnects:** the student reopens the page and rejoins automatically with their score.

## Adding games

Each game is a file in `games/`. Copy `crack-the-code.json`, change `id`, `title`, `intro`, `timeLimit` (seconds) and the questions. `accept` lists other spellings that also count.

## Running it on your own computer

```
npm install
npm start
```

Then open http://localhost:3000/host.
