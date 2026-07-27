# Two-Thumb Treaty

Local multiplayer party game: **two players, one phone, left thumb vs right thumb**.

## Play locally

Open `index.html` in a browser, or:

```powershell
start "$env:USERPROFILE\Documents\two-thumb-treaty\index.html"
```

Best on a phone or tablet (two people side by side). Desktop works for testing (split the trackpad/mouse between halves).

## Modes

1. **Balloon Treaty** — Left blows the balloon up; Right fires spikes.
2. **Bridge & Bomb** — Left repairs; Right bombs; runner tries to cross.
3. **Hungry vs Healthy** — Drag your foods into the mouth; highest score wins.

Best of 3 series. Rematch or **switch sides** after each round.

## Deploy on Render

1. Push this folder to a GitHub repo.
2. In [Render](https://render.com) → **New** → **Static Site**.
3. Connect the repo, set:
   - **Build command:** *(leave empty)*
   - **Publish directory:** `.`
4. Or use the included `render.yaml` Blueprint.

No backend required.

## Stack

Static HTML + CSS + Canvas JavaScript. No build step, no dependencies.
