E=/opt/swypik/app/infra/hetzner/.env.production
for k in DATABASE_URL CRON_SECRET GEMINI_API_KEY YOUTUBE_API_KEY TMDB_API_KEY STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY STREAM_SECRET MEDIA_STREAM_SECRET LIVEKIT_API_KEY LIVEKIT_URL NEXT_PUBLIC_LIVEKIT_URL ADMIN_SECRET FEATURE_MOVIES FEATURE_MUSIC FEATURE_NEWS FEATURE_GAMING FEATURE_MESSENGER FEATURE_MYSTERY_DROP FEATURE_CRYPTO; do
  line=$(grep -E "^$k=" $E | tail -1)
  if [ -z "$line" ]; then echo "absent $k"; elif [ -z "${line#*=}" ]; then echo "empty  $k"; else echo "set    $k"; fi
done
echo "--- crypto/SWYP-looking keys (names):"; grep -oE '^[A-Z0-9_]+' $E | grep -iE 'SWYP|CHAIN|TREASURY|_PK|RPC|COINGECKO|MYSTERY|_UNITS' || echo none
echo "--- total keys: $(grep -cE '^[A-Z0-9_]+=' $E)"
