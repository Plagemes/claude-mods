# cloud-cost-warn
> Warns before commands that create expensive cloud resources like GPU instances or large databases.

**Category:** DevOps & Cloud · **Version:** 1.0.0

## What it does
Before Claude runs a Bash command, cloud-cost-warn checks it for AWS, Google Cloud and Azure commands that create costly resources: EC2 instances of GPU, memory-optimised, `.metal` or very large types, big RDS databases, GPU virtual machines, and Kubernetes clusters (`eksctl`, `aws eks`, `gcloud container clusters`, `az aks`). The command is refused with a rough hourly and monthly price. The user can approve it by typing `COST-OK`.

## Install
```
/plugin install cloud-cost-warn --marketplace plagemes/claude-mods
```

## Usage
Nothing to run. A refused command comes back to Claude as:

```
cloud-cost-warn: "aws ec2 run-instances --instance-type p3.2xlarge --image-id ami-1" would create an
EC2 instance (p3.2xlarge), roughly $2.60-$3.67 per hour (about $1,899-$2,681 a month) until it is
deleted. Cheaper: a smaller instance type, a spot instance, or a local GPU/dev box for experiments.
Blocked until the user's latest message contains COST-OK. Ask them to confirm and add it, and delete
the resource when done.
```

Put `COST-OK` in your next message to allow it. It applies to that message only. `COST-OK` that arrives from a notification or another plugin does not count. Small instances, `--dry-run`, `describe`/`list` commands and `terraform` are not affected.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `largeSize` | string | `8xlarge` | Size from which EC2, RDS and GCP machines count as expensive (`8xlarge` = 32 vCPUs). GPU, `.metal` and memory-optimised types are always flagged. |

## How it works
- A `tool.call` guard on `Bash` splits the command line like a shell (so `echo "aws ec2 run-instances ..."` is ignored), recognises the cloud command and reads its type, size, count and GPU flags, and prices them from a small embedded table of list prices (us regions, on demand, Linux). A `prompt.submit` hook remembers the latest message from the person.
- It fails closed: if the check itself throws, a cloud create command is refused.
- Limits: the prices are rough and some may be out of date (expect +-30%, more for committed or regional pricing). It cannot see inside `terraform`, CloudFormation or a `--cli-input-json` file, so those pass.
