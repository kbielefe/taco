# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One person: the owner. They log meals, weight, and symptoms through the day, on a phone and at a desk. Nobody else has an account.

## Product Purpose

A private daily log the owner can trust the same day. Plain-language meals become nutrient numbers they can check, a journal holds health observations in kinds they define, and a calorie range aims at about 2 lb a week without going too fast. Ask is how they look back. Success is acting on today's log without wondering where the numbers came from.

## Positioning

A calorie counter or a notes app does not do this combination:

- A meal is typed in plain language and resolved to USDA FoodData Central amounts: calories, protein, fat, carbohydrate, and fiber.
- The journal is not a fixed form. The owner adds kinds and fields.
- On a loss day the calorie target is a range. The middle is about 2 lb a week. Both ends move with the previous week so a low day does not force a faster loss. Below a BMI of 25 the target is maintenance, as one number.
- Looking back is a question about this log. When the answer is numeric over time, the chart is the answer.

## Operating Context

The owner uses a phone in portrait, often at about 140% zoom, and a desktop browser. Each sees the other's food and journal entries.

The frequent jobs are logging a meal and logging a journal entry, with very little friction. The quiet column serves that. The owner rarely rereads what was logged, rarely opens Ask, and rarely reads the macros. On calories, the figure they look for is what percentage of the day's recommendation is already used.

Food, Journal, and Ask show today. The browser sends local midnight. The server does not guess a time zone.

Food starts from "What did you eat?" Journal starts from "What do you want to record?" A journal entry may fill any subset of that kind's fields. The first field can fill the rest from the last time that same value was used.

Ask is a conversation in the open browser tab. The transcript is not stored. Refresh clears it.

The deployed site is https://health.bielefeldt.dev.

On Food and Journal, a photo sits only outside the content column. The column itself stays a solid panel. The photo is `web/public/background.jpg`.

## Capabilities and Constraints

### Food

- Nutrition comes from USDA FoodData Central: calories, protein, fat, carbohydrate, and fiber. The labels are Protein, Fat, Carbs, and Fiber. Carbs is the chosen word.
- A meal is removed and logged again. There is no in-place edit.
- Food and Journal have no day picker. There is no installable app.
- When a correction has been learned from weigh-ins, meal rows and today's totals show adjusted calories. The stored meal is not rewritten. The recommendation is still calculated from body size and the previous week's logged intake, not from that correction. The target starts using the correction only after a held-out week predicts weight change better than the log alone. The written rule is `docs/calorie-correction.md`.

### Journal

- A kind has a name and one or more fields. Field types are number (unit stored separately and kept fixed), choice, text, boolean, and event.
- Fields and choice options can be added later. A field's type and unit do not change. Fields are not removed or reordered.
- Kinds the schema has to support include weight, ear buzzing, Nurtec, neck pain, migraine, a cool pack, and ibuprofen. Blood pressure is one kind with two number fields, systolic and diastolic, in mmHg.

### Calorie recommendation

- Body size uses Mifflin–St Jeor and an activity level, from birth year, sex, and height in the environment, plus weight from the journal.
- BMI 25 or higher: lose about 2 lb a week. The middle of the range is that pace. The bottom is the faster of that pace and about 1% of body weight a week, and it never goes under 1,500 kcal for men or 1,200 kcal for women. The top matches that gap unless it would pass maintenance.
- Below BMI 25, including below 18.5, the target is maintenance, as one number.
- The previous 7 logged days slide both ends so the stretch still averages the pace. A day under 800 kcal does not move the range.
- A missing profile or a missing weight shows a plain-language reason and no target number.

### Ask

- Answers come from the owner's food log and journal.
- A change over time is a chart, even when the question does not ask for one. The prose is at most a short sentence and does not restate the chart's numbers. A single fact, a yes or no, or a non-numeric list stays text.

### Access

- Private. When Google sign-in is configured, it is the only way in, for one email address. A shared password is not used. When Google sign-in is not configured, the local app stays open.

### Out of scope

- Other people's accounts, sharing, or a public signup.
- Voice logging. Alexa has been dropped: no skill, no Alexa sign-in, and no spoken meals. Google Home stays out as well.
- A separate journal chart page. Looking across days is Ask.

### Undecided

- The name and the icon may change. No replacement has been chosen.

## Brand Commitments

No name, icon, or voice system is locked.

The interface currently calls itself Taco. The favicon is `web/public/taco_icon.svg`. Document titles are "Taco · Food", "Taco · Journal", and "Taco · Ask". The date is the page heading. The word "Today" is not the heading.

Nutrient labels stay Protein, Fat, Carbs, and Fiber. Carbs is locked. The product name is not.

## Evidence on Hand

The owner's meals, journal kinds, and observations are the content. They live in the private `health` database. Future work must not invent users, testimonials, case studies, pricing, or public results.

`docs/calorie-correction.md` is the written rule for the scale correction.

`web/public/background.jpg` is the photo around the column. `web/public/taco_icon.svg` is the current icon. The icon may be replaced when the name changes.

## Product Principles

1. Trust the same day. A meal shows USDA amounts the owner can check. The labels are Protein, Fat, Carbs, and Fiber.
2. One person, in private. One Google account. No shared password and no public signup.
3. Recording stays quick on a phone, including at about 140% zoom.
4. The calorie range protects the pace. About 2 lb a week at a BMI of 25 or higher, maintenance below that, and a low day does not push the next day too low.
5. Looking back uses this log. When the numbers can be charted, the chart is the answer.

## Accessibility & Inclusion

The owner reads the tracker on a phone in portrait at about 140% zoom. Rows wrap instead of overlapping, and tap targets stay usable at that size. The interface is English. No separate conformance standard was set.
