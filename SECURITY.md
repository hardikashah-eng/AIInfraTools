# Security

Some of these tools act on real infrastructure: gpu-health and fleetops can drain or taint nodes, cap GPU power,
restart services, page people and deploy models. This page says how they are kept safe, and how to report a problem.

## Reporting a vulnerability

Please report it privately through GitHub: **Security → Report a vulnerability** on this repository. Don't open a
public issue. Include the tool, the command, what you expected and what happened. You should hear back within a week.

In scope: anything that lets a tool run a command it shouldn't, act without the approval it should need, leak a token
or a tenant's data through the read API, or run code from imported data.

## How the tools stay safe

- **Dry run by default.** Anything that changes a cluster or pages a person needs `--live` on the command *and*
  `policy.dryRun: false` in the config. Either one missing means nothing runs.
- **A person approves.** Suggested fixes, power caps, admissions and rollout stages wait in an approval queue. The
  skills tell a model it may propose but never approve.
- **Commands are argument lists, not shell.** Executors are argv templates; values filled in from data must match a
  safe pattern (node names, numbers), and nothing is passed through a shell.
- **Allowlists.** Fault injection and game days run only on targets you list.
- **Read API.** The fleetops service uses tokens with roles and tenant scopes; see
  [fleetops/docs/SERVICE.md](fleetops/docs/SERVICE.md).
- **No secrets handled.** Tokens (Hugging Face, PagerDuty and others) are read from Kubernetes Secrets or environment
  variables you create; the tools never print or store them.
- **No dependencies at run time.** Each tool runs on Node.js alone, so there is no package supply chain to trust.

## Supported versions

Fixes go into the latest release and `main`.
