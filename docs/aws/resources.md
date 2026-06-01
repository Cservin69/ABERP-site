# PR-G — AWS Phase 1 resources

Bootstrap session 2026-06-01. Provisions the static-surface layer for
friboard.com (S3 + CloudFront + OIDC + Route 53). Phase 5 (Lightsail/SSR for
`/quote`) is deferred. Roles and CloudFront alias claims are split into two
parts: what this session created with `friboard-operator`, and what Ervin must
run with elevated perms ("Fixup pass" below).

## 1. Resources provisioned

| Resource                | Identifier / ARN                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| AWS account             | `499579792018`                                                                                |
| Primary region          | `eu-central-1`                                                                                |
| GitHub OIDC provider    | `arn:aws:iam::499579792018:oidc-provider/token.actions.githubusercontent.com`                 |
| S3 static bucket        | `friboard-static-499579792018` (eu-central-1, BPA all-on, versioning on, SSE-S3 AWS default)  |
| CloudFront OAC          | `E6120TF7OFMWK` (name `friboard-static-oac`, sigv4 / always, type `s3`)                       |
| CloudFront distribution | `E1VSUFKSGDSVFI` — `d1dvryarslcf0d.cloudfront.net` (no aliases yet — see Fixup §3.2)          |
| CloudFront dist ARN     | `arn:aws:cloudfront::499579792018:distribution/E1VSUFKSGDSVFI`                                |
| S3 bucket policy        | Attached: CloudFront service principal, `s3:GetObject`, SourceArn pinned to `E1VSUFKSGDSVFI`  |
| Placeholder content     | `s3://friboard-static-499579792018/index.html` (849 B "provisioning" landing)                 |
| ACM cert (us-east-1)    | `arn:aws:acm:us-east-1:499579792018:certificate/babaa745-3919-4000-aff5-7b716e97a656` — ISSUED |
| Route 53 hosted zone    | `Z07478311YU5K6F60V9V6` (`friboard.com.`)                                                     |

## 2. GitHub repo Variables (paste block)

`Cservin69/ABERP-site` → Settings → Secrets and variables → Actions →
**Variables** tab. Set all four (the deploy-dynamic job is guarded to skip when
`ABERP_SITE_LS_INSTANCE` is empty — see `.github/workflows/deploy.yml`):

| Variable                 | Value                                                              |
| ------------------------ | ------------------------------------------------------------------ |
| `AWS_DEPLOY_ROLE_ARN`    | `arn:aws:iam::499579792018:role/aberp-site-github-deploy`          |
| `ABERP_SITE_BUCKET`      | `friboard-static-499579792018`                                     |
| `ABERP_SITE_CF_DIST`     | `E1VSUFKSGDSVFI`                                                   |
| `ABERP_SITE_LS_INSTANCE` | _(leave UNSET until Phase 5; the workflow skips deploy-dynamic)_   |

## 3. Fixup pass — Ervin to run with elevated perms

The `friboard-operator` IAM user is scoped tightly enough that three things in
the original plan came back AccessDenied. None of them are blocking *for the
static stack to be wired up*, but the first two **must** be done before the
first `git push` to `main` actually deploys. The third is needed before
friboard.com itself works (until then, `d1dvryarslcf0d.cloudfront.net` serves
the placeholder fine, but the apex/www DNS still point at the foreign stale
distribution).

Run these with an account that has admin IAM + CloudFront permissions (or
temporarily widen the operator policy — see §6).

### 3.1 — Create the deploy role + inline policy

Trust policy and inline permissions JSON are checked in below (§4 + §5). Save
them locally as `trust-policy.json` and `deploy-policy.json`, then:

```sh
aws iam create-role \
  --role-name aberp-site-github-deploy \
  --description "GitHub Actions OIDC deploy role for Cservin69/ABERP-site" \
  --max-session-duration 3600 \
  --assume-role-policy-document file://trust-policy.json

aws iam put-role-policy \
  --role-name aberp-site-github-deploy \
  --policy-name aberp-site-github-deploy \
  --policy-document file://deploy-policy.json

aws iam get-role --role-name aberp-site-github-deploy \
  --query 'Role.Arn' --output text
# expect: arn:aws:iam::499579792018:role/aberp-site-github-deploy
```

### 3.2 — Claim friboard.com + www aliases (cross-account move)

The aliases are currently associated with a foreign distribution
(`dw5jaam6rql3b.cloudfront.net`, not in account 499579792018; possibly the old
sauna site's CF distribution that was never released). Our ACM cert in
us-east-1 covers both names, so AWS's `AssociateAlias` cross-account move path
is the right one — it's specifically designed for this case (target account
holds a valid ACM cert for the alias).

```sh
aws cloudfront associate-alias \
  --target-distribution-id E1VSUFKSGDSVFI \
  --alias friboard.com

aws cloudfront associate-alias \
  --target-distribution-id E1VSUFKSGDSVFI \
  --alias www.friboard.com

aws cloudfront get-distribution --id E1VSUFKSGDSVFI \
  --query 'Distribution.DistributionConfig.Aliases.Items' --output json
# expect: ["friboard.com","www.friboard.com"]
```

If AssociateAlias is rejected (the AWS docs note an edge case where the source
distribution's cert is required if the source account still exists and is
active — typically not an issue if the old sauna account is dormant), open a
support case referencing the friboard.com ownership: ACM cert + Route 53 zone
in the destination account are both valid evidence.

### 3.3 — Cut Route 53 over to our distribution (only AFTER §3.2 succeeds)

```sh
cat >/tmp/r53-cutover.json <<'JSON'
{
  "Comment": "PR-G — cut friboard.com + www apex to new CloudFront E1VSUFKSGDSVFI",
  "Changes": [
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "friboard.com.",
        "Type": "A",
        "AliasTarget": {
          "HostedZoneId": "Z2FDTNDATAQYW2",
          "DNSName": "d1dvryarslcf0d.cloudfront.net.",
          "EvaluateTargetHealth": false
        }
      }
    },
    {
      "Action": "DELETE",
      "ResourceRecordSet": {
        "Name": "www.friboard.com.",
        "Type": "CNAME",
        "TTL": 300,
        "ResourceRecords": [
          {"Value": "_be12ebc293724676702da4070f5039bc.www.friboard.com."}
        ]
      }
    },
    {
      "Action": "CREATE",
      "ResourceRecordSet": {
        "Name": "www.friboard.com.",
        "Type": "A",
        "AliasTarget": {
          "HostedZoneId": "Z2FDTNDATAQYW2",
          "DNSName": "d1dvryarslcf0d.cloudfront.net.",
          "EvaluateTargetHealth": false
        }
      }
    }
  ]
}
JSON

aws route53 change-resource-record-sets \
  --hosted-zone-id Z07478311YU5K6F60V9V6 \
  --change-batch file:///tmp/r53-cutover.json

# Watch propagation (R53 itself is ~60s, browser-side resolvers up to ~5min):
dig +short friboard.com A
dig +short www.friboard.com A
# expect: CloudFront IPs (multiple A records from cloudfront.net edge).
```

`Z2FDTNDATAQYW2` is the universal hosted-zone-id constant for CloudFront
alias targets — same for every CF distribution in every region. Leave
`usermeta.friboard.com.` and the `_*.friboard.com.` ACM validation records
**untouched**.

## 4. Trust policy (for review)

Matches PR-F's tightening verbatim (StringEquals on both `aud` and `sub`,
`sub` as an array, no wildcard). The `refs/heads/main` value covers the `build`
job (no environment, OIDC sub is `repo:…:ref:refs/heads/main`); the
`environment:production` value covers `deploy-static` and `deploy-dynamic`
(which run under `environment: production` and pause for Ervin's required-
reviewer approval before AWS creds are minted).

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::499579792018:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": [
            "repo:Cservin69/ABERP-site:ref:refs/heads/main",
            "repo:Cservin69/ABERP-site:environment:production"
          ]
        }
      }
    }
  ]
}
```

## 5. Permissions policy (for review)

S3 RW pinned to the bucket; CloudFront invalidate pinned to the distribution;
SSM SendCommand wildcarded for Phase 5 (the precise instance ARN isn't known
yet — tighten the SSM Resource stanza once `mi-…` is registered, per
`operator-checklist.md` Step 6). `sts:GetCallerIdentity` is allowed so the
workflow can self-check identity if needed.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "S3SyncStaticAndStageRelease",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:PutObjectAcl",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::friboard-static-499579792018",
        "arn:aws:s3:::friboard-static-499579792018/*"
      ]
    },
    {
      "Sid": "CloudFrontInvalidate",
      "Effect": "Allow",
      "Action": "cloudfront:CreateInvalidation",
      "Resource": "arn:aws:cloudfront::499579792018:distribution/E1VSUFKSGDSVFI"
    },
    {
      "Sid": "SSMDeployToLightsailPhase5",
      "Effect": "Allow",
      "Action": [
        "ssm:SendCommand",
        "ssm:ListCommandInvocations",
        "ssm:GetCommandInvocation"
      ],
      "Resource": [
        "arn:aws:ec2:eu-central-1:499579792018:instance/*",
        "arn:aws:ssm:eu-central-1:499579792018:managed-instance/*",
        "arn:aws:ssm:eu-central-1::document/AWS-RunShellScript"
      ]
    },
    {
      "Sid": "STSSelfCheck",
      "Effect": "Allow",
      "Action": "sts:GetCallerIdentity",
      "Resource": "*"
    }
  ]
}
```

## 6. friboard-operator IAM policy gaps (informational)

Actions that came back AccessDenied this session, listed so the operator policy
can be widened in a single pass if you'd rather not run §3 with separate creds:

- `iam:CreateRole`, `iam:PutRolePolicy`, `iam:GetRole`, `iam:ListRoles` — needed for §3.1
- `iam:ListOpenIDConnectProviders` — informational only (CreateOIDC already worked)
- `cloudfront:AssociateAlias` — needed for §3.2
- `s3:PutBucketEncryption`, `s3:GetEncryptionConfiguration` — not needed
  (AWS auto-enables SSE-S3 on all new buckets since Jan 2023), but the
  inability to verify is mildly annoying

If you do widen, scope `iam:*Role*` to `arn:aws:iam::499579792018:role/aberp-site-*`
and `cloudfront:AssociateAlias` to the specific distribution ARN.

## 7. Validation (pre-cutover)

CloudFront distribution should serve the placeholder via `*.cloudfront.net`
once Status flips from InProgress to Deployed (~5–15 min after creation at
`2026-06-01T16:55Z`):

```sh
aws cloudfront get-distribution --id E1VSUFKSGDSVFI \
  --query 'Distribution.Status' --output text
# expect: Deployed

curl -sS -o /dev/null -w "%{http_code}\n" https://d1dvryarslcf0d.cloudfront.net/
# expect: 200

curl -sS https://d1dvryarslcf0d.cloudfront.net/ | head -c 200
# expect: HTML starting with "<!DOCTYPE html>" and "friboard.com — provisioning"
```

## 8. Out of scope (intentional)

- Old `friboard.com` S3 bucket (eu-central-1) still holds the legacy Angular
  sauna-site content (~6 MB; BPA all-on so unreachable). Left intact — orphan
  cleanup is a separate task. **Do not** point any DNS at it.
- WAF in front of CloudFront — deferred per dispatch.
- CloudFront access logs — deferred (cheap to add later; can be turned on
  with `aws cloudfront update-distribution` modifying `Logging.Enabled=true`).
- Phase 5 (Lightsail/SSR) — see `operator-checklist.md` Steps 5–8.
