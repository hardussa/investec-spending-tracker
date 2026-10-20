# 05. How spend is allocated

Every card transaction takes the same route. Understanding it lets you predict where a purchase will land, and fix it when it lands somewhere unexpected.

---

## The route

```
card reports: merchant code, name, amount, currency
        │
        ▼
1. Does a MERCHANT RULE match the name?  ──yes──►  that category
        │ no
        ▼
2. Is the MERCHANT CODE in the table below?  ──yes──►  that category
        │ no
        ▼
3. Ignored. Not stored.
```

If a category is found, the entry is then checked for **duplicates** and, if the currency is not rand, held as **pending**. Then it is stored.

---

## 1. Merchant codes

A merchant category code (MCC) is a four-digit code that a card network assigns to every merchant. The Worker's table (`MCC_RANGES` in `src/worker.js`) is:

### Eating out

| Code | Meaning |
| --- | --- |
| 5811 | Caterers |
| 5812 | Restaurants |
| 5813 | Bars, taverns and nightclubs |
| 5814 | Fast food |
| 5462 | Bakeries |

### Holiday

| Code(s) | Meaning |
| --- | --- |
| 3000 to 3299 | Airlines (individual carriers) |
| 3351 to 3441 | Car rental companies (individual brands) |
| 3501 to 3838 | Hotels, motels and resorts (individual brands) |
| 4411 | Cruise lines |
| 4457 | Boat rentals and leasing |
| 4511 | Airlines and air carriers |
| 4722 | Travel agencies and tour operators |
| 7011 | Lodging: hotels, motels, resorts |
| 7012 | Timeshares |
| 7032 | Sporting and recreation camps |
| 7033 | Trailer parks and campgrounds |
| 7512 | Car rental agencies |
| 7519 | Motor home and RV rentals |

### Clothing

| Code(s) | Meaning |
| --- | --- |
| 5611 | Men's and boys' clothing |
| 5621 | Women's ready-to-wear |
| 5631 | Women's accessories and specialty |
| 5641 | Children's and infants' wear |
| 5651 | Family clothing |
| 5655 | Sports and riding apparel |
| 5661 | Shoe stores |
| 5681 | Furriers |
| 5691 | Men's and women's clothing stores |
| 5697 to 5699 | Tailors and alterations, wig shops, miscellaneous apparel |

These descriptions follow common MCC conventions. Investec publishes its own list through the API's reference data (`GET /za/v1/cards/merchants`), which is the authority for what a given code means to Investec.

### What is deliberately not in the table

Groceries, fuel, pharmacies, department stores, online marketplaces, taxis, tolls and local transport are **not** tracked. A department store sells clothing and groceries under one code, so no table can sort it correctly. Use a merchant rule (below) if you want one tracked.

Taxis, buses and trains are also left out because they are mostly commuting. If you travel on holiday by train, move those entries by hand.

---

## 2. Merchant rules

Merchant codes are blunt. A rule is your own override that wins over the table.

A rule is a **fragment of the merchant name** and a **category**. Add rules in the app under **Setup**, then **Merchant rules**.

How matching works:

1. The merchant name and the rule are both **normalised**: lowercased, with every run of anything other than letters and digits turned into a single space.
2. A rule matches when the normalised merchant name **contains** the normalised rule.
3. If several rules match, the **longest** wins, so a specific rule beats a general one.
4. A rule must be 3 to 30 characters after normalising. You can have 50 rules.

Examples:

| Rule | Category | Merchant name on your statement | Matches? |
| --- | --- | --- | --- |
| `woolworths` | clothing | `WOOLWORTHS CAPE TOWN 1234` | yes |
| `woolworths` | clothing | `SQ *Woolworths-Canal Walk` | yes (punctuation is ignored) |
| `hotel bar` | dining | `The Hotel Bar & Grill` | yes (beats the hotel's lodging code) |
| `spur` | dining | `Spurious Books` | **yes, which is probably not what you want** |

The last row is the main thing to be careful of: matching is "contains", not "whole word". Use a fragment long enough to be unambiguous.

Rules apply to **new** card spend. They do not rewrite entries already stored; use Move for those.

---

## 3. Fixing a wrong category: Move

Every entry in the app has a **⇄** control. Choose a destination category and the entry moves, keeping its date, amount and name. This works for card entries and manual entries alike.

Moving is only a correction. To make the correction automatic next time, add a merchant rule. (After a move the app reminds you of this.)

A move cannot lose an entry: if the destination is full (500 entries in a pot, 400 in a month) the move is refused and the entry stays where it was.

---

## 4. Foreign currency: pending until you confirm

Investec's transaction payload carries a currency code next to the amount, but **no rand equivalent**. So when the currency is anything other than rand, the Worker does not guess:

1. The entry is stored as **pending**, counting as **R0**, with the original currency and amount kept alongside.
2. In the app it shows a button such as **`EUR 840.50 · set R`**, and the list heading notes "1 awaiting a rand amount".
3. You tap it and type what your bank statement says it cost in rand. A comma or a dot is fine as the decimal mark.
4. It now counts like any other entry. The original currency and amount are kept for reference.

While an entry is pending it does not reduce any balance. If you forget, your holiday pot looks healthier than it is.

The card code also **never checks foreign spend against a budget**, because a EUR figure cannot be compared with a rand budget.

---

## 5. Duplicates

Investec can report a transaction more than once, and the card code may retry. The Worker treats a card report as a duplicate when **the same merchant name, the same day and the same amount** was recorded **in the last two minutes**, in **any** category. It is then acknowledged but not stored a second time.

Why not use the transaction's `reference` field? Because Investec's simulator sets it to the literal text `simulation` for every transaction, and it is not documented as unique.

Why check all categories, not just the destination? Because if you Move an entry and the card then retries, the retry must not put a second copy back in the original category.

One consequence while testing: simulating the **same** merchant and amount twice within two minutes records it once. Vary the amount, or wait.

---

## 6. The eating-out budget

Eating out works month by month:

- You set a **monthly budget** (default R3,000). Changing it applies from this month on; past months keep the figure they had.
- **Unspent money rolls into next month.** Overspending rolls forward as a deficit if "carry deficit" is on in **Setup**, otherwise next month starts clean.
- **Move the surplus** parks part of this month's leftover in the **weekend pot**. Pot money stops rolling and just accumulates.
- **Splurges** are named prices (for example "Weekend away, R2,500"). The app checks each against this month's remainder first, then against the pot.

---

## 7. Holiday and clothing pots

These work differently from eating out, and are meant for money you build up over time and spend in lumps.

- A pot has a **monthly amount** and a **start month**. Each month adds the monthly amount.
- It **never resets in January.** Five years of an untouched pot is a real balance.
- **Available = built up so far, minus everything spent from it.** It can go negative. That is a signal, not a block; nothing here can stop a purchase.
- Changing the monthly amount affects **this month onward only.** The Worker stores a list of rate changes rather than one number, so history is never rewritten.

Worked example. Clothing builds R500 a month from January 2026, and you raise it to R700 from January 2027:

| Period | Months | Earned |
| --- | --- | --- |
| Jan 2026 to Dec 2026 | 12 at R500 | R6,000 |
| Jan 2027 to Mar 2027 | 3 at R700 | R2,100 |
| **Built up by end of March 2027** | | **R8,100** |

If you had instead multiplied one rate over all 15 months you would get R7,500 or R10,500, and both would be wrong. A start month earlier than today is allowed, which lets a pot claim months it was quietly building before you installed the app.

---

## 8. Dates and time

The Worker works in **South African Standard Time (UTC+2)**. A purchase at 00:30 on the 1st is filed under the new month, not the old one. The card code sends no date at all, deliberately: the Worker stamps it, so a UTC date from the card can never put the first two hours of a month in the wrong place.

To use a different timezone, see [08-customising.md](08-customising.md#timezone).

---

## Quick reference: where did my purchase go?

| Situation | What happens |
| --- | --- |
| Restaurant, bar, fast food, bakery | Eating out |
| Flight, hotel, car hire, travel agent | Holiday |
| Clothing or shoe shop | Clothing |
| Supermarket, fuel, pharmacy | Ignored (add a rule to track it) |
| Anything in a foreign currency | Stored as pending at R0 until you set the rand amount |
| Same purchase reported twice within two minutes | Stored once |
| Merchant matches one of your rules | The rule's category, whatever the code says |
| Wrong category | Use ⇄ Move, then add a rule |
