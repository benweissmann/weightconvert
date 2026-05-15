# Deployment

The app deploys to **GitHub Pages** at `convert.fuzzy.codes` on every push to `main`.  
Static data and model files are served from **S3** to keep the Pages bundle small.

## S3 layout

The bucket is `codes.fuzzy.convert`. The current deployed prefix is `dist-v1/`:

```
dist-v1/
  data/
    ingredients.json
    units.json
    aliases.json
  model/
    mlc-chat-config.json
    tokenizer.json
    tokenizer_config.json
    params_shard_0.bin … params_shard_N.bin
    tensor-cache.json
```

Upload data files after re-scraping or updating aliases:
```bash
aws s3 sync data/ s3://codes.fuzzy.convert/dist-v1/data/ \
  --exclude "*" --include "ingredients.json" --include "units.json" --include "aliases.json"
```

Upload model files after re-running conversion (see [FINETUNE.md](FINETUNE.md)):
```bash
aws s3 sync finetune/mlc-model/ s3://codes.fuzzy.convert/dist-v1/model/
```

## S3 CORS configuration

The Pages domain needs cross-origin read access to the bucket.  
In the AWS Console → S3 → `codes.fuzzy.convert` → Permissions → CORS:

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedOrigins": [
      "https://convert.fuzzy.codes",
      "http://localhost:5173"
    ],
    "ExposeHeaders": [],
    "MaxAgeSeconds": 86400
  }
]
```

## GitHub repo configuration

Repo: **github.com/benweissmann/weightconvert**

### 1. Enable GitHub Pages

Settings → Pages → Source: **GitHub Actions**

No branch/folder needed — the workflow handles publishing.

### 2. Set the custom domain

Settings → Pages → Custom domain: `convert.fuzzy.codes`  
Enable **Enforce HTTPS** once the cert provisions.

Add a CNAME record at your DNS provider:
```
convert.fuzzy.codes  CNAME  benweissmann.github.io
```

### 3. Repository variables (Settings → Secrets and variables → Actions → Variables)

| Name | Value |
|---|---|
| `VITE_DATA_BASE_URL` | `https://s3.us-east-1.amazonaws.com/codes.fuzzy.convert/dist-v1` |
| `VITE_MODEL_BASE_URL` | `https://s3.us-east-1.amazonaws.com/codes.fuzzy.convert/dist-v1` |

These are repository **variables** (not secrets) — they're not sensitive.

### 4. Allow Pages deployment in Actions

Settings → Actions → General → Workflow permissions:  
Select **Read and write permissions** (or at minimum allow the `pages: write` permission).

## Deploying a new model version

1. Retrain and convert: `bash finetune/convert_to_mlc.sh`
2. Upload to a new S3 prefix, e.g. `dist-v2/model/`
3. Update `VITE_MODEL_BASE_URL` in repo variables to point at the new prefix
4. Push any change to `main` to trigger a rebuild, or use **workflow_dispatch**

## Local build preview

```bash
pnpm build
pnpm preview
```

The preview server won't serve data/model files from S3 — run `pnpm dev` for local development.
