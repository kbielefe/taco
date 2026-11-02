# Taco

Private daily log. Meals resolve to USDA amounts, the journal holds observations in kinds you define, and the calorie target is a range. The deployed site is https://health.bielefeldt.dev.

## Run

Copy `.env.example` to `.env` and fill it in. Install the quadlets once, from this directory:

```sh
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/containers/systemd/health-tracker"
ln -sfn "$PWD"/quadlet/* "${XDG_CONFIG_HOME:-$HOME/.config}/containers/systemd/health-tracker/"
systemctl --user daemon-reload
systemctl --user start \
  health-tracker-mongodb.service \
  health-tracker-mongo-express.service \
  health-tracker-web.service \
  health-tracker-cloudflared.service
```

Quadlet generates these units, so `systemctl enable` reports that they are generated. `WantedBy=default.target` already ties them to the user session. They do not start at boot while lingering is off.


The app listens on 127.0.0.1:3001. MongoDB is on 127.0.0.1:27017. mongo-express is on 127.0.0.1:8081. The public site is the Cloudflare tunnel, which calls `http://web:3001` on the `health-tracker` network.

Traces go to Alloy at `http://host.containers.internal:4318`. Alloy forwards them to the shared MLflow Default experiment at [http://mlflow/#/experiments/0/traces](http://mlflow/#/experiments/0/traces). This stack does not run MLflow. `MLFLOW_TRACKING_URI` is only for prompt versions, and in the container it is `http://mlflow:5000`.

The log is the Podman volume `health-tracker_mongodb_data`. Do not delete it.

`npm run dev` is the host process. Its `.env` points OpenTelemetry at `http://127.0.0.1:4318`.

## Redeploy

After a change to the app or the web UI, rebuild the image and recreate the app container. This keeps the volume.

```sh
systemctl --user restart health-tracker-web-build.service health-tracker-web.service
```

Stop the stack without deleting data:

```sh
systemctl --user stop \
  health-tracker-cloudflared.service \
  health-tracker-web.service \
  health-tracker-mongo-express.service \
  health-tracker-mongodb.service
```
