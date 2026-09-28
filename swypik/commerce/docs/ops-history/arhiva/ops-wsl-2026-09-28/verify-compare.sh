B=$(ls -t /opt/swypik/backups/pre-deploy-*.sql.gz | head -1); echo "backup: $B"
zcat "$B" | awk '/^COPY public.users /{print; f=1; next} f&&/^\\.$/{exit} f' > /tmp/users_copy.txt
head -1 /tmp/users_copy.txt | tr ',' '\n' | grep -n "email_verified_at\|^COPY public.users (id" | head
col=$(head -1 /tmp/users_copy.txt | sed 's/.*(//; s/).*//' | tr ',' '\n' | sed 's/ //g' | grep -n '^email_verified_at$' | cut -d: -f1)
echo "email_verified_at column #$col"
for id in 04cf3bfa-d7a8-49e8-a292-4344bc1005ae 27f1fbe6-e489-482b-8149-42a5b7cf3236 609f4ce7-2dae-45c9-823c-d3aab91a7b8d 00000000-0000-4000-9000-0000000f1c1a 0a31f234-d432-4da6-a27a-6cbe3430c9da df63f884-8f7e-499d-9a59-5ca8d94a05f6 cea23e8e-3d20-49e9-9bb8-7713dfb341b1; do
  v=$(grep "^$id	" /tmp/users_copy.txt | cut -f$col); echo "$id before-deploy email_verified_at=$v"
done
