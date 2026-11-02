#!/bin/sh
# Turn %h/source/taco/.env into a podman --env-file. systemd does not expand
# ${VAR} inside Environment=, and the container must not inherit the host
# Mongo URL or the host Alloy address.
# Usage: render-env.sh mongodb|express|web|cloudflared DEST
set -eu

mode=${1:?mode}
dest=${2:?dest}
envfile=${TACO_ENV_FILE:-${HOME}/source/taco/.env}

MONGO_ROOT_USERNAME=
MONGO_ROOT_PASSWORD=
MONGO_CACHE_USERNAME=
MONGO_CACHE_PASSWORD=
USDA_API_KEY=
XAI_API_KEY=
XAI_REASONING_EFFORT=
XAI_ASK_REASONING_EFFORT=
BIRTH_YEAR=
SEX=
HEIGHT_IN=
HEIGHT_CM=
ACTIVITY=
CLOUDFLARE_TUNNEL_TOKEN=

if [ ! -f "$envfile" ]; then
  echo "missing $envfile" >&2
  exit 1
fi

while IFS= read -r line || [ -n "$line" ]; do
  case $line in
    '' | '#'*) continue ;;
  esac
  key=${line%%=*}
  val=${line#*=}
  case $val in
    \"*\") val=${val#\"}; val=${val%\"} ;;
    \'*\') val=${val#\'}; val=${val%\'} ;;
  esac
  case $val in
    *'
'*)
      echo "$key contains a newline" >&2
      exit 1
      ;;
  esac
  case $key in
    MONGO_ROOT_USERNAME) MONGO_ROOT_USERNAME=$val ;;
    MONGO_ROOT_PASSWORD) MONGO_ROOT_PASSWORD=$val ;;
    MONGO_CACHE_USERNAME) MONGO_CACHE_USERNAME=$val ;;
    MONGO_CACHE_PASSWORD) MONGO_CACHE_PASSWORD=$val ;;
    USDA_API_KEY) USDA_API_KEY=$val ;;
    XAI_API_KEY) XAI_API_KEY=$val ;;
    XAI_REASONING_EFFORT) XAI_REASONING_EFFORT=$val ;;
    XAI_ASK_REASONING_EFFORT) XAI_ASK_REASONING_EFFORT=$val ;;
    BIRTH_YEAR) BIRTH_YEAR=$val ;;
    SEX) SEX=$val ;;
    HEIGHT_IN) HEIGHT_IN=$val ;;
    HEIGHT_CM) HEIGHT_CM=$val ;;
    ACTIVITY) ACTIVITY=$val ;;
    CLOUDFLARE_TUNNEL_TOKEN) CLOUDFLARE_TUNNEL_TOKEN=$val ;;
  esac
done < "$envfile"

require() {
  if [ -z "$2" ]; then
    echo "$1 is unset in $envfile" >&2
    exit 1
  fi
}

# Userinfo in a Mongo URL. Prints the encoded value and nothing else.
urlencode() {
  python3 -c 'import urllib.parse, sys; sys.stdout.write(urllib.parse.quote(sys.argv[1], safe=""))' "$1"
}

umask 077
tmp=${dest}.tmp
case $mode in
  mongodb)
    require MONGO_ROOT_USERNAME "$MONGO_ROOT_USERNAME"
    require MONGO_ROOT_PASSWORD "$MONGO_ROOT_PASSWORD"
    require MONGO_CACHE_USERNAME "$MONGO_CACHE_USERNAME"
    require MONGO_CACHE_PASSWORD "$MONGO_CACHE_PASSWORD"
    {
      printf 'MONGO_INITDB_ROOT_USERNAME=%s\n' "$MONGO_ROOT_USERNAME"
      printf 'MONGO_INITDB_ROOT_PASSWORD=%s\n' "$MONGO_ROOT_PASSWORD"
      printf 'MONGO_INITDB_DATABASE=health\n'
      printf 'MONGO_CACHE_USERNAME=%s\n' "$MONGO_CACHE_USERNAME"
      printf 'MONGO_CACHE_PASSWORD=%s\n' "$MONGO_CACHE_PASSWORD"
    } > "$tmp"
    ;;
  express)
    require MONGO_ROOT_USERNAME "$MONGO_ROOT_USERNAME"
    require MONGO_ROOT_PASSWORD "$MONGO_ROOT_PASSWORD"
    {
      printf 'ME_CONFIG_MONGODB_ADMINUSERNAME=%s\n' "$MONGO_ROOT_USERNAME"
      printf 'ME_CONFIG_MONGODB_ADMINPASSWORD=%s\n' "$MONGO_ROOT_PASSWORD"
      printf 'ME_CONFIG_MONGODB_URL=mongodb://%s:%s@mongodb:27017/?authSource=admin\n' \
        "$(urlencode "$MONGO_ROOT_USERNAME")" \
        "$(urlencode "$MONGO_ROOT_PASSWORD")"
      printf 'ME_CONFIG_BASICAUTH=false\n'
    } > "$tmp"
    ;;
  web)
    require MONGO_CACHE_USERNAME "$MONGO_CACHE_USERNAME"
    require MONGO_CACHE_PASSWORD "$MONGO_CACHE_PASSWORD"
    require USDA_API_KEY "$USDA_API_KEY"
    {
      printf 'HOST=0.0.0.0\n'
      printf 'PORT=3001\n'
      printf 'MONGODB_URI=mongodb://%s:%s@mongodb:27017/health?authSource=health\n' \
        "$(urlencode "$MONGO_CACHE_USERNAME")" \
        "$(urlencode "$MONGO_CACHE_PASSWORD")"
      printf 'USDA_API_KEY=%s\n' "$USDA_API_KEY"
      printf 'XAI_API_KEY=%s\n' "$XAI_API_KEY"
      printf 'XAI_REASONING_EFFORT=%s\n' "$XAI_REASONING_EFFORT"
      printf 'XAI_ASK_REASONING_EFFORT=%s\n' "$XAI_ASK_REASONING_EFFORT"
      printf 'BIRTH_YEAR=%s\n' "$BIRTH_YEAR"
      printf 'SEX=%s\n' "$SEX"
      printf 'HEIGHT_IN=%s\n' "$HEIGHT_IN"
      printf 'HEIGHT_CM=%s\n' "$HEIGHT_CM"
      printf 'ACTIVITY=%s\n' "$ACTIVITY"
      printf 'OTEL_SERVICE_NAME=taco\n'
      printf 'OTEL_EXPORTER_OTLP_ENDPOINT=http://host.containers.internal:4318\n'
      printf 'OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf\n'
      printf 'OTEL_TRACES_SAMPLER=parentbased_always_on\n'
      # Prompt versions only. Traces go to Alloy, above.
      printf 'MLFLOW_TRACKING_URI=http://mlflow:5000\n'
    } > "$tmp"
    ;;
  cloudflared)
    require CLOUDFLARE_TUNNEL_TOKEN "$CLOUDFLARE_TUNNEL_TOKEN"
    printf 'TUNNEL_TOKEN=%s\n' "$CLOUDFLARE_TUNNEL_TOKEN" > "$tmp"
    ;;
  *)
    echo "unknown mode: $mode" >&2
    exit 1
    ;;
esac
mv "$tmp" "$dest"
