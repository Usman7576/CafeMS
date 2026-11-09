# Security policy

## Reporting a vulnerability

Please report it privately, not in a public issue: open the repository's **Security** tab and choose **Report a vulnerability**. Include the steps to reproduce it and what an attacker could gain.

You will get a reply within 3 working days. Please allow up to 30 days for a fix before publishing details. Testing is welcome on your own local copy; do not test against a live cafe's site or its data.

## Supported versions

Only the latest release and the `main` branch receive security fixes.

## How this project is protected

| Area | Where to look |
| --- | --- |
| Requirements and their tests | [SECURITY-REQUIREMENTS.md](docs/security/SECURITY-REQUIREMENTS.md), [TRACEABILITY.md](docs/security/TRACEABILITY.md) |
| Threat model | [THREAT-MODEL.md](docs/security/THREAT-MODEL.md) |
| Risk scores and failure analysis | [RISK-AND-FAILURE-ANALYSIS.md](docs/security/RISK-AND-FAILURE-ANALYSIS.md) |
| Scanner results | [SCAN-RESULTS.md](docs/security/SCAN-RESULTS.md) |
| Load test | [LOAD-TEST.md](docs/security/LOAD-TEST.md) |
| Secure deployment | [DEPLOYMENT.md](docs/DEPLOYMENT.md) |

## Verifying a release

Each release publishes a `SHA256SUMS` file. After downloading, run this in the same folder:

```bash
sha256sum -c SHA256SUMS
```

Each release also has a signed attestation that this repository's workflow built it:

```bash
gh attestation verify cafems-v1.0.0.tar.gz --repo Usman7576/CafeMS
```
