# CutFolio email reminders (AWS)

Clients who have an email on their profile get:

- **A booking confirmation** ("Haircut confirmed") as soon as they're booked (or moved).
- **A 24-hour reminder** ("Haircut reminder"): "You're confirmed for a haircut tomorrow at 2 PM!"
- **An overdue reminder** ("Haircut reminder") when the barber picks them on the Overdue screen: "Your last cut was on September 28… Here's when I have openings: Saturday 12–4 PM, Sunday 4–8 PM."

Emails come from Lucas, are signed "Lucas", and point clients to Instagram for changes.

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
   every 15 minutes          Gmail (free) or Amazon SES ──► client's inbox
   {"job":"reminders"}
```

- **One Lambda** (`reminders/index.mjs`) handles all three emails. It uses the AWS SDK that ships with the Lambda runtime, plain `fetch` for Supabase, and Nodemailer for Gmail.
- **Sending:** with a Gmail app password set, emails go out through that Gmail account. That's free, and the emails pass Gmail's sender checks, so they land in the inbox. Leave the password blank and it sends through Amazon SES instead, which is the better choice once there's a domain to send from (see *Switching to SES later*).
- **EventBridge Scheduler** runs it every 15 minutes. Each run finds bookings starting in the next 24 hours and sends each one reminder. A unique index in the `emails` table makes double-sends impossible even if two runs overlap, and bookings made less than a day ahead are skipped because the confirmation already covers them.
- **The app** calls the Lambda's Function URL with the barber's Supabase login token. The Lambda checks that token with Supabase before it reads or sends anything, and only touches that barber's rows.
- **Secrets** (the Supabase secret key and Gmail app password) live only in the Lambda's environment. The app and the repo never see them.
- **Infrastructure as code:** everything is in `template.yaml` (AWS SAM), so the whole stack deploys or deletes with one command.

## Cost

Checked against AWS pricing pages in October 2026:

| Service | Free allowance | CutFolio's use |
| --- | --- | --- |
| Lambda | 1M requests + 400,000 GB-seconds a month | ~3,000 runs a month |
| EventBridge Scheduler | 14M invocations a month | ~2,900 a month |
| Sending through Gmail | Free, up to 500 emails a day | ~300 emails a month |
| CloudWatch Logs | 5 GB a month | a few MB, kept 14 days |

Sent through Gmail, the whole setup costs $0. (SES, if you switch later, is $0.10 per 1,000 emails.)

## Setup (about 20 minutes)

Do every step in the **same AWS region**. Pick one near you in the top-right region menu (for example *US East (N. Virginia)*) and stay in it.

### 1. AWS account and a spending alert

1. Sign up at aws.amazon.com (choose the **Free** plan) or sign in.
2. Open **Billing and Cost Management → Budgets → Create budget**, pick the **Zero spend budget** or a **$1 monthly cost budget**, and enter your email. You'll hear about it if anything ever costs money.

### 2. A Gmail app password

Emails are sent from a Gmail account, and clients see that address. CutFolio uses `lucasfadez.donotreply@gmail.com`, an account nobody checks. Every email says it's automated and points clients to Instagram instead.

1. Sign in to that Gmail account and turn on **2-Step Verification** (Google Account → Security).
2. Open **myaccount.google.com/apppasswords**, name it `CutFolio`, and copy the 16-character password. You'll paste it in step 4.

The app password only lets CutFolio send email as that account. You can revoke it on the same page any time.

### 3. Supabase

1. **SQL Editor → New query**, paste all of `supabase/reminders.sql`, and press **Run**.
2. **Project Settings → API Keys → Secret keys**: create or reveal a secret key (`sb_secret_…`) and keep it handy for the next step. It goes into AWS only. Never put it in `config.js` or the repo.

### 4. Deploy the Lambda + schedule (AWS CloudShell)

CloudShell is a terminal in the AWS console with the AWS and SAM command-line tools already installed. Click the **>_** icon in the top bar, then run:

```bash
git clone https://github.com/ashishkarkee/CutFolio.git
cd CutFolio/aws
sam build
sam deploy --guided
```

Answer the prompts:

| Prompt | Answer |
| --- | --- |
| Stack Name | `cutfolio` |
| AWS Region | the region you picked |
| SupabaseUrl | `https://euohjxiopeufjqtsrugm.supabase.co` |
| SupabaseSecretKey | the `sb_secret_…` key (it won't show as you paste) |
| FromEmail | press Enter for `lucasfadez.donotreply@gmail.com` |
| GmailAppPassword | the 16-character app password from step 2 (it won't show as you paste) |
| ReplyToEmail | press Enter (replies go to the Gmail address) |
| BarberName | press Enter for `Lucas` (signs the emails and shows as the sender) |
| InstagramHandle | press Enter for `lucasfadez` (linked under the signature) |
| ShopAddress | optional, shown in confirmations and reminders |
| ShopTimeZone | press Enter for `America/Los_Angeles` (California) |
| AppOrigin | press Enter for `https://ashishkarkee.github.io` |
| Confirm changes before deploy | `N` |
| Allow SAM CLI IAM role creation | `Y` |
| Disable rollback | `N` |
| RemindersFunction Function Url has no authentication. Is this okay? | `y` (the function checks the barber's login itself) |
| Save arguments to configuration file | `Y` |

When it finishes, it prints **RemindersUrl**, something like `https://abc123.lambda-url.us-east-1.on.aws/`.

`samconfig.toml` (the saved answers) stays in CloudShell. Don't commit it.

### 5. Connect the app

Put the RemindersUrl into `config.js` as `remindersUrl` (it isn't secret), bump the `?v=` numbers in `index.html`, and push. Or send it to Claude in the CutFolio project and it'll do it.

### 6. Test

1. In CutFolio, open a test client, add **your own email**, and book them for tomorrow. A confirmation should arrive within seconds, and the booking shows *confirmed*.
2. Book a test client for a little over 24 hours from now. Within 15 minutes of it crossing the 24-hour mark, the reminder arrives and the profile shows *24-hour reminder sent*.
3. On **Overdue**, pick the test client, tap a day or two for openings, and send.

Logs for every run are in **CloudWatch → Log groups → /aws/lambda/cutfolio-reminders**.

## Changing or removing it

- **Change settings** (time zone, sender, Instagram): run `sam build && sam deploy --guided` again from `CutFolio/aws` in CloudShell (`git pull` first to get code changes).
- **Turn it all off:** `sam delete --stack-name cutfolio` removes the Lambda, schedule, and logs. Clear `remindersUrl` in `config.js` and the app stops offering to send.

## Troubleshooting

- **"Email service error 403" in the app:** the Function URL is missing its public invoke permission. In CloudShell run
  `aws lambda add-permission --function-name cutfolio-reminders --statement-id UrlInvoke --action lambda:InvokeFunction --principal '*' --invoked-via-function-url`
- **"Invalid login" / "Username and Password not accepted":** the Gmail app password is wrong or was revoked, or FromEmail isn't the account it belongs to. Make a new app password and redeploy.
- **Reminder times are off by hours:** the `ShopTimeZone` parameter is wrong. Redeploy with the right one.

## Switching to SES later

If Lucas ever gets a domain (about $10 a year), Amazon SES is the more professional sender: emails come from something like `bookings@lucascuts.com`, and nothing about the app changes.

1. **Amazon SES → Identities → Create identity → Domain**, keep *Easy DKIM*, and add the three CNAME records it shows at the domain's DNS.
2. **SES → Account dashboard → Request production access.** Choose *Transactional* and explain that these are appointment confirmations and reminders for one barber's clients, with one-click unsubscribe in every email. New SES accounts can only email verified addresses until AWS approves this, usually within a day.
3. Redeploy with FromEmail set to an address on the domain and **GmailAppPassword left blank**.

Don't use SES with a Gmail From address. Gmail marks mail "from" @gmail.com that wasn't sent by Google as failing its sender checks, so it lands in spam.
