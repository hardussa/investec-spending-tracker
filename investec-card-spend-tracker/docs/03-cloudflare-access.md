# 03. Cloudflare Access: email sign-in, service token and the two Access apps

This is the longest guide and the one where mistakes cost the most time. Take it one step at a time and do every **Checkpoint**.

**Time:** 30 to 45 minutes.
**Starts from:** a deployed Worker (guide 02). **Ends with:** a locked-down app you can sign in to with an emailed code, and a card that can report spend.

> Cloudflare changes its dashboard regularly. Menu names below were checked against Cloudflare's documentation, but if a label differs slightly, find the closest match. Cloudflare's own pages, linked throughout, are the source of truth.

---

## The idea: two doors, two kinds of visitor

Your Worker has two kinds of visitor, and they cannot sign in the same way.

| Visitor | How they prove who they are | Cloudflare feature |
| --- | --- | --- |
| **You** (a person, in a browser) | An emailed one-time code | An Access application with an **Allow** policy and **One-time PIN** login |
| **The card code** (a program, no browser) | A pair of secret headers | An Access application with a **Service Auth** policy and a **service token** |

So you create **two Access applications** on the same Worker address:

| | App 1: people | App 2: card |
| --- | --- | --- |
| Covers | the whole address: `YOUR-HOST` | only the path: `YOUR-HOST/api/card` |
| Policy action | **Allow** | **Service Auth** |
| Who gets in | specific email addresses | one service token |

Cloudflare applies the **most specific** matching rule first. Its documentation says path-based Access applies before broader rules, so requests to `/api/card` are judged by App 2 and everything else by App 1. You will prove this with a test at the end of the guide.

On top of this, the Worker **re-checks everything itself** (it validates the Access token's signature, expiry, issuer, audience and email, and checks the card's shared secret). Access is the first lock, not the only one. See [06-security.md](06-security.md).

You will end up with three values to copy into the Worker, and one pair for the card:

| Value | Where it comes from | Goes into |
| --- | --- | --- |
| **Team name** | Step 1 | Worker secret `ACCESS_TEAM` |
| **AUD tag** of App 1 | Step 4 | Worker secret `ACCESS_AUD` |
| **Allowed emails** | you decide | Worker secret `ALLOWED_EMAILS` |
| **Service token ID and secret** | Step 7 | the card's `env.json` |

---

## Step 1: Create your Zero Trust organization

Zero Trust is the part of Cloudflare that contains Access.

1. In the Cloudflare dashboard, open **Zero Trust**. (Direct link: <https://one.dash.cloudflare.com>.)
2. On the onboarding screen, **choose a team name**. Cloudflare describes it as a unique identifier for your organization. It becomes the first part of your login address, `<team-name>.cloudflareaccess.com`.
   - Use lowercase letters, digits and dashes. Short is fine: `your-team`.
   - The team name is **not a secret** (it appears in login URLs), but you will type it into a Worker secret, so write it down.
3. **Choose the Zero Trust Free plan.** Cloudflare still asks you to enter payment details to complete onboarding. Cloudflare's documentation states that you are not charged on the Free plan. If you are not comfortable with this, stop here: Access is required by this project's design.

**Checkpoint:** you can see the Zero Trust dashboard. Your team name is shown under **Settings**, in the "Team name and domain" area.

Reference: [Create a Zero Trust organization](https://developers.cloudflare.com/learning-paths/zero-trust-web-access/initial-setup/create-zero-trust-org/).

---

## Step 2: Turn on email one-time PIN sign-in

A new Zero Trust organization uses Cloudflare's own login by default. **One-time PIN is not switched on automatically**, so add it:

1. Go to **Zero Trust**, then **Integrations**, then **Identity providers**.
2. Under **Your identity providers**, select **Add new identity provider**.
3. Choose **One-time PIN**.

**Checkpoint:** "One-time PIN" appears in your list of identity providers.

How it works for the person signing in: they enter their email address and select **Send login code**. If their address is allowed by a policy, Cloudflare emails a PIN that is valid for 10 minutes and works once. If their address is not allowed, no email is sent, but the page still says a code was emailed. That is deliberate, so outsiders cannot discover which addresses are on your list.

Reference: [One-time PIN login](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/).

---

## Step 3: Create App 1, the people app

1. Go to **Zero Trust**, then **Access controls**, then **Applications**.
2. Select **Create new application**.
3. Choose **Self-hosted and private**.
4. Name it something clear, for example `Spend tracker: people`.
5. **Add a public hostname** and enter your Worker's address, `YOUR-HOST` (for example `spend-tracker.your-subdomain.workers.dev`). Leave any path blank, so it covers the whole address.

   > **If your `workers.dev` address is not offered in the Domain list:** Cloudflare's documentation says a `workers.dev` hostname can be used as an application's domain. Look for an option to type or switch to a custom hostname and enter it in full. Labels change, so if you cannot find it, use the alternative in [Appendix A](#appendix-a-alternative-protect-the-worker-in-one-click) instead.

6. Under **Access policies**, create a new policy:
   - **Name:** `Approved people`
   - **Action:** `Allow`
   - **Include:** selector **Emails**, then add each person's address (yours, and anyone who should have access).

   Access applications deny everyone by default. Only a visitor who matches an Allow policy gets in.
7. Under **login methods** (identity providers), select **One-time PIN**. Untick the others so people are not offered a login they cannot complete.
8. Choose a **Session duration**. This is how long a sign-in lasts before the person must request a new code. Longer is more convenient; shorter is safer if a phone is lost. A few days is a sensible starting point. When a session ends the app shows "Your session ended. Sign in again to carry on."
9. Select **Create**.

**Checkpoint:** the application appears in the Applications list.

Reference: [Publish a self-hosted application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/).

---

## Step 4: Copy App 1's AUD tag

The AUD ("audience") tag identifies this specific application. The Worker uses it to confirm a sign-in token was issued for *this* app and not another.

1. In **Access controls**, then **Applications**, select App 1 and choose **Configure**.
2. Open the **Overview** tab.
3. Copy the value labelled **Application Audience (AUD) Tag**. It is a long string of letters and digits.

Keep it handy for the next step. It is an identifier rather than a password, but treat it as private configuration.

> **Copy it from App 1, the people app.** Not from the card app you create later. Using the wrong app's tag is the most common reason for a sign-in loop. See [07-troubleshooting.md](07-troubleshooting.md).

---

## Step 5: Give the Worker its Access secrets

You need three values: your **team name** (Step 1), the **AUD tag** (Step 4), and the **allowed emails**.

From the project folder, run each command and paste the value when prompted:

```bash
npx wrangler secret put ACCESS_TEAM
```
Enter only the team name, for example `your-team`. **Not** `your-team.cloudflareaccess.com`, and not a URL.

```bash
npx wrangler secret put ACCESS_AUD
```
Enter the AUD tag from Step 4.

```bash
npx wrangler secret put ALLOWED_EMAILS
```
Enter the same addresses as your policy, separated by commas, for example `alex@example.com,sam@example.com`. Spaces and capital letters are ignored.

Why both a policy *and* `ALLOWED_EMAILS`? They are two independent locks. If the Access policy were ever loosened by mistake, the Worker would still refuse everyone not on its own list. If you leave `ALLOWED_EMAILS` empty, the Worker relies on the Access policy alone.

Secrets take effect within seconds; you do not need to redeploy.

---

## Step 6: Test the people door

1. Open a **private/incognito window** (so no old sign-in interferes).
2. Go to `https://YOUR-HOST/`.
3. You should see Cloudflare's sign-in page. Enter an address from your policy and select **Send login code**.
4. Check that mailbox. The email comes from Cloudflare's `notify.cloudflare.com` sender. Check spam if it does not arrive within a minute.
5. Enter the code. The spend tracker should load.

**Checkpoint:** the app opens, and the **Setup** tab shows who you are signed in as.

Now test the lock:

- Try an email address that is **not** on your list. No email should arrive.
- Visit `https://YOUR-HOST/api/state` in a window where you are not signed in. You should be sent to the Cloudflare sign-in page, not shown any data.

If something fails here, go to [07-troubleshooting.md](07-troubleshooting.md) before continuing.

---

## Step 7: Create the service token for the card

The card code cannot receive an emailed code, so it presents a **service token**: a Client ID and a Client Secret that Cloudflare issues.

1. Go to **Zero Trust**, then **Access controls**, then **Service credentials**, then **Service Tokens**.
2. Select **Create Service Token**.
3. Name it `spend-tracker-card` and choose a **duration**.
4. Create it. Cloudflare shows a **Client ID** and a **Client Secret**.

   > **The Client Secret is shown only once.** Copy both values into your password manager immediately. If you lose the secret you must create a new token.

5. **Write down the expiry date** and set a calendar reminder a week before it. When a token expires, the card's reports are refused and **tracking stops silently**. The card code logs a message, but nobody is reading those logs. Rotating takes five minutes if you plan for it.

**Checkpoint:** the token appears in the Service Tokens list with an expiry date.

Reference: [Service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/).

---

## Step 8: Create App 2, the card app

1. Back in **Access controls**, then **Applications**, select **Create new application**, then **Self-hosted and private**.
2. Name it `Spend tracker: card`.
3. Enter the same hostname as App 1, **and set the path to `/api/card`**. The application's address is `YOUR-HOST/api/card`.
4. Create a new policy:
   - **Name:** `Card service token`
   - **Action:** **`Service Auth`**. Cloudflare's documentation states the action must be Service Auth for service tokens, not Allow.
   - **Include:** selector **Service Token**, then choose `spend-tracker-card`.
5. Open **Additional settings** and turn on **401 Response for Service Auth policies**. This makes a missing or wrong token return a plain `401`, instead of redirecting to a login page that a program cannot use. It makes problems much easier to diagnose.
6. Select **Create**.

You do not need to copy this app's AUD tag. The Worker authenticates the card with its shared secret, not with an Access token.

**Checkpoint:** both applications are listed: one for the whole address, one for the `/api/card` path.

---

## Step 9: Prove both doors work

This test is not optional. It is how you confirm that Cloudflare is applying the path-specific rule, and that the card path is locked.

You will use `curl` from a terminal. To keep secrets out of your shell history, load them into variables with `read -s`, which does not echo what you paste. (Use Git Bash or WSL on Windows.)

```bash
HOST=your-worker-host.workers.dev        # no https://, no path
read -rs CF_ID;     echo                 # paste the service token Client ID, press Enter
read -rs CF_SECRET; echo                 # paste the service token Client Secret, press Enter
read -rs CARD_KEY;  echo                 # paste your CARD_KEY, press Enter
```

**Test A: no credentials at all. Expect a 401 from Cloudflare.**

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST "https://$HOST/api/card"
```

Expected: `401`. (Without the "401 Response" setting from Step 8 you would see a `302` redirect instead.) If you get `200` or something from your Worker, **stop**: the card path is not protected.

**Test B: a valid service token but no card key. Expect a 401 from the Worker.**

```bash
curl -s -X POST "https://$HOST/api/card" \
  -H "CF-Access-Client-Id: $CF_ID" \
  -H "CF-Access-Client-Secret: $CF_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"v":2,"mcc":"5812","name":"Setup test","amount":1,"currency":"zar"}'
```

Expected: `{"error":"unauthorised"}`. That JSON comes from your Worker, which means the token got through Access and the Worker's own shared-secret check then correctly refused it.

**Test C: both. Expect success.**

```bash
curl -s -X POST "https://$HOST/api/card" \
  -H "CF-Access-Client-Id: $CF_ID" \
  -H "CF-Access-Client-Secret: $CF_SECRET" \
  -H "x-card-key: $CARD_KEY" \
  -H "Content-Type: application/json" \
  -d '{"v":2,"mcc":"5812","name":"Setup test","amount":1,"currency":"zar"}'
```

Expected: something like `{"ok":true,"category":"dining","via":"mcc","pending":false,"remaining":2999}`.

This created a real R1 test entry called "Setup test". **Open the app and delete it** (on the **Log** tab).

Clean up your variables:

```bash
unset CF_ID CF_SECRET CARD_KEY
```

| Test | A good result tells you |
| --- | --- |
| A returns 401 | The `/api/card` path is locked to outsiders. |
| B returns the Worker's JSON 401 | Access accepts the token; the Worker still demands the shared secret. |
| C returns `ok` | The whole chain works. The card will be able to report. |

---

## Step 10: Carry on to the card

You now have what the card needs. Continue to [04. Investec card setup](04-investec-card.md), where the following values go into the card's `env.json`:

- the Worker address
- the `CARD_KEY` value (the same one you set as a Worker secret)
- the service token Client ID and Client Secret

---

## Things worth knowing

**Other addresses reach the same Worker.** Besides your `workers.dev` address, Cloudflare Workers also have preview and version URLs on different hostnames. A hostname-based Access application does not cover those. They expose nothing: the Worker checks the Access token itself, so `/api/*` refuses unauthenticated callers on any address, and `/api/card` still needs the shared secret. For extra assurance you can also protect previews with Cloudflare's Worker-level Access ("Previews only"); see [Cloudflare's Workers Access documentation](https://developers.cloudflare.com/workers/configuration/cloudflare-access/).

**Adding or removing a person.** Edit the `Approved people` policy in App 1, and update `ALLOWED_EMAILS` with `npx wrangler secret put ALLOWED_EMAILS`. Do both.

**Rotating the service token.** Create a new token, update App 2's policy to use it, put the new ID and secret into the card's `env.json`, then delete the old token. Do this before the old one expires.

**Signing in on a new phone.** Open the address, request a code, enter it. You can then add the page to your home screen.

---

## Appendix A: Alternative, protect the Worker in one click

Cloudflare also lets you protect a Worker directly: in **Workers & Pages**, select your Worker, open its **Access** tab and choose **Protect this Worker behind Access** with the **All traffic** option. The dialog offers a choice of policy (for example, members of your Cloudflare account or an email domain); for specific individual addresses, edit the resulting Access application afterwards in Zero Trust.

If you use this route you still need **App 2** (Steps 7 and 8) for the card, and you must take the **AUD tag from the Access application that protects the people**, wherever you find it. Cloudflare documents the hierarchy as hostname- or path-based Access first, then Worker-level Access, so App 2 still takes precedence for `/api/card`.

Details: [Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/).

---

## Next

[04. Investec card setup](04-investec-card.md)
