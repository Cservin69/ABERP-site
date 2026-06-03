# IAM deploy role for GitHub Actions (OIDC)

The GitHub Actions workflow at `.github/workflows/deploy.yml` assumes a single IAM
role via OIDC — no long-lived access keys. This document is the operator recipe
for creating that role.

## Prereqs

You need (substitute throughout):

| Placeholder       | Where it comes from                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `ACCOUNT_ID`      | AWS account number (`aws sts get-caller-identity --query Account`)                              |
| `BUCKET_STATIC`   | The S3 bucket that holds abenerp.com's static surface AND the `_deploy/` staging prefix         |
| `DISTRIBUTION_ID` | The CloudFront distribution ID serving abenerp.com                                              |
| `INSTANCE_ID`     | The SSM-registered instance ID for the Lightsail box (starts with `mi-` for hybrid activations) |

GitHub repo: `Cservin69/ABERP-site` (replace if your fork is elsewhere).

## Step 1 — Register the GitHub OIDC provider (one-time per AWS account)

If your account does not yet have the GitHub Actions OIDC provider, create it.
This is a one-time step shared across every repo that deploys to this account.

```sh
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
```

The thumbprint is GitHub's current OIDC thumbprint as documented by AWS; if
GitHub rotates it, AWS still validates because they verify the JWT signature
against GitHub's JWKS, not the thumbprint alone. Console equivalent: IAM →
Identity providers → Add provider → OpenID Connect, URL
`https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`.

## Step 2 — Create the deploy role

### Trust policy

Save to `trust-policy.json`. Both `aud` and `sub` use `StringEquals` so the role
is assumable **only** from workflow runs on `main` or in the `production`
environment of `Cservin69/ABERP-site` — not from PR branches, forks, tags, or
unrelated repos.

```json
{
	"Version": "2012-10-17",
	"Statement": [
		{
			"Effect": "Allow",
			"Principal": {
				"Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
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

Why both `sub` values:

- `…:ref:refs/heads/main` covers the `build` job in `deploy.yml`, which runs
  without a GitHub environment.
- `…:environment:production` covers the `deploy-static` and `deploy-dynamic`
  jobs, which run under the `production` environment (configured with required
  reviewer = Ervin). Even an attacker who pushed straight to `main` would still
  block at the human-approval gate before AWS credentials are issued.

If you ever need to debug a workflow run from a non-main branch (e.g. testing
trust-policy changes), temporarily add
`repo:Cservin69/ABERP-site:ref:refs/heads/<your-branch>` to the array and remove
it once the test is done. Never expand to `repo:Cservin69/ABERP-site:*` — that
re-opens the role to any PR branch.

### Permissions policy

Save to `deploy-policy.json`. Least-privilege: the three actions the workflow
actually performs — S3 sync, CloudFront invalidate, SSM send-command.

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
			"Resource": ["arn:aws:s3:::BUCKET_STATIC", "arn:aws:s3:::BUCKET_STATIC/*"]
		},
		{
			"Sid": "CloudFrontInvalidate",
			"Effect": "Allow",
			"Action": "cloudfront:CreateInvalidation",
			"Resource": "arn:aws:cloudfront::ACCOUNT_ID:distribution/DISTRIBUTION_ID"
		},
		{
			"Sid": "SSMDeployToLightsail",
			"Effect": "Allow",
			"Action": ["ssm:SendCommand", "ssm:ListCommandInvocations", "ssm:GetCommandInvocation"],
			"Resource": [
				"arn:aws:ec2:eu-central-1:ACCOUNT_ID:instance/INSTANCE_ID",
				"arn:aws:ssm:eu-central-1:ACCOUNT_ID:managed-instance/INSTANCE_ID",
				"arn:aws:ssm:eu-central-1::document/AWS-RunShellScript"
			]
		}
	]
}
```

Note: hybrid-registered Lightsail instances use the
`arn:aws:ssm:<region>:<account>:managed-instance/mi-…` ARN form, not the EC2
`instance/i-…` form. The policy above grants both so the role works regardless
of which path you ended up with.

### Create

```sh
aws iam create-role \
  --role-name aberp-site-github-deploy \
  --assume-role-policy-document file://trust-policy.json

aws iam put-role-policy \
  --role-name aberp-site-github-deploy \
  --policy-name aberp-site-github-deploy \
  --policy-document file://deploy-policy.json

aws iam get-role --role-name aberp-site-github-deploy \
  --query 'Role.Arn' --output text
# → arn:aws:iam::ACCOUNT_ID:role/aberp-site-github-deploy
```

Save the ARN — it goes into the GitHub repo variable `AWS_DEPLOY_ROLE_ARN`.

## Step 3 — GitHub repo variables

`Cservin69/ABERP-site` → Settings → Secrets and variables → Actions →
**Variables** tab (not Secrets — these are non-sensitive identifiers):

| Variable                 | Value                                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `AWS_DEPLOY_ROLE_ARN`    | The ARN from Step 2                                                                                 |
| `ABERP_SITE_BUCKET`      | Your S3 bucket name                                                                                 |
| `ABERP_SITE_CF_DIST`     | Your CloudFront distribution ID                                                                     |
| `ABERP_SITE_LS_INSTANCE` | SSM-registered Lightsail instance ID (`mi-…` for hybrid; set after Step 6 of operator-checklist.md) |

Sensitive operational secrets (`ABERP_SITE_ADMIN_TOKEN`,
`CLOUDFRONT_SHARED_SECRET`) **never** live in the GH variable set; they live on
the Lightsail instance in `/etc/aberp-site.env` only.

## Verify

After the role and variables are set, in the GitHub Actions UI run the workflow
manually (workflow_dispatch). The `build` job runs unconditionally; the
`deploy-static` and `deploy-dynamic` jobs need the AWS variables to be present
or `configure-aws-credentials` fails fast with a clear error.
