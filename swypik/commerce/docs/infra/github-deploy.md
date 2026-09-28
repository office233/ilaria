# Deploy din GitHub (fără chei pe calculatoare)

Din 28.09.2026 nimic Swypik nu mai stă pe discul local al owner-ului:

- **Secrete** → Azure Key Vault `kv-swypik-prod` (rg-swypik-prod, RBAC, purge protection).
  Conține env-urile de producție (`prod-web-swypik-env`, `prod-web-hosts-env`), copiile ops din
  25.09 (`ops-env-*`), cheile SSH (`ssh-*`) și `known_hosts`. Citire:
  `az keyvault secret show --vault-name kv-swypik-prod -n <nume> --query value -o tsv`.
  `prod-data-data-env` / `prod-data-backup-env` au tag `status=EMPTY-to-fill` — de completat
  cu `/opt/swypik/env/{data,backup}.env` de pe nodul data.
- **Deploy** → GitHub Actions `Deploy production` (`.github/workflows/deploy.yml`), pornit manual,
  cu aprobare în environment-ul `production`.
- **Documente owner / istoric ops** → `docs/owner/`, `docs/ops-history/`.

## Setup o singură dată (owner)

Azure (Cloud Shell sau `az` local), în subscripția Swypik:

```bash
RG=rg-swypik-prod
az identity create -n id-swypik-gh-deploy -g $RG -l swedencentral
CLIENT_ID=$(az identity show -n id-swypik-gh-deploy -g $RG --query clientId -o tsv)
PRINCIPAL=$(az identity show -n id-swypik-gh-deploy -g $RG --query principalId -o tsv)
az identity federated-credential create -g $RG --identity-name id-swypik-gh-deploy -n github-production \
  --issuer https://token.actions.githubusercontent.com \
  --subject repo:office233/swypik-commerce-platform:environment:production \
  --audiences api://AzureADTokenExchange
# Singurul drept: Run Command pe web-1 (nu pe restul VM-urilor, nu pe Key Vault).
az role assignment create --assignee-object-id $PRINCIPAL --assignee-principal-type ServicePrincipal \
  --role "Virtual Machine Contributor" \
  --scope $(az vm show -g $RG -n swypik-prod-web-1 --query id -o tsv)
echo "AZURE_CLIENT_ID=$CLIENT_ID"
```

GitHub → repo → Settings:

1. **Environments → New environment `production`** → Required reviewers: owner-ul
   (fiecare deploy cere un click de aprobare).
2. **Secrets and variables → Actions → Variables** (nu sunt secrete):
   `AZURE_CLIENT_ID` (din comanda de mai sus), `AZURE_TENANT_ID=06db8b45-d2c9-49f1-b0ba-71686536c45c`,
   `AZURE_SUBSCRIPTION_ID=049dec61-3ee7-4af6-af09-29e7047fb0b9`.

## Folosire

Actions → **Deploy production** → Run workflow (opțional `services`, `max_migrations`, `flags`)
→ aprobare → rulează `infra/azure/deploy.sh` pe web-1 exact pe commitul ales. Logul complet:
`/opt/swypik/logs/deploy-gh-<run_id>.log` pe web-1. Run Command are limită de 90 min;
un deploy complet durează ~25 min.
