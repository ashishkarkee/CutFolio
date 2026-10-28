# CutFolio email reminders (AWS)

Clients who have an email on their profile get:

- **A booking confirmation** as soon as they're booked (or moved): "You're booked: Sat, Nov 1 at 2 PM".
- **A 24-hour reminder**: "You're confirmed for a haircut tomorrow at 2 PM!"
- **An overdue reminder** when the barber picks them on the Overdue screen: "Your last cut was on September 28… Here's when I have openings: Saturday 12–4 PM, Sunday 4–8 PM."

Every email has an unsubscribe link, and every email sent is logged in Supabase so the app can show it on the client's profile and on the booking.

## How it works

```
 iPhone app (GitHub Pages)                         Supabase (Postgres)
   │  book / move / "Email 3 clients"                ▲  clients, appointments,
   │  POST + barber's login token                    │  cuts, emails (log)
   ▼                                                 │
 Lambda Function URL ──► AWS Lambda (Node.js 22) ────┘
                              ▲        │
 EventBridge Scheduler ───────┘        ▼
   every 15 minutes             Amazon SES ──► client's inbox
   {"job":"reminders"}
```

- **One Lambda** (`reminders/index.mjs`) handles all three emails. It has no dependencies to install: it uses the AWS SDK that ships with the Lambda runtime and plain `fetch` for Supabase.
- **EventBridge Scheduler** runs it every 15 minutes. Each run finds bookings starting in the next 24 hours and sends each one reminder. A unique index in the `emails` table makes double-sends impossible even if two runs overlap, and bookings made less than a day ahead are skipped because the confirmation already covers them.
- **The app** calls the Lambda's Function URL with the barber's Supabase login token. The Lambda checks that token with Supabase before it reads or sends anything, and only touches that barber's rows.
- **Secrets** (the Supabase secret key) live only in the Lambda's environment. The app and the repo never see them.
- **Infrastructure as code:** everything is in `template.yaml` (AWS SAM), so the whole stack deploys or deletes with one command.

## Cost

Checked against AWS pricing pages in October 2026:

| Service | Free allowance | CutFolio's use |
| --- | --- | --- |
| Lambda | 1M requests + 400,000 GB-seconds a month | ~3,000 runs a month |
| EventBridge Scheduler | 14M invocations a month | ~2,900 a month |
| SES | No standing free tier. $0.10 per 1,000 emails | ~300 emails ≈ $0.03 a month |
| CloudWatch Logs | 5 GB a month | a few MB, kept 14 days |

New AWS accounts on the Free plan get up to $200 in credits for 6 months, which covers SES. After that, expect a few cents a month.

## Setup (about 30 minutes, plus a day waiting on SES)

Do every step in the **same AWS region**. Pick one near you in the top-right region menu (for example *US East (N. Virginia)*) and stay in it.

### 1. AWS account and a spending alert

1. Sign up at aws.amazon.com (choose the **Free** plan) or sign in.
2. Open **Billing and Cost Management → Budgets → Create budget**, pick the **Zero spend budget** or a **$1 monthly cost budget**, and enter your email. You'll hear about it if anything ever costs money.

### 2. Amazon SES: verify who emails come from

Open **Amazon SES → Configuration → Identities → Create identity**.

- **Best: a domain you own** (for example `freshfades.com`). Choose *Domain*, keep *Easy DKIM* on, and create it. SES shows three CNAME records; add them where you bought the domain. It turns *Verified* within an hour or so. Emails then come from something like `bookings@freshfades.com` and land in the inbox.
- **Quick start: one email address.** Choose *Email address*, enter it, and click the link SES emails you. This works, but emails "from" a Gmail address sent through SES often land in spam, so treat it as a test setup.

While the account is in the **SES sandbox**, it can only send *to* verified addresses too. Verify your own email the same way so you can test.

### 3. Ask SES for production access

Open **Amazon SES → Account dashboard → Request production access** and fill it in:

- **Mail type:** Transactional
- **Website URL:** `https://ashishkarkee.github.io/CutFolio/`
- **Use case:** something like *"Appointment confirmations and reminders for one independent barber's clients. Clients give their email in person and can unsubscribe with a one-click link in every email. Expected volume under 500 emails a month. Bounces are low because addresses are entered by the barber from the client."*

AWS usually answers within a day. Until then, only verified addresses get emails.

### 4. Supabase

1. **SQL Editor → New query**, paste all of `supabase/reminders.sql`, and press **Run**.
2. **Project Settings → API Keys → Secret keys**: create or reveal a secret key (`sb_secret_…`) and keep it handy for the next step. It goes into AWS only. Never put it in `config.js` or the repo.

### 5. Deploy the Lambda + schedule (AWS CloudShell)

CloudShell is a terminal in the AWS console with the AWS and SAM command-line tools already installed. Click the **>_** icon in the top bar, then run:

```bash
git clone https://github.com/ashishkarkee/CutFolio.git
cd CutFolio/aws
sam deploy --guided
```

Answer the prompts:

| Prompt | Answer |
| --- | --- |
| Stack Name | `cutfolio` |
| AWS Region | the region you picked |
| SupabaseUrl | `https://euohjxiopeufjqtsrugm.supabase.co` |
| SupabaseSecretKey | the `sb_secret_…` key (it won't show as you paste) |
| FromEmail | the address you verified in step 2, e.g. `bookings@freshfades.com` |
| ReplyToEmail | the barber's real inbox, where client replies should go |
| ShopName / BarberName / ShopAddress | how emails are signed; the address is optional |
| ShopTimeZone | e.g. `America/Chicago`, `America/New_York`, `America/Los_Angeles` |
| AppOrigin | press Enter for `https://ashishkarkee.github.io` |
| Confirm changes before deploy | `N` |
| Allow SAM CLI IAM role creation | `Y` |
| Disable rollback | `N` |
| RemindersFunction Function Url has no authentication. Is this okay? | `y` (the function checks the barber's login itself) |
| Save arguments to configuration file | `Y` |

When it finishes, it prints **RemindersUrl**, something like `https://abc123.lambda-url.us-east-1.on.aws/`.

`samconfig.toml` (the saved answers) stays in CloudShell. Don't commit it.

### 6. Connect the app

Put the RemindersUrl into `config.js` as `remindersUrl` (it isn't secret), bump the `?v=` numbers in `index.html`, and push. Or send it to Claude in the CutFolio project and it'll do it.

### 7. Test

1. In CutFolio, open a test client, add **your own verified email**, and book them for tomorrow. A confirmation should arrive within seconds, and the booking shows *confirmed*.
2. Book a test client for a little over 24 hours from now. Within 15 minutes of it crossing the 24-hour mark, the reminder arrives and the profile shows *24-hour reminder sent*.
3. On **Overdue**, pick the test client, tap a day or two for openings, and send.

Logs for every run are in **CloudWatch → Log groups → /aws/lambda/cutfolio-reminders**.

## Changing or removing it

- **Change settings** (time zone, sender, shop name): run `sam deploy --guided` again from `CutFolio/aws` in CloudShell (`git pull` first to get code changes).
- **Turn it all off:** `sam delete --stack-name cutfolio` removes the Lambda, schedule, and logs. Clear `remindersUrl` in `config.js` and the app stops offering to send.

## Troubleshooting

- **"Email service error 403" in the app:** the Function URL is missing its public invoke permission. In CloudShell run
  `aws lambda add-permission --function-name cutfolio-reminders --statement-id UrlInvoke --action lambda:InvokeFunction --principal '*' --invoked-via-function-url`
- **"Email address is not verified":** the account is still in the SES sandbox (step 3), or the From address isn't verified in this region.
- **Reminder times are off by hours:** the `ShopTimeZone` parameter is wrong. Redeploy with the right one.
