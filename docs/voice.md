# Voice

Taco logs food and reads today's totals by voice through a private Alexa skill. The skill runs on the existing app at `https://health.bielefeldt.dev/api/alexa`. It is not published in the Alexa skill store.

## Google

Google has no equivalent of a custom Alexa skill. Conversational Actions, also called Actions on Google, shut down on 13 June 2023. "Hey Google, tell Taco I ate a banana" cannot be built.

The product that replaced it is Google Home cloud-to-cloud. That only controls devices (lights, sensors, and similar). It cannot take a spoken meal description. Taco does not ship a Google Home integration.

Use the website or Alexa to log food and to hear today's calories.

## Alexa

Create the skill in the [Alexa developer console](https://developer.amazon.com/alexa/console/ask). Keep it in development. Do not submit it for certification.

### App before the console

The skill cannot reach the app until login is on and Cloudflare Access is off that hostname. Amazon does not send Access service-token headers.

1. In Google Cloud, create an OAuth client (web application) for the website. Add redirect URIs for the public host and for local dev, both ending in `/oauth/google/callback`.
2. In `.env`, set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `ALLOWED_EMAIL`. Set `ALEXA_SKILL_ID`, `ALEXA_CLIENT_ID`, and `ALEXA_CLIENT_SECRET`. You choose the Alexa client id and secret. They are only in `.env` and in the Alexa console. The skill does not use the Google client.
3. On an existing database, run `npm run mongo:grant-oauth` so the app can store sessions and Alexa tokens. A new volume gets that role from `mongo-init`.
4. Turn off the Cloudflare Access application for `health.bielefeldt.dev`. Rebuild the web container so it is running this code.

### Skill

1. Create a custom skill. Name it Taco. Language English (US). Invocation name `taco`.
2. Build the interaction model from `skill/interaction-model.json`.
3. Set the default endpoint to `https://health.bielefeldt.dev/api/alexa` (HTTPS). Copy the skill id from the console into `ALEXA_SKILL_ID`.

The model has two intents:

- Log a meal: "Alexa, tell Taco I ate a banana."
- Today's totals: "Alexa, ask Taco what I have left" and "Alexa, ask Taco how many calories I've had today."

### Account linking

In the skill's account linking settings, choose Auth Code Grant.

| Setting | Value |
| --- | --- |
| Authorization URI | `https://health.bielefeldt.dev/oauth/authorize` |
| Access Token URI | `https://health.bielefeldt.dev/oauth/token` |
| Client ID | `ALEXA_CLIENT_ID` |
| Client secret | `ALEXA_CLIENT_SECRET` |
| Scope | leave empty |

Alexa redirects to these URLs. Allow all three:

- `https://pitangui.amazon.com/api/skill/link/`
- `https://layla.amazon.com/api/skill/link/`
- `https://alexa.amazon.co.jp/api/skill/link/`

The Alexa app does not sign in with Google. Sign in on the Taco website, choose Connect Alexa, and enter that short code when Alexa asks for it. The code lasts about ten minutes.

### Try it

Enable the skill on the same Amazon account and link it with the code.

- "Alexa, tell Taco I ate a banana."
- "Alexa, ask Taco what I have left."

A slow food lookup answers that it is still logging. Ask again in a moment. The same Alexa request is not logged twice. "Today" is the device's time zone, from local midnight to the next midnight.
