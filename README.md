# CutFolio

A private web app for one independent barber, built for iPhone Safari.

- **Home:** monthly revenue, total customers, new vs returning clients, and best day.
- **Log cut:** pick a returning client by typing their name (or add a new one), take or upload photos, tap a price and time, save.
- **Client portfolio:** searchable list of clients. Each profile has past cut photos, average price, average time, and transaction history.
- **View schedule:** a week strip and the day's bookings. Book a client by name and the length is projected from their average cut time (or your shop average for new clients); the next open slot is filled in for you, and the sheet stays open so you can book a whole day in a row. Tap a booking to view the client's profile, log the cut, move it, or remove it.
- **Email reminders (AWS):** add a client's email on their profile and they get a confirmation when booked and a reminder 24 hours before. The profile and booking show what was sent. **Overdue** lists clients past their usual gap; pick them, tap your openings, and email them all at once. Runs on AWS Lambda and EventBridge Scheduler, sending through Gmail for free (or Amazon SES). Setup is in [aws/README.md](aws/README.md).

It's plain HTML, CSS, and JavaScript with no build step. Data and photos are stored in [Supabase](https://supabase.com), and only the signed-in barber can read them.

## Files

| File | What it is |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | The app |
| `config.js` | Supabase project URL and anon key |
| `supabase/schema.sql` | Tables, photo bucket, and access rules |
| `supabase/schedule.sql` | Just the appointments table, for databases set up before the schedule existed |
| `supabase/reminders.sql` | Client emails and the email log, for databases set up before reminders existed |
| `aws/` | Email reminders: Lambda code, SAM template (Lambda, Function URL, EventBridge schedule), and setup steps |
| `vendor/supabase.js` | supabase-js 2.117.3 (UMD build), bundled so the app doesn't depend on a CDN |
| `manifest.webmanifest`, `icons/` | Home Screen name and icon |

## Setup

### 1. Supabase

1. Create a free project at supabase.com.
2. Open **SQL Editor → New query**, paste all of `supabase/schema.sql`, and press **Run**.
3. Open **Authentication → Users → Add user → Create new user**. Enter `barber@cutfolio.app` (or any email, as long as it matches `loginEmail` in `config.js`) and the app password, and check **Auto Confirm User**. The barber never types the email; he only enters the password.
4. Open **Authentication → Sign In / Providers** and turn off **Allow new users to sign up**, so nobody else can make an account.
5. Open **Project Settings → API** and copy the **Project URL** and the **anon public** key into `config.js`, along with the email from step 3 as `loginEmail`. Never use the `service_role` key in the app.

### 2. GitHub Pages

1. Push this repo to GitHub.
2. Open the repo's **Settings → Pages**, set **Source** to *Deploy from a branch*, pick `main` and `/ (root)`, and save.
3. The site appears at `https://<username>.github.io/<repo>/` after a minute or two.

### 3. On the barber's iPhone

1. Open the site in Safari.
2. Tap **Share → Add to Home Screen**, then open CutFolio from the Home Screen and enter the password once. It stays unlocked on that phone until someone taps **Sign out** at the bottom of the home screen.

Opening it from the Home Screen icon matters: Safari can clear a website's saved login after about a week without visits, but it doesn't do that for Home Screen apps.

## Running locally

Any static file server works, for example `python3 -m http.server` from this folder, then open http://localhost:8000.
