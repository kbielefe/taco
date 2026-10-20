# Taco

Private daily log. Meals resolve to USDA amounts, the journal holds observations in kinds you define, and the calorie target is a range. The deployed site is https://health.bielefeldt.dev.

## Run

Copy `.env.example` to `.env` and fill it in. From this directory:

```sh
podman compose -p health-tracker up -d --build
```

The app listens on port 3001. MongoDB is published on 27017, MLflow on 127.0.0.1:5000, and mongo-express on 8081.

There are no Quadlets. The stack is Podman Compose. The Compose project name selects the volumes: `health-tracker_mongodb_data` and `health-tracker_mlflow_data`. Those volumes hold the log. A plain `podman compose up` in this directory uses the project name `taco` and a different, empty Mongo volume.

## Redeploy

After a change to the app or the web UI, rebuild and recreate the stack. This keeps the volumes.

```sh
podman compose -p health-tracker up -d --build --force-recreate
```

To rebuild only the app:

```sh
podman compose -p health-tracker up -d --build --force-recreate --no-deps web
```

Stop the stack without deleting data:

```sh
podman compose -p health-tracker down
```

Do not pass `-v`. That deletes the volumes.
